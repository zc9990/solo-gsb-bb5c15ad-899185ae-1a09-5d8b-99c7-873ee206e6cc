import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/assemble-response';

function assemble({ size, range, contentType, fragments }) {
  const headers = { 'content-type': 'application/json' };
  if (range !== undefined) headers.range = range;
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: JSON.stringify({
      size,
      ...(contentType !== undefined ? { contentType } : {}),
      fragments,
    }),
  });
}

// Fragment shorthand: bytes for [start, start + data.length - 1].
function frag(start, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return { start, dataBase64: buffer.toString('base64') };
}

const fill = (length, byte) => Buffer.alloc(length, byte);

function decodedBody(res) {
  return Buffer.from(res.json().bodyBase64, 'base64');
}

test('single segment is assembled from one fragment', async () => {
  const data = fill(100, 0x61);
  const res = await assemble({ size: 1000, range: 'bytes=0-99', fragments: [frag(0, data)] });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.multipart, null);
  assert.equal(body.bodyBytes, 100);
  assert.deepEqual(decodedBody(res), data);
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Range': 'bytes 0-99/1000',
    'Content-Length': '100',
  });
});

test('a selected range can be read across fragment boundaries', async () => {
  const res = await assemble({
    size: 1000,
    range: 'bytes=25-74',
    fragments: [frag(0, fill(50, 0x61)), frag(50, fill(50, 0x62))],
  });
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res), Buffer.concat([fill(25, 0x61), fill(25, 0x62)]));
});

test('only the selected slice of a larger fragment is sent', async () => {
  const data = Buffer.alloc(1000);
  for (let i = 0; i < 1000; i += 1) data[i] = i % 251;
  const res = await assemble({ size: 1000, range: 'bytes=900-990', fragments: [frag(0, data)] });
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res), data.subarray(900, 991));
});

test('multipart body round-trips through /multipart-check and reuses the plan boundary', async () => {
  const data = Buffer.alloc(1000);
  for (let i = 0; i < 1000; i += 1) data[i] = (i * 7) % 256;
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-9, 90-99',
    contentType: 'video/mp4',
    fragments: [frag(0, data)],
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 2);
  assert.ok(body.responseHeaders['Content-Type'].startsWith('multipart/byteranges; boundary=brp-'));

  // Content-Length is exactly the decoded body length.
  const wire = decodedBody(res);
  assert.equal(body.bodyBytes, wire.length);
  assert.equal(body.responseHeaders['Content-Length'], String(wire.length));

  // The same request to /plan yields the identical boundary and headers.
  const plan = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { 'content-type': 'application/json', range: 'bytes=0-9, 90-99' },
    payload: JSON.stringify({ size: 1000, contentType: 'video/mp4' }),
  });
  assert.equal(plan.json().responseHeaders['Content-Type'], body.responseHeaders['Content-Type']);
  assert.equal(plan.json().responseHeaders['Content-Length'], body.responseHeaders['Content-Length']);

  // The assembled message verifies cleanly against the selected ranges.
  const check = await app.inject({
    method: 'POST',
    url: '/multipart-check',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      size: 1000,
      expected: [{ start: 0, end: 9 }, { start: 90, end: 99 }],
      contentType: body.responseHeaders['Content-Type'],
      bodyBase64: body.bodyBase64,
    }),
  });
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().complete, true);
});

test('segments are emitted in plan order, not offset order', async () => {
  const data = Buffer.alloc(1000);
  for (let i = 0; i < 1000; i += 1) data[i] = i % 256;
  const res = await assemble({
    size: 1000,
    range: 'bytes=900-999, 0-99',
    fragments: [frag(0, data)],
  });
  assert.equal(res.statusCode, 206);
  const wire = decodedBody(res).toString('latin1');
  const firstRange = wire.indexOf('Content-Range: bytes 900-999/1000');
  const secondRange = wire.indexOf('Content-Range: bytes 0-99/1000');
  assert.ok(firstRange !== -1 && secondRange !== -1);
  assert.ok(firstRange < secondRange);
});

test('overlapping fragments with identical bytes assemble fine', async () => {
  const data = fill(100, 0x61);
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-99',
    fragments: [frag(0, data.subarray(0, 60)), frag(40, data.subarray(40, 100))],
  });
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res), data);
});

