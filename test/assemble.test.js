import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/assemble-response';

function assemble(payload, rangeHeader = 'bytes=0-99') {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', range: rangeHeader },
    payload: JSON.stringify(payload),
  });
}

// Deterministic position-dependent content: the byte at absolute offset o is
// o % 251, so any assembled span [start, start+length) is verifiable.
function bytes(start, length) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = (start + i) % 251;
  return buffer;
}

const fragment = (start, length) => ({ start, dataBase64: bytes(start, length).toString('base64') });
const decodedBody = (body) => Buffer.from(body.bodyBase64, 'base64');

test('single range covered by one fragment returns 206 with the raw body', async () => {
  const res = await assemble({ size: 1000, fragments: [fragment(0, 100)] });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual(decodedBody(body), bytes(0, 100));
  assert.equal(body.bodyBytes, 100);
  assert.equal(body.multipart, null);
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Range': 'bytes 0-99/1000',
    'Content-Length': '100',
  });
});

test('a plan segment is assembled across several adjacent fragments', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 30), fragment(30, 40), fragment(70, 30)] },
    'bytes=0-99',
  );
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual(decodedBody(body), bytes(0, 100));
  assert.equal(body.responseHeaders['Content-Length'], '100');
});

test('only the selected bytes are returned when fragments cover more', async () => {
  const res = await assemble({ size: 1000, fragments: [fragment(0, 200)] }, 'bytes=50-99');
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual(decodedBody(body), bytes(50, 50));
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 50-99/1000');
  assert.equal(body.responseHeaders['Content-Length'], '50');
});

test('overlapping fragments with identical bytes assemble cleanly', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 60), fragment(40, 60)] },
    'bytes=0-99',
  );
  assert.equal(res.statusCode, 206);
  assert.deepEqual(decodedBody(res.json()), bytes(0, 100));
});

test('multiple ranges produce a canonical multipart/byteranges body', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 110)] },
    'bytes=0-9, 100-109',
  );
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 2);
  const boundary = body.multipart.boundary;
  assert.equal(
    body.responseHeaders['Content-Type'],
    `multipart/byteranges; boundary=${boundary}`,
  );

  const expected = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'latin1'),
    Buffer.from('Content-Type: application/octet-stream\r\nContent-Range: bytes 0-9/1000\r\n\r\n', 'latin1'),
    bytes(0, 10),
    Buffer.from('\r\n', 'latin1'),
    Buffer.from(`--${boundary}\r\n`, 'latin1'),
    Buffer.from('Content-Type: application/octet-stream\r\nContent-Range: bytes 100-109/1000\r\n\r\n', 'latin1'),
    bytes(100, 10),
    Buffer.from('\r\n', 'latin1'),
    Buffer.from(`--${boundary}--\r\n`, 'latin1'),
  ]);
  assert.deepEqual(decodedBody(body), expected);
  // Content-Length must equal the decoded body length.
  assert.equal(body.responseHeaders['Content-Length'], String(expected.length));
  assert.equal(body.bodyBytes, expected.length);
});

test('multipart parts follow plan order, not offset order', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 100)] },
    'bytes=90-99,0-9',
  );
  assert.equal(res.statusCode, 206);
  const body = res.json();
  const boundary = body.multipart.boundary;
  const text = decodedBody(body).toString('latin1');
  const first = text.indexOf('Content-Range: bytes 90-99/1000');
  const second = text.indexOf('Content-Range: bytes 0-9/1000');
  assert.ok(first !== -1 && second !== -1 && first < second);
  assert.ok(text.startsWith(`--${boundary}\r\n`));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
});

test('assembled multipart body passes /multipart-check round-trip', async () => {
  const res = await assemble(
    { size: 1000, contentType: 'video/mp4', fragments: [fragment(0, 10), fragment(100, 10)] },
    'bytes=0-9, 100-109',
  );
  assert.equal(res.statusCode, 206);
  const assembled = res.json();

  const check = await app.inject({
    method: 'POST',
    url: '/multipart-check',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      size: 1000,
      expected: [{ start: 0, end: 9 }, { start: 100, end: 109 }],
      contentType: assembled.responseHeaders['Content-Type'],
      bodyBase64: assembled.bodyBase64,
    }),
  });
  assert.equal(check.statusCode, 200);
  assert.deepEqual(check.json(), {
    statusCode: 200,
    received: [{ start: 0, end: 9 }, { start: 100, end: 109 }],
    missing: [],
    extra: [],
    complete: true,
  });
});

