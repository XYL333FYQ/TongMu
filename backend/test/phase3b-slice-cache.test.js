const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');

const { proxyHttpUpstream } = require('../dist/services/proxy/http-proxy');
const {
  assessSliceCacheEligibility,
  MemorySliceCacheStore,
  resourceValidator,
} = require('../dist/services/proxy/slice-cache');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function context(store, overrides = {}) {
  return {
    resourceIdentity: 'source://movie-1',
    resourceKind: 'media',
    cachePolicyHint: 'future-slice-cache',
    authorizationIdentity: 'user:7',
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    store,
    ...overrides,
  };
}

function createOrigin(t, options = {}) {
  const data = Buffer.from(options.data || '0123456789abcdef');
  let etag = options.etag || '"v1"';
  let getCount = 0;
  let headCount = 0;
  let delayMs = options.delayMs || 0;
  const origin = http.createServer((req, res) => {
    const validatorHeaders = etag ? { ETag: etag } : {};
    if (req.method === 'HEAD') {
      headCount += 1;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(data.length),
        'Accept-Ranges': 'bytes',
        ...validatorHeaders,
      });
      res.end();
      return;
    }
    getCount += 1;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const send = () => {
      if (!range || options.ignoreRange) {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(data.length), ...validatorHeaders });
        res.end(data);
        return;
      }
      const start = Number(range[1]);
      const requestedEnd = Number(range[2]);
      if (options.malformedRange) {
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 1-1/999', 'Content-Length': '1', ...validatorHeaders });
        res.end(data.subarray(0, 1));
        return;
      }
      if (start >= data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        res.end();
        return;
      }
      const end = Math.min(requestedEnd, data.length - 1);
      const body = data.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': String(body.length),
        'Accept-Ranges': 'bytes',
        ...validatorHeaders,
      });
      res.end(body);
    };
    if (delayMs) setTimeout(send, delayMs);
    else send();
  });
  t.after(() => origin.close());
  return {
    origin,
    data,
    getCount: () => getCount,
    headCount: () => headCount,
    setEtag: (value) => { etag = value; },
    setDelay: (value) => { delayMs = value; },
  };
}

function gatewayFor(t, origin, store, overrides = {}, headerOverrides = {}) {
  const app = express();
  app.get('/proxy', (req, res) => proxyHttpUpstream(req, res, {
    url: `http://127.0.0.1:${origin.address().port}/video.mp4`,
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    headers: { extra: headerOverrides },
    defaultContentType: 'video/mp4',
    cors: 'global',
    logTag: 'phase3b-test',
    errorMessage: 'failed',
    sliceCache: context(store, overrides),
  }));
  const gateway = http.createServer(app);
  t.after(() => gateway.close());
  return gateway;
}

function testStore(overrides = {}) {
  return new MemorySliceCacheStore({
    enabled: true,
    sliceBytes: 4,
    ttlMs: 10_000,
    maxBytes: 1024,
    maxResources: 8,
    maxSlices: 32,
    maxSlicesPerResource: 8,
    maxInFlight: 32,
    maxRequestSlices: 32,
    upstreamTimeoutMs: 2_000,
    ...overrides,
  });
}

test('Phase 3B caches aligned cross-slice, open-ended, suffix and full ranges', async (t) => {
  const origin = createOrigin(t);
  await listen(origin.origin);
  const store = testStore();
  const gateway = gatewayFor(t, origin.origin, store);
  const gatewayPort = await listen(gateway);

  const cross = await request(gatewayPort, '/proxy', { Range: 'bytes=1-9' });
  assert.equal(cross.status, 206);
  assert.equal(cross.headers['content-range'], 'bytes 1-9/16');
  assert.equal(cross.headers['content-length'], '9');
  assert.equal(cross.body.toString(), origin.data.subarray(1, 10).toString());
  assert.equal(origin.getCount(), 3, 'three aligned slices should be fetched');

  const hit = await request(gatewayPort, '/proxy', { Range: 'bytes=1-9' });
  assert.equal(hit.status, 206);
  assert.equal(hit.body.toString(), cross.body.toString());
  assert.equal(origin.getCount(), 3, 'second request must be served from slices');

  const open = await request(gatewayPort, '/proxy', { Range: 'bytes=12-' });
  assert.equal(open.body.toString(), 'cdef');
  const suffix = await request(gatewayPort, '/proxy', { Range: 'bytes=-3' });
  assert.equal(suffix.body.toString(), 'def');
  const full = await request(gatewayPort, '/proxy');
  assert.equal(full.status, 200);
  assert.equal(full.body.toString(), origin.data.toString());

  const fullOrigin = createOrigin(t);
  await listen(fullOrigin.origin);
  const fullStore = testStore();
  const fullGateway = gatewayFor(t, fullOrigin.origin, fullStore);
  const fullPort = await listen(fullGateway);
  const firstFull = await request(fullPort, '/proxy');
  assert.equal(firstFull.status, 200);
  assert.equal(firstFull.body.toString(), fullOrigin.data.toString());
  assert.equal(fullOrigin.headCount(), 1, 'full response uses one bounded HEAD metadata request');
});