test('a fragment fully contained in another is accepted when bytes agree', async () => {
  const data = fill(100, 0x61);
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-99',
    fragments: [frag(0, data), frag(20, fill(10, 0x61))],
  });
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res), data);
});

test('overlapping fragments with different bytes return 409 with the conflict interval', async () => {
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-99',
    fragments: [frag(0, fill(60, 0x61)), frag(40, fill(60, 0x62))],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_CONFLICT');
  assert.equal(body.error, 'Conflict');
  assert.deepEqual(body.conflicts, [{ start: 40, end: 59 }]);
});

test('only the disagreeing positions inside an overlap are reported', async () => {
  // A covers [0,9] with 'a'; B covers [5,14] and differs from A only at 7-8.
  const b = Buffer.concat([Buffer.from('aabba', 'latin1'), fill(5, 0x63)]);
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-14',
    fragments: [frag(0, fill(10, 0x61)), frag(5, b)],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().conflicts, [{ start: 7, end: 8 }]);
});

test('adjacent conflict runs are merged into one interval', async () => {
  // A [0,9] 'a' vs B [5,14] 'b' conflicts at 5-9; C [10,19] 'c' vs B conflicts
  // at 10-14; the two runs are adjacent and merge into 5-14.
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-19',
    fragments: [frag(0, fill(10, 0x61)), frag(5, fill(10, 0x62)), frag(10, fill(10, 0x63))],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().conflicts, [{ start: 5, end: 14 }]);
});

test('a fragment contained in another with different bytes conflicts on its whole span', async () => {
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-99',
    fragments: [frag(0, fill(100, 0x61)), frag(20, fill(10, 0x62))],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().conflicts, [{ start: 20, end: 29 }]);
});

test('a hole in the cache returns 409 with the missing interval', async () => {
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-99',
    fragments: [frag(0, fill(30, 0x61)), frag(60, fill(40, 0x62))],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_COVERAGE_INCOMPLETE');
  assert.equal(body.error, 'Conflict');
  assert.deepEqual(body.missing, [{ start: 30, end: 59 }]);
});

test('missing intervals are reported per selected segment', async () => {
  const res = await assemble({
    size: 1000,
    range: 'bytes=0-9, 90-99',
    fragments: [frag(0, fill(10, 0x61))],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().missing, [{ start: 90, end: 99 }]);
});

test('an empty fragment list covers nothing', async () => {
  const res = await assemble({ size: 1000, range: 'bytes=0-99', fragments: [] });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().missing, [{ start: 0, end: 99 }]);
});

test('non-canonical base64 fragment data is rejected', async () => {
  for (const dataBase64 of ['====', 'abcd!', 'YWJ===', 'AA==AAAA', 'AB==']) {
    const res = await assemble({ size: 10, range: 'bytes=0-1', fragments: [{ start: 0, dataBase64 }] });
    assert.equal(res.statusCode, 400, `expected 400 for '${dataBase64}'`);
    assert.equal(res.json().code, 'INVALID_FRAGMENT_BASE64');
  }
  // Shorter than one base64 quantum is already a schema violation.
  const tooShort = await assemble({ size: 10, range: 'bytes=0-1', fragments: [{ start: 0, dataBase64: 'QQ=' }] });
  assert.equal(tooShort.statusCode, 400);
});