test('suffix ranges are honoured and read from the cached tail', async () => {
  const res = await assemble({ size: 1000, fragments: [fragment(900, 100)] }, 'bytes=-100');
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 900-999/1000');
  assert.deepEqual(decodedBody(body), bytes(900, 100));
});

test('overlapping fragments with different bytes report 409 and the conflict intervals', async () => {
  const good = fragment(0, 100);
  // Second fragment overlaps [40,99] and disagrees at absolute 45-49 and 70-71.
  const evil = bytes(40, 60);
  for (let i = 45 - 40; i <= 49 - 40; i += 1) evil[i] = (evil[i] + 1) % 256;
  for (let i = 70 - 40; i <= 71 - 40; i += 1) evil[i] = (evil[i] + 1) % 256;

  const res = await assemble({
    size: 1000,
    fragments: [good, { start: 40, dataBase64: evil.toString('base64') }],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    statusCode: 409,
    code: 'FRAGMENT_CONFLICT',
    error: 'Conflict',
    message: 'overlapping fragments carry different bytes in 2 intervals',
    conflicts: [{ start: 45, end: 49 }, { start: 70, end: 71 }],
  });
});

test('conflicts outside the selected ranges still fail the request', async () => {
  const evil = bytes(80, 20);
  evil[0] = (evil[0] + 1) % 256; // disagrees with fragment(0, 100) at offset 80
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 100), { start: 80, dataBase64: evil.toString('base64') }] },
    'bytes=0-9',
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'FRAGMENT_CONFLICT');
  assert.deepEqual(res.json().conflicts, [{ start: 80, end: 80 }]);
});

test('a hole in the middle of the selected range reports 409 and the missing interval', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(0, 30), fragment(60, 40)] },
    'bytes=0-99',
  );
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    statusCode: 409,
    code: 'INCOMPLETE_COVERAGE',
    error: 'Conflict',
    message: 'cached fragments leave 1 hole in the selected ranges',
    missing: [{ start: 30, end: 59 }],
  });
});

test('holes at both edges and across several selected ranges are all reported', async () => {
  const res = await assemble(
    { size: 1000, fragments: [fragment(20, 60)] },
    'bytes=0-99, 500-509',
  );
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().missing, [
    { start: 0, end: 19 },
    { start: 80, end: 99 },
    { start: 500, end: 509 },
  ]);
});

test('an empty cache misses every selected byte', async () => {
  const res = await assemble({ size: 1000, fragments: [] }, 'bytes=0-99');
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().missing, [{ start: 0, end: 99 }]);
});

test('fragment starting at or past the resource end is rejected', async () => {
  const res = await assemble({ size: 100, fragments: [fragment(100, 1)] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENT_OUT_OF_BOUNDS');
});

test('fragment extending past the resource end is rejected', async () => {
  const res = await assemble({ size: 100, fragments: [fragment(90, 20)] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENT_OUT_OF_BOUNDS');
});

test('fragments are rejected on an empty resource', async () => {
  const res = await assemble({ size: 0, fragments: [fragment(0, 1)] }, 'bytes=0-0');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENT_OUT_OF_BOUNDS');
});

test('non-canonical or malformed base64 is rejected', async () => {
  // 'QQ=' is shorter than the schema minimum and fails even earlier (400 too).
  for (const dataBase64 of ['####', 'QR==', 'QQ==QQ==', 'Q Q==']) {
    const res = await assemble({ size: 1000, fragments: [{ start: 0, dataBase64 }] });
    assert.equal(res.statusCode, 400, `expected 400 for dataBase64=${dataBase64}`);
    assert.equal(res.json().code, 'INVALID_FRAGMENT_BASE64');
  }
  const tooShort = await assemble({ size: 1000, fragments: [{ start: 0, dataBase64: 'QQ=' }] });
  assert.equal(tooShort.statusCode, 400);
});

test('fragment start must be a non-negative safe integer', async () => {
  const dataBase64 = bytes(0, 1).toString('base64');
  for (const start of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1, null]) {
    const res = await assemble({ size: 1000, fragments: [{ start, dataBase64 }] });
    assert.equal(res.statusCode, 400, `expected 400 for start=${start}`);
  }
});

test('unknown fields are rejected at the top level and inside fragments', async () => {
  const dataBase64 = bytes(0, 10).toString('base64');
  for (const payload of [
    { size: 1000, fragments: [{ start: 0, dataBase64, end: 9 }] },
    { size: 1000, fragments: [{ start: 0, dataBase64 }], contentRange: 'bytes 0-9/1000' },
  ]) {
    const res = await assemble(payload);
    assert.equal(res.statusCode, 400);
  }
});

test('a missing Range header is rejected', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 1000, fragments: [fragment(0, 100)] }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_RANGE');
});

test('a non-byte range unit is rejected', async () => {
  const res = await assemble({ size: 1000, fragments: [fragment(0, 100)] }, 'items=0-99');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'UNSUPPORTED_RANGE_UNIT');
});

