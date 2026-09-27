// Sparse-cache response assembler.
//
// The client holds a sparse byte cache of the resource (fragments carrying a
// start offset and base64 data) and asks for a Range response. The shared
// planner decides which intervals an origin would select; this module then
// verifies the cache agrees with itself (overlapping fragments must carry
// identical bytes), checks the selected intervals are fully covered, and
// assembles the exact wire body the origin would send: the single segment
// itself, or a canonical multipart/byteranges message (CRLF framing, no
// preamble/epilogue, the planner's deterministic boundary).

import { planRanges } from './planner.js';

export const MAX_FRAGMENTS = 1024;
// Headroom above the 1 MiB decoded-cache rule, mirroring /multipart-check.
export const MAX_FRAGMENT_BASE64_LENGTH = 1_400_000;
// The submitted cache (decoded) and the assembled wire body are each capped
// at 1 MiB.
export const MAX_CACHE_BYTES = 1024 * 1024;
export const MAX_ASSEMBLED_BYTES = 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CRLF = '\r\n';

/**
 * Assemble a byte-range response body from a sparse fragment cache.
 *
 * @returns a result object: the planner's 206 result extended with
 *          `bodyBytes`/`bodyBase64` on success; a 400 result for invalid
 *          fragments; the planner's 400/416/422 result when the range itself
 *          fails; a 422 result when the assembled body would exceed 1 MiB;
 *          a 409 result with `conflicts` when overlapping fragments disagree,
 *          or with `missing` when the cache leaves holes in the selected
 *          intervals.
 */
export function assembleResponse(options) {
  const { size, contentType, rangeHeader, fragments, maxSegments, transferSizeRatio } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Array.isArray(fragments)) {
    return fail(400, 'INVALID_FRAGMENTS', 'fragments must be an array of {start, dataBase64} objects');
  }

  // Fragment boundaries and base64 first: every fragment must decode to at
  // least one byte and lie fully inside the resource.
  const decoded = [];
  let cachedBytes = 0;
  for (let i = 0; i < fragments.length; i += 1) {
    const fragment = fragments[i];
    if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
      return fail(400, 'INVALID_FRAGMENT', `fragments[${i}] must be an object with start and dataBase64`);
    }
    const { start, dataBase64 } = fragment;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail(400, 'INVALID_FRAGMENT_START', `fragments[${i}].start must be a non-negative safe integer`);
    }
    const data = decodeBase64(dataBase64);
    if (data === null) {
      return fail(
        400,
        'INVALID_FRAGMENT_BASE64',
        `fragments[${i}].dataBase64 must be a non-empty, canonically padded standard base64 string`,
      );
    }
    const end = start + data.length - 1;
    if (end >= size) {
      return fail(
        400,
        'FRAGMENT_OUT_OF_BOUNDS',
        `fragments[${i}] spans bytes ${start}-${end}, outside the ${size}-byte resource`,
      );
    }
    cachedBytes += data.length;
    if (cachedBytes > MAX_CACHE_BYTES) {
      return fail(
        400,
        'FRAGMENTS_TOO_LARGE',
        `fragments decode to more than ${MAX_CACHE_BYTES} bytes (1 MiB) in total`,
      );
    }
    decoded.push({ start, end, data });
  }

  // Range parsing, endpoint clamping, interval merging and the segment /
  // transfer-size guards are exactly the planner's rules.
  const plan = planRanges({ size, contentType, rangeHeader, maxSegments, transferSizeRatio });
  if (plan.statusCode !== 206) return plan;

  if (plan.bytes.total > MAX_ASSEMBLED_BYTES) {
    return {
      statusCode: 422,
      decision: 'partial',
      code: 'ASSEMBLED_BODY_TOO_LARGE',
      error: 'Unprocessable Entity',
      message:
        `assembled body of ${plan.bytes.total} bytes exceeds ` +
        `the ${MAX_ASSEMBLED_BYTES}-byte (1 MiB) output limit`,
      resource: plan.resource,
      segmentsCount: plan.segmentsCount,
      selectedBytes: plan.bytes.selected,
      framingBytes: plan.bytes.framing,
      transferBytes: plan.bytes.total,
      limitBytes: MAX_ASSEMBLED_BYTES,
    };
  }

  // Overlapping fragments must carry identical bytes; the sweep simultaneously
  // merges the cache into the contiguous intervals later reads draw from.
  const { cache, conflicts } = buildCache(decoded);
  if (conflicts.length > 0) {
    return fail(
      409,
      'FRAGMENT_CONFLICT',
      `overlapping fragments carry different bytes at ${conflicts.length} interval(s)`,
      { conflicts },
    );
  }

  const missing = subtractIntervals(mergeIntervals(plan.segments), cache);
  if (missing.length > 0) {
    return fail(
      409,
      'FRAGMENT_COVERAGE_INCOMPLETE',
      `fragments leave ${missing.length} gap(s) in the selected ranges`,
      { missing },
    );
  }

  const body =
    plan.multipart === null
      ? readRange(cache, plan.segments[0].start, plan.segments[0].end)
      : buildMultipartBody(plan, cache);

  return {
    ...plan,
    responseHeaders: {
      ...plan.responseHeaders,
      // Content-Length is the decoded body length; by construction this is
      // identical to the planner's byte accounting.
      'Content-Length': String(body.length),
    },
    bodyBytes: body.length,
    bodyBase64: body.toString('base64'),
  };
}

