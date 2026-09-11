const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { checkUrlReachable } = require('../dist/services/bilibili/cdn');
const {
  getQualityFallbackCandidates,
} = require('../dist/services/bilibili/resolver');
const {
  fetchWithProxyPolicy,
  isPublicIp,
  sanitizeProxyHeaders,
  validateProxyUrl,
} = require('../dist/services/proxy/safe-fetch');

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

test('public proxy policy rejects loopback, metadata, private and special IPs', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fc00::1]/',
    'http://[64:ff9b:1:7f00:0:100::]/',
  ]) {
    await assert.rejects(fetchWithProxyPolicy(url, {}, 'public-only'), /公网地址/);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('127.0.0.1'), false);
});

test('trusted private policy only permits configured hosts', async () => {
  await assert.rejects(
    fetchWithProxyPolicy(
      'http://169.254.169.254/latest/meta-data/',
      {},
      'trusted-private',
      ['nas.local'],
    ),
    /公网地址/,
  );
});

test('DNS names resolving to loopback are rejected at connection lookup', async () => {
  await assert.rejects(
    fetchWithProxyPolicy('http://localtest.me/', {}, 'public-only'),
    /DNS 解析到非公网地址/,
  );
});

test('proxy URL validation rejects non-http schemes and embedded credentials', () => {
  assert.throws(() => validateProxyUrl('file:///etc/passwd'), /HTTP\/HTTPS/);
  assert.throws(() => validateProxyUrl('http://user:pass@example.com/video'), /凭证/);
});

test('proxy request header sanitizer removes hop-by-hop and identity headers', () => {
  assert.deepEqual(
    sanitizeProxyHeaders({
      Host: 'metadata.internal',
      Connection: 'keep-alive',
      'Proxy-Authorization': 'secret',
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
      'Sec-Fetch-Site': 'same-origin',
      Referer: 'https://example.com/',
      Range: 'bytes=0-1',
    }),
    { Referer: 'https://example.com/', Range: 'bytes=0-1' },
  );
});

test('trusted private proxy remains usable and strips credentials on cross-origin redirect', async (t) => {
  let receivedHeaders;
  const target = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': 'bytes 0-1/2',
    });
    res.end('ok');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const targetPort = target.address().port;

  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/video` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  t.after(() => redirector.close());
  const redirectPort = redirector.address().port;

  const response = await fetchWithProxyPolicy(
    `http://127.0.0.1:${redirectPort}/start`,
    {
      headers: {
        Cookie: 'session=secret',
        Authorization: 'Bearer secret',
        'X-Emby-Token': 'secret',
        Range: 'bytes=0-1',
      },
    },
    'trusted-private',
    ['127.0.0.1'],
  );
  assert.equal(response.status, 206);
  assert.equal(receivedHeaders.cookie, undefined);
  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(receivedHeaders['x-emby-token'], undefined);
  assert.equal(receivedHeaders.range, 'bytes=0-1');
  await response.body.cancel();
});