test('an unsatisfiable range passes the 416 plan through untouched', async () => {
  const res = await assemble({ size: 100, fragments: [] }, 'bytes=200-299');
  assert.equal(res.statusCode, 416);
  const body = res.json();
  assert.equal(body.code, 'RANGE_NOT_SATISFIABLE');
  assert.equal(body.responseHeaders['Content-Range'], 'bytes */100');
});

test('an empty resource yields the 416 plan', async () => {
  const res = await assemble({ size: 0, fragments: [] }, 'bytes=0-0');
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().code, 'RANGE_NOT_SATISFIABLE');
});

test('the /plan segment-count guard applies before any cache check', async () => {
  // 17 disjoint single-byte ranges exceed the default 16-segment cap.
  const range = Array.from({ length: 17 }, (_, i) => `${i * 2}-${i * 2}`).join(',');
  const res = await assemble({ size: 1000, fragments: [] }, `bytes=${range}`);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
});

test('the /plan transfer-size guard applies', async () => {
  const res = await assemble({ size: 100, fragments: [fragment(0, 100)] }, 'bytes=0-49, 60-99');
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TRANSFER_LIMIT_EXCEEDED');
});

test('fragments decoding to more than 1 MiB in total are rejected', async () => {
  const res = await assemble({
    size: 2 * 1024 * 1024,
    fragments: [fragment(0, 600 * 1024), fragment(600 * 1024, 600 * 1024)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENTS_TOO_LARGE');
});

test('an assembled body larger than 1 MiB is rejected with 422', async () => {
  // Two 512 KiB segments: exactly 1 MiB of selected bytes plus multipart
  // framing pushes the body past the 1 MiB output limit.
  const res = await assemble(
    {
      size: 10 * 1024 * 1024,
      fragments: [fragment(0, 512 * 1024), fragment(1024 * 1024, 512 * 1024)],
    },
    `bytes=0-${512 * 1024 - 1}, ${1024 * 1024}-${1024 * 1024 + 512 * 1024 - 1}`,
  );
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'ASSEMBLED_TOO_LARGE');
});

test('a body of exactly 1 MiB is still served', async () => {
  const res = await assemble(
    { size: 2 * 1024 * 1024, fragments: [fragment(0, 1024 * 1024)] },
    `bytes=0-${1024 * 1024 - 1}`,
  );
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.bodyBytes, 1024 * 1024);
  assert.equal(body.responseHeaders['Content-Length'], String(1024 * 1024));
  assert.deepEqual(decodedBody(body), bytes(0, 1024 * 1024));
});

test('an invalid contentType is rejected', async () => {
  const res = await assemble(
    { size: 1000, contentType: 'not a media type', fragments: [fragment(0, 100)] },
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('contentType is echoed into single-part and multipart headers', async () => {
  const single = await assemble(
    { size: 1000, contentType: 'video/mp4', fragments: [fragment(0, 100)] },
    'bytes=0-99',
  );
  assert.equal(single.json().responseHeaders['Content-Type'], 'video/mp4');

  const multi = await assemble(
    { size: 1000, contentType: 'video/mp4', fragments: [fragment(0, 10), fragment(100, 10)] },
    'bytes=0-9, 100-109',
  );
  const body = multi.json();
  assert.match(body.responseHeaders['Content-Type'], /^multipart\/byteranges; boundary=brp-[0-9a-f]{48}$/);
  const text = decodedBody(body).toString('latin1');
  assert.equal(text.match(/Content-Type: video\/mp4/g).length, 2);
});

test('If-Range is not consulted by this endpoint', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      range: 'bytes=0-99',
      'if-range': '"anything"',
    },
    payload: JSON.stringify({ size: 1000, fragments: [fragment(0, 100)] }),
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition, undefined);
});