/**
 * Merge the decoded fragments into contiguous cache intervals. Overlapping
 * regions are compared byte by byte against the bytes already merged; every
 * position where two fragments disagree is recorded so the caller can report
 * all conflicts at once (merged, ascending).
 */
function buildCache(fragments) {
  const sorted = [...fragments].sort((a, b) => a.start - b.start || a.end - b.end);
  const cache = [];
  const conflicts = [];

  for (const fragment of sorted) {
    const last = cache[cache.length - 1];
    if (last === undefined || fragment.start > last.end + 1) {
      cache.push({ start: fragment.start, end: fragment.end, data: fragment.data });
      continue;
    }
    if (fragment.start <= last.end) {
      recordConflicts(last, fragment, conflicts);
    }
    if (fragment.end > last.end) {
      const tailStart = last.end + 1 - fragment.start;
      last.data = Buffer.concat([last.data, fragment.data.subarray(tailStart)]);
      last.end = fragment.end;
    }
  }

  return { cache, conflicts: mergeIntervals(conflicts) };
}

/**
 * Compare the overlapping region of `fragment` against the cache interval
 * byte by byte and record each maximal run of disagreeing positions.
 */
function recordConflicts(interval, fragment, conflicts) {
  const overlapEnd = Math.min(interval.end, fragment.end);
  const length = overlapEnd - fragment.start + 1;
  const offset = fragment.start - interval.start;
  let i = 0;
  while (i < length) {
    if (interval.data[offset + i] !== fragment.data[i]) {
      const runStart = i;
      do {
        i += 1;
      } while (i < length && interval.data[offset + i] !== fragment.data[i]);
      conflicts.push({ start: fragment.start + runStart, end: fragment.start + i - 1 });
    } else {
      i += 1;
    }
  }
}

/**
 * Read [start, end] from the merged cache. Coverage is verified beforehand,
 * so every byte is present; a read may span several fragments.
 */
function readRange(cache, start, end) {
  const parts = [];
  let length = 0;
  for (const interval of cache) {
    if (interval.end < start) continue;
    if (interval.start > end) break;
    const from = Math.max(start, interval.start);
    const to = Math.min(end, interval.end);
    const slice = interval.data.subarray(from - interval.start, to - interval.start + 1);
    parts.push(slice);
    length += slice.length;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
}

/**
 * Emit the canonical wire message in plan order: "--boundary" CRLF
 * part-headers data CRLF per segment, then "--boundary--" CRLF. No preamble,
 * no epilogue — the exact shape /multipart-check verifies.
 */
function buildMultipartBody(plan, cache) {
  const boundary = plan.multipart.boundary;
  const delimiter = Buffer.from(`--${boundary}${CRLF}`, 'latin1');
  const closing = Buffer.from(`--${boundary}--${CRLF}`, 'latin1');
  const separator = Buffer.from(CRLF, 'latin1');

  const parts = [];
  let length = closing.length;
  for (const segment of plan.segments) {
    const headerBlock = Buffer.from(segment.partHeaderBlock, 'latin1');
    const data = readRange(cache, segment.start, segment.end);
    parts.push(delimiter, headerBlock, data, separator);
    length += delimiter.length + headerBlock.length + data.length + separator.length;
  }
  parts.push(closing);
  return Buffer.concat(parts, length);
}

/**
 * Sort closed intervals by start offset and merge overlapping or adjacent
 * ones ([0-9] and [10-19] merge into [0-19]).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * Set difference `minuend - subtrahend` of two merged, ascending interval
 * lists; result is merged and ascending.
 */
function subtractIntervals(minuend, subtrahend) {
  const result = [];
  let j = 0;
  for (const interval of minuend) {
    while (j < subtrahend.length && subtrahend[j].end < interval.start) j += 1;
    let cursor = interval.start;
    for (let k = j; k < subtrahend.length && subtrahend[k].start <= interval.end; k += 1) {
      if (subtrahend[k].end < cursor) continue;
      if (subtrahend[k].start > cursor) {
        result.push({ start: cursor, end: subtrahend[k].start - 1 });
      }
      cursor = Math.max(cursor, subtrahend[k].end + 1);
      if (cursor > interval.end) break;
    }
    if (cursor <= interval.end) result.push({ start: cursor, end: interval.end });
  }
  return result;
}

/**
 * Decode strictly canonical standard-alphabet base64. Returns null for empty
 * input, illegal characters, missing/extra padding or any non-canonical
 * quantum (round-tripping through Node's lenient decoder detects the rest).
 */
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_RE.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== value) return null;
  return buffer;
}

function fail(statusCode, code, message, extra) {
  const errors = { 400: 'Bad Request', 409: 'Conflict', 422: 'Unprocessable Entity' };
  return { statusCode, code, error: errors[statusCode], message, ...extra };
}