test('a fragment extending past the resource end is rejected', async () => {
  const res = await assemble({ size: 100, range: 'bytes=0-9', fragments: [frag(95, fill(10, 0x61))] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENT_OUT_OF_BOUNDS');
});

test('a cache decoding to more than 1 MiB is rejected', async () => {
  const res = await assemble({
    size: 2 * 1024 * 1024,
    range: 'bytes=0-9',
    fragments: [frag(0, fill(1024 * 1024, 0x61)), frag(1024 * 1024, fill(1, 0x62))],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENTS_TOO_LARGE');
});

test('an assembled body beyond 1 MiB is rejected by the output guard', async () => {
  const half = 512 * 1024;
  const res = await assemble({
    size: 3 * 1024 * 1024,
    range: `bytes=0-${half - 1}, ${1024 * 1024}-${1024 * 1024 + half - 1}`,
    fragments: [frag(0, fill(half, 0x61)), frag(1024 * 1024, fill(half, 0x62))],
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'ASSEMBLED_BODY_TOO_LARGE');
  assert.equal(body.limitBytes, 1024 * 1024);
  assert.ok(body.transferBytes > 1024 * 1024);
});

test('a body of exactly 1 MiB is still allowed', async () => {
  const data = fill(1024 * 1024, 0x61);
  const res = await assemble({
    size: 1024 * 1024,
    range: 'bytes=0-1048575',
    fragments: [frag(0, data)],
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().bodyBytes, 1024 * 1024);
  assert.equal(res.json().responseHeaders['Content-Length'], '1048576');
});

test('an unsatisfiable range returns the planner 416 without touching the cache', async () => {
  const res = await assemble({ size: 1000, range: 'bytes=1000-', fragments: [] });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().code, 'RANGE_NOT_SATISFIABLE');
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */1000');
});

test('planner guards still apply to the selected ranges', async () => {
  const ranges = Array.from({ length: 17 }, (_, i) => `${i * 2}-${i * 2}`).join(', ');
  const res = await assemble({ size: 1000, range: `bytes=${ranges}`, fragments: [] });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
});

test('a malformed Range header is a 400, not a 409', async () => {
  const badUnit = await assemble({ size: 100, range: 'items=0-9', fragments: [] });
  assert.equal(badUnit.statusCode, 400);
  assert.equal(badUnit.json().code, 'UNSUPPORTED_RANGE_UNIT');

  const malformed = await assemble({ size: 100, range: 'bytes=abc', fragments: [] });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, 'MALFORMED_RANGE');
});

test('the Range header is required', async () => {
  const res = await assemble({ size: 100, fragments: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_RANGE');
});

test('suffix ranges are assembled from the tail of the cache', async () => {
  const data = Buffer.alloc(100);
  for (let i = 0; i < 100; i += 1) data[i] = i;
  const res = await assemble({ size: 100, range: 'bytes=-10', fragments: [frag(0, data)] });
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res), data.subarray(90));
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes 90-99/100');
});

test('a zero-size resource yields the planner 416', async () => {
  const res = await assemble({ size: 0, range: 'bytes=0-0', fragments: [] });
  assert.equal(res.statusCode, 416);
});

test('contentType is propagated to single and multipart responses', async () => {
  const single = await assemble({
    size: 100,
    range: 'bytes=0-9',
    contentType: 'video/mp4',
    fragments: [frag(0, fill(10, 0x61))],
  });
  assert.equal(single.json().responseHeaders['Content-Type'], 'video/mp4');

  const multi = await assemble({
    size: 1000,
    range: 'bytes=0-9, 990-999',
    contentType: 'video/mp4',
    fragments: [frag(0, fill(10, 0x61)), frag(990, fill(10, 0x62))],
  });
  assert.equal(multi.statusCode, 206);
  const wire = decodedBody(multi).toString('latin1');
  assert.match(wire, /Content-Type: video\/mp4\r\nContent-Range: bytes 0-9\/1000/);
});

test('an invalid contentType is rejected', async () => {
  const res = await assemble({
    size: 10,
    range: 'bytes=0-1',
    contentType: 'not a media type',
    fragments: [frag(0, 'ab')],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('strict schema rejects bad types, unknown fields and empty data', async () => {
  const valid = { size: 10, fragments: [frag(0, 'ab')] };
  const variants = [
    { ...valid, size: '10' },
    { ...valid, size: -1 },
    { ...valid, size: 1.5 },
    { ...valid, fragments: [{ start: 0 }] },
    { ...valid, fragments: [{ dataBase64: 'QQ==' }] },
    { ...valid, fragments: [{ start: -1, dataBase64: 'QQ==' }] },
    { ...valid, fragments: [{ start: 0, dataBase64: 'QQ==', extra: 1 }] },
    { ...valid, fragments: [{ start: 0, dataBase64: '' }] },
    { ...valid, fragments: [{ start: 0, dataBase64: 1 }] },
    { ...valid, fragments: 'x' },
    { ...valid, unknown: true },
    { fragments: [frag(0, 'ab')] },
  ];
  for (const payload of variants) {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', range: 'bytes=0-1' },
      payload: JSON.stringify(payload),
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('more fragments than the limit are rejected', async () => {
  const fragments = Array.from({ length: 1025 }, (_, i) => frag(i, 'x'));
  const res = await assemble({ size: 2000, range: 'bytes=0-0', fragments });
  assert.equal(res.statusCode, 400);
});
