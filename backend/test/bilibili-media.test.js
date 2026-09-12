const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');

const { checkUrlReachable, getBilibiliMediaHeaders } = require('../dist/services/bilibili/cdn');
const {
  getQualityFallbackCandidates,
  MP4_MAX_QN,
  narrowAcceptQualityForMp4,
  selectBestAvailableQuality,
} = require('../dist/services/bilibili/resolver');
const {
  fetchWithProxyPolicy,
  assertPublicUrl,
  isPublicIp,
  resolvePublicAddresses,
  sanitizeProxyHeaders,
  validateProxyUrl,
} = require('../dist/services/proxy/safe-fetch');
const { proxyHttpUpstream } = require('../dist/services/proxy/http-proxy');
const {
  containerFromContentType,
  containerFromUrl,
  probeMediaUrl,
  sniffMediaMagic,
} = require('../dist/services/media/probe');
const { planPlayback } = require('../dist/services/media/planner');
const {
  issueMediaHandle,
  issueRoomMediaGrant,
  resolveMediaHandle,
  resolveRoomMediaGrant,
} = require('../dist/services/media/handles');
const { authorizeRoomMediaGrant } = require('../dist/services/media/room-access');
const { discoverCandidatesFromHtml } = require('../dist/services/media/resolvers/generic-web');
const { rewriteManifest, shouldRewriteManifest, toPublicDescriptor } = require('../dist/routes/stream/media');
const { createBrowserSafeProxy } = require('../dist/services/media/resolvers/browser-safe-proxy');
const {
  headersForJsonCandidate,
  readBoundedJsonBody,
  safeForwardHeaders,
} = require('../dist/services/media/resolvers/browser');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
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

function connectRequest(port, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

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

test('CDN probe uses a fresh signal after HEAD times out', async () => {
  const methods = [];
  const fakeFetch = async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'HEAD') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    assert.equal(init.signal.aborted, false);
    return new Response(new Uint8Array([0, 1]), { status: 206 });
  };
  assert.equal(await checkUrlReachable('https://cdn.example/video', fakeFetch, 10), true);
  assert.deepEqual(methods, ['HEAD', 'GET']);
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
  assert.equal(selectBestAvailableQuality(120, [{ id: 16 }, { id: 80 }, { id: 64 }]), 80);
  assert.equal(selectBestAvailableQuality(74, [{ id: 80 }, { id: 64 }, { id: 32 }]), 64);
  assert.equal(MP4_MAX_QN, 64);
  assert.deepEqual(
    narrowAcceptQualityForMp4([{ id: 80, label: '1080P' }, { id: 64, label: '720P' }]),
    [{ id: 64, label: '720P' }],
  );
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
    resolvePublicAddresses('fixture.invalid', async () => [{ address: '127.0.0.1', family: 4 }]),
    /DNS 解析到非公网地址/,
  );
});

test('every redirect target is revalidated against private and metadata ranges', async () => {
  for (const location of ['http://localhost/private', 'http://169.254.169.254/latest/meta-data/']) {
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    });
    const port = await listen(redirector);
    await assert.rejects(
      fetchWithProxyPolicy(`http://127.0.0.1:${port}/start`, {}, 'trusted-private', ['127.0.0.1']),
      /公网地址/,
    );
    await new Promise((resolve) => redirector.close(resolve));
  }
  await assert.rejects(
    assertPublicUrl('http://fixture.invalid/browser', async () => [{ address: '127.0.0.1', family: 4 }]),
    /非公网地址/,
  );
});

test('browser safe proxy blocks private HTTP and HTTPS CONNECT targets at the socket boundary', async (t) => {
  const proxy = await createBrowserSafeProxy();
  t.after(() => proxy.close());
  const port = Number(new URL(proxy.url).port);
  const plain = await request(port, 'http://127.0.0.1/private');
  assert.equal(plain.status, 403);
  assert.match(plain.body.toString(), /公网|DNS/);
  assert.equal(await connectRequest(port, '169.254.169.254:443'), 403);
  assert.equal(await connectRequest(port, '[::1]:443'), 403);
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

test('media proxy preserves valid 206 range semantics', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.range, 'bytes=2-3');
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': 'bytes 2-3/10',
      'Content-Length': '2',
      'Accept-Ranges': 'bytes',
    });
    res.end('23');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const app = express();
  app.get('/proxy', (req, res) => proxyHttpUpstream(req, res, {
    url: `http://127.0.0.1:${upstreamPort}/video`,
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    logTag: 'range-test',
    errorMessage: 'failed',
  }));
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const response = await request(gatewayPort, '/proxy', { Range: 'bytes=2-3' });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 2-3/10');
  assert.equal(response.headers['content-length'], '2');
  assert.equal(response.body.toString(), '23');
});