test('same-slice concurrent misses use one upstream request and one abort does not cancel others', async (t) => {
  const origin = createOrigin(t, { delayMs: 60 });
  await listen(origin.origin);
  const store = testStore();
  const gateway = gatewayFor(t, origin.origin, store);
  const gatewayPort = await listen(gateway);
  const responses = await Promise.all(Array.from({ length: 20 }, () => request(gatewayPort, '/proxy', { Range: 'bytes=0-3' })));
  assert.ok(responses.every((item) => item.status === 206));
  assert.ok(responses.every((item) => item.body.toString() === '0123'));
  assert.equal(origin.getCount(), 1);
  assert.ok(store.getStats().singleFlightJoins >= 19);
  assert.equal(store.inFlightCount, 0);
});

test('single-flight supports per-caller abort and cleans failed flights for retry', async () => {
  const store = testStore();
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let fetchCount = 0;
  const fetcher = async (signal) => {
    fetchCount += 1;
    startedResolve();
    await Promise.race([
      release,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
    ]);
    return { data: Buffer.from('slice'), start: 0, end: 4, total: 5, metadata: {} };
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = store.getOrFetchSlice('flight', 0, firstController.signal, fetcher);
  const second = store.getOrFetchSlice('flight', 0, secondController.signal, fetcher);
  await started;
  firstController.abort();
  await assert.rejects(first, (error) => error.name === 'AbortError');
  releaseResolve();
  await assert.doesNotReject(second);
  assert.equal(fetchCount, 1);
  assert.equal(store.inFlightCount, 0);

  const retry = store.getOrFetchSlice('flight-failure', 0, undefined, async () => {
    fetchCount += 1;
    throw new Error('temporary upstream failure');
  });
  await assert.rejects(retry, /temporary upstream failure/);
  assert.equal(store.inFlightCount, 0);
  const retryResult = await store.getOrFetchSlice('flight-failure', 0, undefined, async () => {
    fetchCount += 1;
    return { data: Buffer.from('retry'), start: 0, end: 5, total: 6, metadata: {} };
  });
  assert.equal(retryResult.data.toString(), 'retry');
  assert.equal(fetchCount, 3);
  assert.equal(store.inFlightCount, 0);
});

test('validator change and disappearance purge old slices instead of mixing versions', async (t) => {
  const origin = createOrigin(t);
  await listen(origin.origin);
  const store = testStore({ ttlMs: 1 });
  const gateway = gatewayFor(t, origin.origin, store);
  const gatewayPort = await listen(gateway);
  const first = await request(gatewayPort, '/proxy', { Range: 'bytes=0-3' });
  assert.equal(first.body.toString(), '0123');
  origin.setEtag('"v2"');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await request(gatewayPort, '/proxy', { Range: 'bytes=0-3' });
  assert.equal(second.body.toString(), '0123');
  assert.ok(origin.getCount() >= 2);
  assert.equal(store.currentSliceCount, 1);
  origin.setEtag(undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const disappeared = await request(gatewayPort, '/proxy', { Range: 'bytes=0-3' });
  assert.equal(disappeared.body.toString(), '0123');
  assert.ok(origin.getCount() >= 3, 'validator disappearance must not reuse the old slice');
  assert.equal(resourceValidator('W/"weak"', undefined, 16).kind, 'length-only');
  assert.equal(resourceValidator(undefined, 'Tue, 01 Jan 2030 00:00:00 GMT', 16).kind, 'last-modified+length');
});

test('conditional, manifest, live and multi-range requests bypass without changing normal proxy semantics', async (t) => {
  const origin = createOrigin(t);
  await listen(origin.origin);
  const store = testStore();
  const gateway = gatewayFor(t, origin.origin, store);
  const gatewayPort = await listen(gateway);
  const conditional = await request(gatewayPort, '/proxy', { Range: 'bytes=0-3', 'If-Range': '"v1"' });
  assert.equal(conditional.status, 206);
  assert.equal(origin.getCount(), 1);
  const multi = await request(gatewayPort, '/proxy', { Range: 'bytes=0-1,4-5' });
  assert.equal(multi.status, 502, 'the fixture provider does not implement multipart responses');
  assert.equal(origin.getCount(), 2);
  assert.equal(store.getStats().bypasses, 2);

  const req = { method: 'GET', headers: {} };
  assert.equal(assessSliceCacheEligibility(req, context(store, { resourceKind: 'hls-manifest' }), store).eligible, false);
  assert.equal(assessSliceCacheEligibility(req, context(store, { lifecycle: 'live' }), store).eligible, false);
  assert.equal(assessSliceCacheEligibility({ method: 'GET', headers: { 'if-none-match': '"v1"' } }, context(store), store).eligible, false);
});

test('authorization, credential and source-generation partitions never share bytes', async (t) => {
  const origin = createOrigin(t);
  await listen(origin.origin);
  const store = testStore();
  const firstGateway = gatewayFor(t, origin.origin, store, { authorizationIdentity: 'user:7', sourceGeneration: 1 }, { Authorization: 'Bearer-A' });
  const secondGateway = gatewayFor(t, origin.origin, store, { authorizationIdentity: 'user:8', sourceGeneration: 2 }, { Authorization: 'Bearer-B' });
  const firstPort = await listen(firstGateway);
  const secondPort = await listen(secondGateway);
  await request(firstPort, '/proxy', { Range: 'bytes=0-3' });
  await request(secondPort, '/proxy', { Range: 'bytes=0-3' });
  assert.equal(origin.getCount(), 2);
  assert.equal(store.currentResourceCount, 2);
});

test('invalid upstream 206 and ignored Range fail open to the existing validated proxy path', async (t) => {
  const malformedOrigin = createOrigin(t, { malformedRange: true });
  await listen(malformedOrigin.origin);
  const malformedStore = testStore();
  const malformedGateway = gatewayFor(t, malformedOrigin.origin, malformedStore);
  const malformedPort = await listen(malformedGateway);
  const malformed = await request(malformedPort, '/proxy', { Range: 'bytes=0-3' });
  assert.equal(malformed.status, 502);
  assert.equal(malformedStore.currentSliceCount, 0);

  const ignoredOrigin = createOrigin(t, { ignoreRange: true });
  await listen(ignoredOrigin.origin);
  const ignoredStore = testStore();
  const ignoredGateway = gatewayFor(t, ignoredOrigin.origin, ignoredStore);
  const ignoredPort = await listen(ignoredGateway);
  const ignored = await request(ignoredPort, '/proxy', { Range: 'bytes=4-7' });
  assert.equal(ignored.status, 502);
  assert.equal(ignoredStore.currentSliceCount, 0);
});

test('memory store enforces LRU, TTL and resource bounds', async () => {
  const store = testStore({ maxBytes: 8, maxSlices: 2, maxSlicesPerResource: 2, ttlMs: 1 });
  const metadata = {
    resourceKey: 'r',
    validator: resourceValidator('"v1"', undefined, 12),
    totalSize: 12,
    supportsRanges: true,
    validatedAt: Date.now(),
    lastAccessed: Date.now(),
  };
  store.setMetadata(metadata);
  const version = metadata.validator.signature;
  assert.equal(store.putSlice('r', version, 0, Buffer.from('0123')), true);
  assert.equal(store.putSlice('r', version, 1, Buffer.from('4567')), true);
  assert.equal(store.getSlice('r', version, 0).toString(), '0123');
  assert.equal(store.putSlice('r', version, 2, Buffer.from('89ab')), true);
  assert.equal(store.getSlice('r', version, 0).toString(), '0123');
  assert.equal(store.getSlice('r', version, 1), undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getSlice('r', version, 0), undefined);
  assert.ok(store.getStats().evictions >= 2);
});
