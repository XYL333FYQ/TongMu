const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  __setLogSinkForTests,
  BoundedMetricsRegistry,
  createLogRecord,
  httpObservabilityMiddleware,
  metrics,
  redactValue,
  resolveMatchedRoute,
} = require('../dist/observability');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ host: '127.0.0.1', port: address.port, path, headers }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('recursive logger redaction removes the Phase 6 secret corpus', () => {
  const secret = 'secret-value-DO-NOT-LOG';
  const jwt = 'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop';
  const error = new Error(`Authorization: Bearer ${secret} https://music.126.net/a.mp3?token=${secret}`);
  error.cause = { headers: { Cookie: `MUSIC_U=${secret}; __csrf=${secret}` }, refreshToken: secret };
  const output = JSON.stringify(redactValue({
    authorization: `Bearer ${secret}`,
    nested: { MUSIC_U: secret, password: secret, query_token: secret, error },
    providerPassword: secret,
    bilibiliCookie: secret,
    ncmSignedUrl: `https://music.126.net/a.mp3?token=${secret}`,
    updaterToken: secret,
    jwt,
    signing_private_key: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
  }));
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /eyJabcdefghijk/);
  assert.match(output, /REDACTED/);

  const record = createLogRecord('error', 'provider', 'failed', { error });
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
});

test('request IDs are bounded and streaming byte counts do not require Content-Length', async (t) => {
  metrics.reset();
  const logLines = [];
  __setLogSinkForTests((line) => logLines.push(line));
  t.after(() => __setLogSinkForTests());

  const app = express();
  app.use(httpObservabilityMiddleware());
  app.get('/api/stream/:id', async (_req, res) => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let index = 0; index < 100; index += 1) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  });
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const accepted = await request(server, '/api/ping', { 'X-Request-Id': 'client.safe-123' });
  assert.equal(accepted.headers['x-request-id'], 'client.safe-123');
  const rejected = await request(server, '/api/ping', { 'X-Request-Id': 'x'.repeat(256) });
  assert.match(rejected.headers['x-request-id'], /^[0-9a-f-]{36}$/);

  const before = process.memoryUsage().heapUsed;
  const streamed = await request(server, '/api/stream/random-room-id');
  const after = process.memoryUsage().heapUsed;
  assert.equal(streamed.bytes, 100 * 1024 * 1024);
  // The middleware counts chunks and never buffers the response. Keep a wide
  // allowance for Node/CI GC scheduling while rejecting a full 100 MiB copy.
  assert.ok(after - before < 64 * 1024 * 1024, `unexpected heap growth: ${after - before}`);

  let rendered = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    rendered = metrics.render();
    if (rendered.includes('104857600')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(rendered, /http_response_bytes_total\{matched_route="\/api\/stream\/:id",status_class="2xx"\} 104857600/);
  assert.doesNotMatch(rendered, /random-room-id/);
  assert.ok(logLines.some((line) => line.includes('"responseBytes":104857600')));
  assert.ok(logLines.every((line) => !line.includes('random-room-id')));
});

test('10,000 random unmatched paths collapse to one bounded metric label', () => {
  const registry = new BoundedMetricsRegistry(32);
  registry.define({
    name: 'requests_total',
    help: 'test',
    kind: 'counter',
    labelNames: ['matched_route'],
    allowedLabels: { matched_route: 'matched_route' },
  });
  for (let index = 0; index < 10_000; index += 1) {
    const matched = resolveMatchedRoute({ route: undefined, originalUrl: `/api/rooms/random-${index}` });
    registry.increment('requests_total', { matched_route: matched });
  }
  assert.equal(registry.seriesCount(), 1);
  assert.match(registry.render(), /matched_route="UNMATCHED"\} 10000/);
});