test('media proxy stops when an upstream ignores Range instead of relaying the whole file', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '1000000' });
    res.end(Buffer.alloc(1000000));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const app = express();
  app.get('/proxy', (req, res) => proxyHttpUpstream(req, res, {
    url: `http://127.0.0.1:${upstreamPort}/video`,
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    logTag: 'range-test',
    errorMessage: 'failed',
  }));
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const response = await request(gatewayPort, '/proxy', { Range: 'bytes=100-200' });
  assert.equal(response.status, 502);
  assert.equal(response.headers['accept-ranges'], undefined);
  assert.match(response.body.toString(), /忽略 Range/);
});

test('media proxy permits only bytes=0- to degrade to honest sequential streaming', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '12' });
    res.end('sequential12');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const app = express();
  app.get('/proxy', (req, res) => proxyHttpUpstream(req, res, {
    url: `http://127.0.0.1:${upstreamPort}/video`,
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    logTag: 'sequential-test',
    errorMessage: 'failed',
  }));
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const response = await request(gatewayPort, '/proxy', { Range: 'bytes=0-' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['accept-ranges'], undefined, 'gateway must not invent seek support');
  assert.equal(response.headers['content-range'], undefined);
  assert.equal(response.body.toString(), 'sequential12');
});

test('media magic fixtures identify manifests and common direct containers', () => {
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
  const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from('matroska')]);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from('webm')]);
  const ts = Buffer.alloc(377); ts[0] = ts[188] = ts[376] = 0x47;
  const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]);
  const wmv = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
  assert.equal(sniffMediaMagic(mp4).container, 'mp4');
  assert.equal(sniffMediaMagic(mkv).container, 'mkv');
  assert.equal(sniffMediaMagic(webm).container, 'webm');
  assert.equal(sniffMediaMagic(Buffer.from('FLV\x01')).container, 'flv');
  assert.equal(sniffMediaMagic(ts).container, 'ts');
  assert.equal(sniffMediaMagic(avi).container, 'avi');
  assert.equal(sniffMediaMagic(wmv).container, 'wmv');
  assert.equal(sniffMediaMagic(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3')).container, 'hls');
  const drm = sniffMediaMagic(Buffer.from('<MPD><ContentProtection schemeIdUri="urn:uuid:edef8ba9"/></MPD>'));
  assert.equal(drm.container, 'dash');
  assert.deepEqual(drm.drm, ['Widevine', 'CENC']);
  assert.deepEqual(
    sniffMediaMagic(Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"')).drm,
    [],
  );
  assert.deepEqual(
    sniffMediaMagic(Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery"')).drm,
    ['FairPlay'],
  );
  assert.equal(containerFromContentType('video/x-matroska'), 'mkv');
  assert.equal(containerFromContentType('video/x-msvideo'), 'avi');
  assert.equal(containerFromContentType('video/x-ms-wmv'), 'wmv');
  assert.equal(containerFromUrl('https://cdn.example/path/movie.mpd?sig=abc'), 'dash');
});

test('a hanging HEAD still performs a fresh successful Range probe', async (t) => {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
  const methods = [];
  const upstream = http.createServer((req, res) => {
    methods.push(req.method);
    if (req.method === 'HEAD') return;
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${body.length - 1}/99` });
    res.end(body);
  });
  const port = await listen(upstream); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const descriptor = await probeMediaUrl(`http://127.0.0.1:${port}/slow`, {
    targetPolicy: 'trusted-private', trustedPrivateHosts: ['127.0.0.1'], headTimeoutMs: 20, timeoutMs: 500,
  });
  assert.equal(descriptor.container, 'mp4');
  assert.deepEqual(methods, ['HEAD', 'GET']);
});

test('HTML evidence overrides misleading media suffixes', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><title>Cloudflare challenge</title></html>');
  });
  const port = await listen(upstream); t.after(() => upstream.close());
  for (const suffix of ['fake.mp4', 'fake.m3u8', 'fake.mpd']) {
    const descriptor = await probeMediaUrl(`http://127.0.0.1:${port}/${suffix}`, {
      targetPolicy: 'trusted-private', trustedPrivateHosts: ['127.0.0.1'],
    });
    assert.equal(descriptor.container, 'unknown', suffix);
    assert.equal(descriptor.probe.magic, 'HTML', suffix);
  }
});

