// Sparse-cache range response assembler.
//
// The client holds a sparse local cache of a resource — byte fragments left
// over from an interrupted download — and asks: "if I sent this Range header,
// what would the origin's response look like, rebuilt purely from my cache?"
// The selected ranges are planned with the exact /plan rules (parsing,
// clamping, merging, segment/transfer guards).  The fragments are then
// validated (bounds + canonical base64), checked for byte-level conflicts
// where they overlap, and checked for full coverage of the selected ranges.
// Only when the cache provably covers every selected byte is the raw response
// body — a single byte sequence or a canonical multipart/byteranges message —
// assembled in plan order (a plan segment may span several cached fragments)
// and returned base64-encoded, together with the status code and the response
// headers an origin would send; Content-Length always equals the decoded body
// length.
//
// Limits: the fragments together may carry at most 1 MiB of decoded data and
// the assembled response body may not exceed 1 MiB either.

import {
  planRanges,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_TRANSFER_SIZE_RATIO,
} from './planner.js';

export const MAX_FRAGMENTS = 1024;
export const MAX_CACHE_BYTES = 1024 * 1024; // 1 MiB total decoded input
export const MAX_ASSEMBLED_BYTES = 1024 * 1024; // 1 MiB decoded output
// Headroom above the 1 MiB decoded-input rule, mirroring /multipart-check;
// the semantic FRAGMENTS_TOO_LARGE check enforces the real limit.
export const MAX_FRAGMENT_BASE64_LENGTH = 1_400_000;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CRLF_BUFFER = Buffer.from('\r\n', 'latin1');

/**
 * Assemble a byte-range response from sparse cached fragments.
 *
 * @returns a result object whose `statusCode` is the status the origin would
 *          send: 206 carrying the assembled body (single range or
 *          multipart/byteranges) as `bodyBase64`, or a /plan passthrough
 *          400/416/422 outcome.  A 409 result means the cache itself is
 *          unusable: FRAGMENT_CONFLICT (overlapping fragments disagree on
 *          bytes; `conflicts` lists the differing intervals) or
 *          INCOMPLETE_COVERAGE (`missing` lists the selected intervals no
 *          fragment covers).  A 400 result means a fragment — or the request
 *          itself — is invalid.
 */
export function assembleResponse(options) {
  const {
    size,
    rangeHeader,
    fragments,
    contentType = DEFAULT_CONTENT_TYPE,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    transferSizeRatio = DEFAULT_TRANSFER_SIZE_RATIO,
  } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType) || contentType.length === 0) {
    return fail(400, 'INVALID_CONTENT_TYPE', 'contentType must be a single header-safe string');
  }

  const decoded = decodeFragments(fragments, size);
  if (decoded.error) return decoded.error;

  const plan = planRanges({ size, contentType, rangeHeader, maxSegments, transferSizeRatio });
  // Plan-level outcomes (malformed/unsatisfiable range, segment and transfer
  // guards) need no cache at all; pass them through untouched.
  if (plan.statusCode !== 206) return plan;

  const cache = buildCache(decoded.fragments);
  if (cache.conflicts.length > 0) {
    return {
      ...fail(
        409,
        'FRAGMENT_CONFLICT',
        `overlapping fragments carry different bytes in ${cache.conflicts.length} ` +
          `interval${cache.conflicts.length === 1 ? '' : 's'}`,
      ),
      conflicts: cache.conflicts,
    };
  }

  const missing = subtractIntervals(
    mergeIntervals(plan.segments.map((segment) => ({ start: segment.start, end: segment.end }))),
    cache.intervals,
  );
  if (missing.length > 0) {
    return {
      ...fail(
        409,
        'INCOMPLETE_COVERAGE',
        `cached fragments leave ${missing.length} hole${missing.length === 1 ? '' : 's'} ` +
          'in the selected ranges',
      ),
      missing,
    };
  }

  const body =
    plan.multipart === null
      ? readRange(cache.intervals, plan.segments[0].start, plan.segments[0].end)
      : buildMultipartBody(plan, cache.intervals);

  if (body.length > MAX_ASSEMBLED_BYTES) {
    return fail(
      422,
      'ASSEMBLED_TOO_LARGE',
      `assembled response body is ${body.length} bytes; at most ${MAX_ASSEMBLED_BYTES} (1 MiB) are allowed`,
    );
  }

  return {
    ...plan,
    responseHeaders: {
      ...plan.responseHeaders,
      'Content-Length': String(body.length),
    },
    bodyBytes: body.length,
    bodyBase64: body.toString('base64'),
  };
}

/**
 * Validate the fragment list and decode every dataBase64 payload. Each
 * fragment must lie fully inside the resource and carry at least one byte;
 * together they may not exceed the 1 MiB decoded-input budget.
 */
