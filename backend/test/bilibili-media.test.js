const assert = require('node:assert/strict');
const test = require('node:test');

const { checkUrlReachable } = require('../dist/services/bilibili/cdn');
const {
  getQualityFallbackCandidates,
} = require('../dist/services/bilibili/resolver');

test('CDN probe accepts a successful HEAD without downloading a body', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    calls.push(init);
    return new Response(null, { status: 200 });
  };

  assert.equal(await checkUrlReachable('https://cdn.example/video', fakeFetch), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');
});

test('CDN probe falls back from HEAD 403 to a two-byte Range GET', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    calls.push(init);
    if (init.method === 'HEAD') return new Response(null, { status: 403 });
    return new Response(new Uint8Array([0, 1]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-1/100' },
    });
  };

  assert.equal(await checkUrlReachable('https://cdn.example/video', fakeFetch), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Range, 'bytes=0-1');
});

test('quality fallback preserves the highest eligible quality below the request', () => {
  assert.deepEqual(
    getQualityFallbackCandidates(120, true, true).slice(0, 3),
    [116, 112, 80],
  );
  assert.deepEqual(
    getQualityFallbackCandidates(120, false, true).slice(0, 3),
    [80, 74, 64],
  );
  assert.deepEqual(getQualityFallbackCandidates(80, false, false), [32, 16]);
});