test('extensionless probe uses Range GET after HEAD 403 and preserves anti-hotlink headers', async (t) => {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
  const upstream = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(403); res.end(); return; }
    assert.equal(req.headers.range, 'bytes=0-65535');
    assert.equal(req.headers.referer, 'https://page.example/movie');
    assert.equal(req.headers.origin, 'https://page.example');
    assert.equal(req.headers.cookie, 'session=required');
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes 0-${body.length - 1}/9000`,
    });
    res.end(body);
  });
  const port = await listen(upstream); t.after(() => upstream.close());
  const descriptor = await probeMediaUrl(`http://127.0.0.1:${port}/play?id=123&sig=abc`, {
    targetPolicy: 'trusted-private', trustedPrivateHosts: ['127.0.0.1'],
    headers: { Referer: 'https://page.example/movie', Origin: 'https://page.example', Cookie: 'session=required' },
  });
  assert.equal(descriptor.container, 'mp4');
  assert.equal(descriptor.rangeSupported, true);
  assert.equal(descriptor.contentLength, 9000);
  assert.match(descriptor.probe.warnings.join(' '), /HEAD returned 403/);
});

test('probe follows multiple safe redirects and preserves a signed query string', async (t) => {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/start?signature=keep-me') {
      res.writeHead(302, { Location: '/middle?signature=keep-me' }); res.end(); return;
    }
    if (req.url === '/middle?signature=keep-me') {
      res.writeHead(307, { Location: '/asset?signature=keep-me' }); res.end(); return;
    }
    assert.equal(req.url, '/asset?signature=keep-me');
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes 0-${body.length - 1}/12345`,
    });
    res.end(body);
  });
  const port = await listen(upstream); t.after(() => upstream.close());
  const descriptor = await probeMediaUrl(`http://127.0.0.1:${port}/start?signature=keep-me`, {
    targetPolicy: 'trusted-private', trustedPrivateHosts: ['127.0.0.1'],
  });
  assert.equal(descriptor.container, 'mp4');
  assert.match(descriptor.finalUrl, /\/asset\?signature=keep-me$/);
  assert.equal(descriptor.contentLength, 12345);
});

test('probe caps a no-Range response and reports that seek is unsupported', async (t) => {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(100000)]);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  const port = await listen(upstream); t.after(() => upstream.close());
  const descriptor = await probeMediaUrl(`http://127.0.0.1:${port}/extensionless`, {
    targetPolicy: 'trusted-private', trustedPrivateHosts: ['127.0.0.1'],
  });
  assert.equal(descriptor.container, 'mp4');
  assert.equal(descriptor.rangeSupported, false);
  assert.equal(descriptor.probe.bytesRead, 65536);
  assert.match(descriptor.probe.warnings.join(' '), /忽略 Range/);
});

test('playback planner prefers remux and audio-only transcode over full video transcode', () => {
  const base = {
    sourceType: 'fixture', resolver: 'test', input: 'fixture', originalUrl: 'https://example/media',
    finalUrl: 'https://example/media', transport: 'direct', contentType: 'video/x-matroska',
    rangeSupported: true, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
  };
  const remux = planPlayback({ ...base, container: 'mkv', videoCodec: 'h264', audioCodec: 'aac' });
  assert.equal(remux.mode, 'remux'); assert.equal(remux.videoAction, 'copy');
  const audioOnly = planPlayback({ ...base, container: 'mkv', videoCodec: 'h264', audioCodec: 'dts' });
  assert.equal(audioOnly.mode, 'audio-transcode'); assert.equal(audioOnly.videoAction, 'copy');
  assert.equal(audioOnly.audioAction, 'transcode-aac');
  const drm = planPlayback({ ...base, container: 'dash', transport: 'dash', drm: { protected: true, systems: ['Widevine'] } });
  assert.equal(drm.engine, 'blocked');
});