function decodeFragments(fragments, size) {
  if (!Array.isArray(fragments)) {
    return {
      error: fail(400, 'INVALID_FRAGMENTS', 'fragments must be an array of {start, dataBase64} objects'),
    };
  }
  if (fragments.length > MAX_FRAGMENTS) {
    return {
      error: fail(
        400,
        'TOO_MANY_FRAGMENTS',
        `fragments carries ${fragments.length} items; at most ${MAX_FRAGMENTS} are allowed`,
      ),
    };
  }

  const decoded = [];
  let totalBytes = 0;
  for (let i = 0; i < fragments.length; i += 1) {
    const fragment = fragments[i];
    if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
      return {
        error: fail(400, 'INVALID_FRAGMENT', `fragments[${i}] must be an object with start and dataBase64`),
      };
    }
    const { start, dataBase64 } = fragment;
    if (!Number.isSafeInteger(start) || start < 0) {
      return {
        error: fail(400, 'INVALID_FRAGMENT', `fragments[${i}].start must be a non-negative safe integer`),
      };
    }
    const data = decodeBase64(dataBase64);
    if (data === null) {
      return {
        error: fail(
          400,
          'INVALID_FRAGMENT_BASE64',
          `fragments[${i}].dataBase64 must be a non-empty, canonically padded standard base64 string`,
        ),
      };
    }
    // Compared without ever summing past Number.MAX_SAFE_INTEGER.
    if (start >= size || data.length > size - start) {
      return {
        error: fail(
          400,
          'FRAGMENT_OUT_OF_BOUNDS',
          `fragments[${i}] covers ${data.length} byte(s) from offset ${start}, ` +
            `which lies outside the ${size}-byte resource`,
        ),
      };
    }
    totalBytes += data.length;
    if (totalBytes > MAX_CACHE_BYTES) {
      return {
        error: fail(
          400,
          'FRAGMENTS_TOO_LARGE',
          `fragments decode to more than ${MAX_CACHE_BYTES} bytes (1 MiB) in total`,
        ),
      };
    }
    decoded.push({ start, end: start + data.length - 1, data });
  }
  return { fragments: decoded };
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

/**
 * Merge the fragments into one canonical sparse cache: a list of disjoint,
 * ascending {start, end, data} intervals (adjacent intervals are
 * concatenated). Where fragments overlap, the overlapping bytes must agree;
 * every disagreeing position is reported through `conflicts` (adjacent
 * differing positions are merged into one interval). Byte equality is
 * transitive, so comparing each fragment against the canonical bytes of its
 * predecessors detects every pairwise disagreement.
 */
function buildCache(fragments) {
  const sorted = fragments.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const intervals = [];
  const conflicts = [];
  let current = null;

  const flush = () => {
    if (current !== null) intervals.push(current);
    current = null;
  };

  for (const fragment of sorted) {
    if (current === null || fragment.start > current.end + 1) {
      flush();
      current = { start: fragment.start, end: fragment.end, data: fragment.data };
      continue;
    }
    if (fragment.start === current.end + 1) {
      // Adjacent, no overlap: extend the canonical interval in place.
      current = {
        start: current.start,
        end: fragment.end,
        data: Buffer.concat([current.data, fragment.data]),
      };
      continue;
    }

    // fragment.start <= current.end: the overlap must be byte-identical.
    const overlapEnd = Math.min(fragment.end, current.end);
    collectConflicts(conflicts, current, fragment, overlapEnd);
    if (fragment.end > current.end) {
      current = {
        start: current.start,
        end: fragment.end,
        data: Buffer.concat([current.data, fragment.data.subarray(current.end + 1 - fragment.start)]),
      };
    }
  }
  flush();

  return { intervals, conflicts: mergeIntervals(conflicts) };
}

/**
 * Record every position in [fragment.start, overlapEnd] where the fragment
 * and the canonical interval disagree; adjacent differing positions are
 * reported as one interval.
 */
function collectConflicts(conflicts, current, fragment, overlapEnd) {
  let pos = fragment.start;
  while (pos <= overlapEnd) {
    if (current.data[pos - current.start] === fragment.data[pos - fragment.start]) {
      pos += 1;
      continue;
    }
    let end = pos + 1;
    while (
      end <= overlapEnd &&
      current.data[end - current.start] !== fragment.data[end - fragment.start]
    ) {
      end += 1;
    }
    conflicts.push({ start: pos, end: end - 1 });
    pos = end;
  }
}

/**
 * Read [start, end] from the canonical cache, slicing across as many cached
 * intervals as the range spans. Callers must have verified coverage first.
 */
function readRange(intervals, start, end) {
  const chunks = [];
  for (const interval of intervals) {
    if (interval.end < start) continue;
    if (interval.start > end) break;
    const from = Math.max(interval.start, start);
    const to = Math.min(interval.end, end);
    chunks.push(interval.data.subarray(from - interval.start, to - interval.start + 1));
  }
  return Buffer.concat(chunks);
}

/**
 * Lay out the canonical multipart/byteranges wire message in plan order:
 *   --boundary CRLF part-headers CRLF data CRLF ... --boundary-- CRLF
 * This is byte-for-byte the framing /plan accounts for and the message shape
 * /multipart-check verifies.
 */
function buildMultipartBody(plan, intervals) {
  const boundary = plan.multipart.boundary;
  const chunks = [];
  for (const segment of plan.segments) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    chunks.push(Buffer.from(segment.partHeaderBlock, 'latin1'));
    chunks.push(readRange(intervals, segment.start, segment.end));
    chunks.push(CRLF_BUFFER);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
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

function fail(statusCode, code, message) {
  const errors = { 400: 'Bad Request', 409: 'Conflict', 422: 'Unprocessable Entity' };
  return {
    statusCode,
    code,
    error: errors[statusCode],
    message,
  };
}