test('playback planner fixture matrix covers direct containers and streaming engines', () => {
  const base = {
    sourceType: 'fixture', resolver: 'test', input: 'fixture', originalUrl: 'https://example/media',
    finalUrl: 'https://example/media', transport: 'direct', contentType: 'application/octet-stream',
    rangeSupported: true, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
  };
  for (const fixture of [
    { name: 'MP4 H264/AAC', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', engine: 'direct', mode: 'direct' },
    { name: 'MP4 HEVC', container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac', engine: 'direct', mode: 'direct' },
    { name: 'WebM', container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', engine: 'direct', mode: 'direct' },
    { name: 'MKV H264/AAC', container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', engine: 'playsvideo', mode: 'remux' },
    { name: 'MKV H264/DTS', container: 'mkv', videoCodec: 'h264', audioCodec: 'dts', engine: 'playsvideo', mode: 'audio-transcode' },
    { name: 'TS', container: 'ts', videoCodec: 'h264', audioCodec: 'aac', engine: 'playsvideo', mode: 'remux' },
    { name: 'FLV', container: 'flv', transport: 'flv', engine: 'flv', mode: 'manifest' },
    { name: 'HLS', container: 'hls', transport: 'hls', engine: 'hls', mode: 'manifest' },
    { name: 'DASH', container: 'dash', transport: 'dash', engine: 'dash', mode: 'manifest' },
  ]) {
    const plan = planPlayback({ ...base, ...fixture });
    assert.equal(plan.engine, fixture.engine, fixture.name);
    assert.equal(plan.mode, fixture.mode, fixture.name);
  }
  assert.equal(planPlayback({ ...base, container: 'dash', transport: 'dash' }, { mediaSource: false }).engine, 'blocked');
  assert.equal(planPlayback({ ...base, container: 'hls', transport: 'hls' }, { nativeHls: false, mediaSource: false }).engine, 'blocked');
  assert.equal(planPlayback({ ...base, container: 'mkv', audioCodec: 'dts' }, { playsvideo: false }).engine, 'blocked');
  assert.match(
    planPlayback({ ...base, container: 'mkv', rangeSupported: false }).reasons.join(' '),
    /不支持 Range/,
  );
  assert.match(
    planPlayback({ ...base, container: 'mp4', rangeSupported: false }).reasons.join(' '),
    /不支持 seek/,
  );
  assert.equal(planPlayback({ ...base, container: 'mp4', videoCodec: 'hevc' }, { hevc: false }).engine, 'blocked');
});

test('encrypted media handles hide credentials, reject tampering and enforce user scope', () => {
  const issued = issueMediaHandle({
    url: 'https://cdn.example/video?token=super-secret',
    scope: 'user:7', headers: { Cookie: 'session=secret' },
  });
  assert.equal(issued.url.includes('super-secret'), false);
  assert.equal(issued.url.includes('session=secret'), false);
  assert.equal(resolveMediaHandle(issued.id, '8'), undefined);
  assert.equal(resolveMediaHandle(`${issued.id.slice(0, -1)}x`, '7'), undefined);
  assert.equal(resolveMediaHandle(issued.id, '7').url, 'https://cdn.example/video?token=super-secret');

  const room = issueMediaHandle({ url: 'https://cdn.example/room.mp4', scope: 'room:abc' });
  assert.equal(resolveMediaHandle(room.id, '8'), undefined);
});

test('Bilibili media policy survives encrypted handles and reaches both CDN tracks', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': req.url.includes('audio') ? 'audio/mp4' : 'video/mp4' });
    res.end('track');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const policy = getBilibiliMediaHeaders();
  const video = issueMediaHandle({ url: `http://127.0.0.1:${upstreamPort}/video`, scope: 'user:7', headers: policy });
  const audio = issueMediaHandle({ url: `http://127.0.0.1:${upstreamPort}/audio`, scope: 'user:7', headers: policy });
  const app = express();
  for (const [path, handle] of [['/video', video], ['/audio', audio]]) {
    app.get(path, (req, res) => proxyHttpUpstream(req, res, {
      url: resolveMediaHandle(handle.id, '7').url,
      targetPolicy: 'trusted-private',
      trustedPrivateHosts: ['127.0.0.1'],
      headers: { extra: resolveMediaHandle(handle.id, '7').headers },
      logTag: 'bilibili-policy-test',
      errorMessage: 'failed',
    }));
  }
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  assert.equal((await request(gatewayPort, '/video')).status, 200);
  assert.equal((await request(gatewayPort, '/audio')).status, 200);
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers.referer, 'https://www.bilibili.com/');
    assert.equal(headers.origin, 'https://www.bilibili.com');
    assert.equal(headers['user-agent'], policy['User-Agent']);
    assert.equal(headers.cookie, undefined);
  }
});

test('room media handles require a live socket capability and never trust userId=0', async () => {
  const roomHandle = issueMediaHandle({ url: 'https://cdn.example/movie', scope: 'room:alpha' });
  const ownerGrantToken = issueRoomMediaGrant('alpha', 'owner-socket');
  const viewerGrantToken = issueRoomMediaGrant('alpha', 'viewer-socket');
  const otherRoomGrantToken = issueRoomMediaGrant('beta', 'other-socket');
  const active = new Set(['alpha:owner-socket', 'alpha:viewer-socket', 'beta:other-socket']);
  const check = async (roomId, socketId) => active.has(`${roomId}:${socketId}`);

  const ownerGrant = await authorizeRoomMediaGrant(ownerGrantToken, 'alpha', check);
  const viewerGrant = await authorizeRoomMediaGrant(viewerGrantToken, 'alpha', check);
  const otherGrant = await authorizeRoomMediaGrant(otherRoomGrantToken, 'alpha', check);
  assert.ok(resolveMediaHandle(roomHandle.id, '7', ownerGrant));
  assert.ok(resolveMediaHandle(roomHandle.id, '8', viewerGrant));
  assert.equal(resolveMediaHandle(roomHandle.id, '9'), undefined, 'non-member cannot use a stolen handle');
  assert.equal(resolveMediaHandle(roomHandle.id, '0'), undefined, 'guest userId does not grant room access');
  assert.equal(otherGrant, undefined, 'membership in another room is not sufficient');

  active.delete('alpha:viewer-socket');
  assert.equal(
    await authorizeRoomMediaGrant(viewerGrantToken, 'alpha', check),
    undefined,
    'kick/leave revokes new requests immediately',
  );
  assert.equal(resolveRoomMediaGrant(`${ownerGrantToken.slice(0, -1)}x`), undefined);
});

test('public media descriptor strips upstream headers and signed candidate URLs', () => {
  const descriptor = {
    sourceType: 'web-page', resolver: 'generic-web', input: 'https://watch.example/movie',
    originalUrl: 'https://watch.example/movie', finalUrl: 'https://cdn.example/video?token=secret',
    transport: 'direct', container: 'mp4', contentType: 'video/mp4',
    headers: { Cookie: 'session=secret' },
    candidates: [{ url: 'https://cdn.example/video?token=secret', score: 100, reason: 'main' }],
    drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
  };
  const safe = toPublicDescriptor(descriptor, '/api/stream/media/opaque');
  assert.equal(safe.finalUrl, '/api/stream/media/opaque');
  assert.equal('headers' in safe, false);
  assert.equal('candidates' in safe, false);
  assert.equal(JSON.stringify(safe).includes('session=secret'), false);
  assert.equal(JSON.stringify(safe).includes('token=secret'), false);
});

test('generic page extraction combines video tags, JSON-LD and player config while penalizing ads', () => {
  const html = `
    <html><head><title>Feature Film</title>
      <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example/main-1080.mp4?sig=1"}</script>
    </head><body>
      <video><source src="/stream/master.m3u8"></video>
      <script>window.player={file:"https:\\/\\/cdn.example\\/backup.mpd?token=2"};</script>
      <video src="https://ads.example/preroll-ad.mp4"></video>
    </body></html>`;
  const result = discoverCandidatesFromHtml(html, 'https://watch.example/movie/1');
  assert.equal(result.title, 'Feature Film');
  assert.equal(result.candidates[0].url, 'https://watch.example/stream/master.m3u8');
  assert.ok(result.candidates.some((candidate) => candidate.url.includes('main-1080.mp4')));
  assert.ok(result.candidates.some((candidate) => candidate.url.includes('backup.mpd')));
  assert.ok(result.candidates.at(-1).url.includes('preroll-ad.mp4'));
});

test('browser resolver uses complete request headers and reselects cookies for JSON-discovered URLs', async () => {
  const captured = safeForwardHeaders({
    referer: 'https://watch.example/movie',
    origin: 'https://watch.example',
    'user-agent': 'fixture-browser',
    cookie: 'page_session=secret',
    authorization: 'Bearer api-secret',
  });
  assert.equal(captured.Cookie, 'page_session=secret', 'actual media requests retain their browser Cookie');
  assert.equal('Authorization' in captured, false);

  let cookieLookupUrl = '';
  const discovered = await headersForJsonCandidate(
    'https://cdn.example/protected/video.mp4',
    {
      referer: 'https://watch.example/movie',
      origin: 'https://api.example',
      'user-agent': 'fixture-browser',
      cookie: 'api_session=must-not-leak',
      authorization: 'Bearer api-secret',
    },
    {
      async cookies(url) {
        cookieLookupUrl = url;
        return [{ name: 'cdn_session', value: 'allowed' }];
      },
    },
  );
  assert.equal(cookieLookupUrl, 'https://cdn.example/protected/video.mp4');
  assert.equal(discovered.Cookie, 'cdn_session=allowed');
  assert.equal(JSON.stringify(discovered).includes('api_session'), false);
  assert.equal(JSON.stringify(discovered).includes('api-secret'), false);
  assert.equal(discovered.Origin, undefined, 'API request Origin is not copied to another destination');
});

test('browser resolver never buffers JSON when Content-Length is absent or above the cap', async () => {
  let bodyCalls = 0;
  const response = (headers) => ({
    headers: () => headers,
    body: async () => { bodyCalls += 1; return Buffer.from('{}'); },
  });
  assert.equal(await readBoundedJsonBody(response({ 'content-type': 'application/json' })), undefined);
  assert.equal(await readBoundedJsonBody(response({ 'content-length': String(1024 * 1024 + 1) })), undefined);
  assert.equal(bodyCalls, 0);
  assert.deepEqual(await readBoundedJsonBody(response({ 'content-length': '2' })), {});
  assert.equal(bodyCalls, 1);
});

test('media gateway rewrites HLS resources and preserves DASH segment templates', () => {
  const resource = {
    url: 'https://cdn.example/path/master.m3u8', scope: 'room:abc',
    headers: { Referer: 'https://watch.example/' }, expiresAt: Date.now() + 60_000,
  };
  const hls = rewriteManifest(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nsegment-1.ts',
    'application/vnd.apple.mpegurl', resource, { id: 'unused' },
  );
  assert.equal(hls.includes('segment-1.ts'), false);
  assert.equal(hls.includes('key.bin'), false);
  assert.match(hls, /\/api\/stream\/media\//);

  const extensionlessMaster = rewriteManifest(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant?id=720\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio?id=1"',
    'application/vnd.apple.mpegurl', resource, { id: 'unused' },
  );
  const childIds = [...extensionlessMaster.matchAll(/\/api\/stream\/media\/([^?"\n]+)/g)].map((match) => match[1]);
  assert.equal(childIds.length, 2);
  const roomGrant = resolveRoomMediaGrant(issueRoomMediaGrant('abc', 'fixture-socket'));
  assert.equal(resolveMediaHandle(childIds[0], '7', roomGrant)?.rewriteManifest, true);
  assert.equal(resolveMediaHandle(childIds[1], '7', roomGrant)?.rewriteManifest, true);

  const dashResource = {
    ...resource,
    url: 'https://cdn.example/root/manifest.mpd',
    headers: { Cookie: 'session=same-origin', Referer: 'https://watch.example/' },
    credentialOrigins: ['https://cdn.example'],
  };
  const dash = rewriteManifest(
    '<MPD><BaseURL>../media/</BaseURL><Period><BaseURL>period/</BaseURL><AdaptationSet><BaseURL>video/</BaseURL><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/><Representation id="v1"><BaseURL>1080/</BaseURL></Representation></AdaptationSet></Period></MPD>',
    'application/dash+xml', dashResource, { id: 'opaque-token', token: 'viewer-token', roomGrant: issueRoomMediaGrant('abc', 'dash-socket') },
  );
  assert.equal(dash.includes('<BaseURL>'), false, 'all inherited BaseURL nodes are materialized');
  assert.match(dash, /\$RepresentationID\$/);
  assert.match(dash, /\$Number\$/);
  assert.match(dash, /token=viewer-token/);
  assert.match(dash, /roomGrant=/);

  const mediaAttribute = dash.match(/media="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const mediaUrl = new URL(mediaAttribute, 'https://gateway.example');
  const dashChildId = mediaUrl.pathname.split('/').at(-2);
  const dashGrant = resolveRoomMediaGrant(mediaUrl.searchParams.get('roomGrant'));
  const dashChild = resolveMediaHandle(dashChildId, '7', dashGrant);
  assert.equal(dashChild.url, 'https://cdn.example/media/period/video/1080/');
  assert.equal(dashChild.headers.Cookie, 'session=same-origin');
  assert.equal(
    new URL(mediaUrl.searchParams.get('path').replace('$Number$', '3'), dashChild.url).toString(),
    'https://cdn.example/media/period/video/1080/chunk-3.m4s',
  );

  const segmentListDash = rewriteManifest(
    '<MPD><BaseURL>../media/</BaseURL><Period><AdaptationSet><BaseURL>audio/</BaseURL><SegmentList><Initialization sourceURL="init.m4a"/><SegmentURL media="seg-1.m4s"/></SegmentList><Representation id="a1"><BaseURL>en/</BaseURL></Representation></AdaptationSet></Period></MPD>',
    'application/dash+xml', dashResource, { id: 'unused' },
  );
  const listUrls = [...segmentListDash.matchAll(/(?:sourceURL|media)="([^"]+)"/g)]
    .map((match) => match[1].replaceAll('&amp;', '&'));
  assert.equal(listUrls.length, 2);
  const listResources = listUrls.map((url) => {
    const parsed = new URL(url, 'https://gateway.example');
    return resolveMediaHandle(parsed.pathname.split('/').at(-1), '7', roomGrant);
  });
  assert.deepEqual(
    listResources.map((child) => child.url),
    [
      'https://cdn.example/media/audio/en/init.m4a',
      'https://cdn.example/media/audio/en/seg-1.m4s',
    ],
  );

  const redirectedDash = rewriteManifest(
    '<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    'application/dash+xml', {
      ...dashResource,
      url: 'https://redirected.example/final/manifest.mpd',
      headers: { Referer: 'https://watch.example/' },
    }, { id: 'unused' },
  );
  const redirectedId = redirectedDash.match(/\/api\/stream\/media\/([^/]+)\/asset/)[1];
  const redirectedChild = resolveMediaHandle(redirectedId, '7', roomGrant);
  assert.equal(redirectedChild.url, 'https://redirected.example/final/manifest.mpd');
  assert.equal(redirectedChild.headers.Cookie, undefined, 'redirected origin cannot regain the source cookie');
});

test('manifest rewrite detection distinguishes MPD from Bilibili dual m4s DASH', () => {
  const base = {
    sourceType: 'fixture', resolver: 'test', input: 'fixture', originalUrl: 'https://example/media',
    finalUrl: 'https://example/media', transport: 'dash', container: 'dash',
    rangeSupported: true, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
  };
  assert.equal(shouldRewriteManifest({ ...base, contentType: 'video/mp4' }), false);
  assert.equal(shouldRewriteManifest({
    ...base, contentType: 'application/octet-stream', probe: { ...base.probe, magic: 'MPD XML' },
  }), true);
});
