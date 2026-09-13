const test = require('node:test');
const assert = require('node:assert/strict');
const { canDirect, publicMetadata } = require('../dist/services/media/protocol');
const { toPublicDescriptor, rewriteManifest } = require('../dist/routes/stream/media');
const { issueRoomMediaGrant, resolveRoomMediaGrant } = require('../dist/services/media/handles');
const { authorizeRoomMediaGrant } = require('../dist/services/media/room-access');
const { BilibiliResolver } = require('../dist/services/media/resolvers/bilibili');
const { BrowserResolver } = require('../dist/services/media/resolvers/browser');
const { normalizePlayUrlData } = require('../dist/services/bilibili/playurl');
const { videoIdentityParams } = require('../dist/services/bilibili/video');
const { extractBvid, resolveBilibiliVideo } = require('../dist/services/bilibili/resolver');
const { movieService } = require('../dist/modules/movie/movie.service');

const media = { finalUrl: 'https://cdn.example/movie.mp4', input: 'https://page.example/?token=private', originalUrl: 'https://page.example/?cookie=private', transport: 'direct', container: 'mp4', resolver: 'direct-url', sourceType: 'url', drm: { protected: false }, probe: { warnings: [], bytesRead: 0, method: 'resolver' } };
test('public MP4, extensionless, HLS, DASH and public signed capabilities are direct eligible', () => {
  for (const suffix of ['movie.mp4', 'extensionless', 'master.m3u8', 'manifest.mpd', 'file?signature=public&expires=123']) assert.equal(canDirect({ ...media, finalUrl: `https://cdn.example/${suffix}`, headers: {} }), true);
  for (const headers of [{ Cookie: 'private' }, { Authorization: 'private' }, { Referer: 'private' }, { 'X-Api-Key': 'private' }]) assert.equal(canDirect({ ...media, headers }), false);
  assert.equal(canDirect({ ...media, finalUrl: 'https://cdn.example/video?token=secret' }), false);
});
test('Movie DTO and descriptors omit private refresh inputs, credentials and owner playback plans', () => {
  const descriptor = { ...media, headers: { Cookie: 'private' }, playbackPlan: { nativeHls: true }, nested: { authorization: 'private', apiKey: 'private' } };
  const safe = toPublicDescriptor(descriptor, '/api/stream/media/opaque');
  assert.equal(JSON.stringify(safe).includes('private'), false);
  const dto = movieService.serializeMovie({ id: 1, roomId: 'room', url: 'https://cdn.example/video?token=private', sourceInput: media.input, password: 'private', username: 'private', serverUrl: 'https://private', mediaDescriptor: JSON.stringify(descriptor), createdAt: new Date(), updatedAt: new Date() });
  assert.equal(dto.sourceInput, 'media-movie:1');
  assert.equal(JSON.stringify(dto).includes('private'), false);
  assert.match(dto.url, /^\/api\/stream\/media\//);
  assert.equal('playbackPlan' in dto.mediaDescriptor, false);
});
test('continuous socket session renews expired grant, disconnected session cannot renew', async () => {
  const now = Date.now;
  try {
    const token = issueRoomMediaGrant('room', 'socket');
    Date.now = () => now() + 13 * 60 * 60 * 1000;
    assert.equal(resolveRoomMediaGrant(token), undefined);
    const grant = await authorizeRoomMediaGrant(token, 'room', async (room, socket) => room === 'room' && socket === 'socket');
    assert.ok(grant.expiresAt > Date.now());
    assert.equal(await authorizeRoomMediaGrant(token, 'room', async () => false), undefined);
    assert.equal(await authorizeRoomMediaGrant(token, 'different', async () => true), undefined);
  } finally { Date.now = now; }
});
test('HLS partial proxies only key and manifests, never adds app credentials to CDN segments', () => {
  const resource = { url: 'https://cdn.example/main.m3u8', scope: 'room:r', expiresAt: Date.now() + 10000, transportMode: 'PARTIAL_PROXY' };
  const result = rewriteManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:3,\nseg.m4s', 'application/vnd.apple.mpegurl', resource, { id: 'id', token: 'app-secret', roomGrant: 'grant-secret' });
  assert.match(result, /URI="\/api\/stream\/media\//);
  const segment = result.split('\n').at(-1);
  assert.equal(segment, 'https://cdn.example/seg.m4s');
});
test('Bilibili BV and av identities use distinct API keys and both short domains route to provider', () => {
  assert.deepEqual(videoIdentityParams(extractBvid('https://www.bilibili.com/video/av123456')), { aid: '123456' });
  assert.deepEqual(videoIdentityParams('BV1234567890'), { bvid: 'BV1234567890' });
  const resolver = new BilibiliResolver();
  for (const input of ['av123456', 'BV1234567890', 'https://b23.tv/test', 'https://bili2233.cn/test']) assert.equal(resolver.canHandle(input), true);
  assert.equal(resolver.canHandle('https://evil.example/bilibili.com'), false);
});
test('DASH quality is matched to actual representation and keeps same-track backup URLs', () => {
  const data = { quality: 120, dash: { video: [{ id: 64, bandwidth: 999999, codecs: 'avc1', base_url: 'https://cdn.example/720' }, { id: 120, bandwidth: 1000, codecs: 'hvc1', base_url: 'https://cdn.example/4k', backup_url: ['https://backup.example/4k'] }] } };
  const result = normalizePlayUrlData(data, 120);
  assert.equal(result.bestVideo.id, 120);
  assert.equal(result.currentQn, 120);
  assert.deepEqual(result.bestVideo.backupUrl, ['https://backup.example/4k']);
  assert.throws(() => normalizePlayUrlData({ ...data, quality: 127 }, 127), /representation/);
});
test('Bilibili explicit 4K cannot become 720P; unreachable DASH does not invoke MP4', async t => {
  const video = require('../dist/services/bilibili/video');
  const play = require('../dist/services/bilibili/playurl');
  const cdn = require('../dist/services/bilibili/cdn');
  t.mock.method(video, 'getVideoInfo', async () => ({ bvid: 'BV9876543210', cid: 1, title: 'test', duration: 3 }));
  let calls = [];
  t.mock.method(play, 'getPlayUrl', async (_id, _cid, _cookie, options) => { calls.push(options); return { format: 'dash', currentQn: 120, bestVideo: { id: 120, baseUrl: 'https://cdn.example/4k', codecs: 'avc1', bandwidth: 1000 } }; });
  t.mock.method(cdn, 'findReachableMediaUrl', async () => null);
  const result = await resolveBilibiliVideo({ url: 'BV9876543210', qn: 120 });
  assert.equal(result.format, 'dash'); assert.equal(result.currentQn, 120); assert.equal(result.requestedQn, 120);
  assert.equal(calls.length, 1); assert.notEqual(calls[0].fnval, 1);
  play.getPlayUrl.mock.mockImplementation(async () => ({ format: 'mp4', currentQn: 64, durl: [{ url: 'https://cdn.example/720' }] }));
  await assert.rejects(resolveBilibiliVideo({ url: 'BV9876543210', qn: 120 }), /源站实际只返回/);
});
test('BrowserResolver entire captured-response -> probe -> descriptor chain preserves cross-origin sanitization', async t => {
  let listener;
  const page = { route: async () => {}, on: (_event, cb) => { listener = cb; }, goto: async () => listener({ url: () => 'https://8.8.8.8/movie.mp4', headers: () => ({ 'content-type': 'video/mp4' }), request: () => ({ allHeaders: async () => ({ cookie: 'private', authorization: 'private' }) }) }), waitForTimeout: async () => {}, url: () => 'https://8.8.8.8/page' };
  const context = { newPage: async () => page, close: async () => {} };
  const runtime = { playwright: { chromium: { launch: async () => ({ newContext: async () => context, close: async () => {} }) } }, createProxy: async () => ({ url: 'http://unused', close: async () => {} }) };
  t.mock.method(require('undici'), 'fetch', async (url, options) => {
    if (String(url).startsWith('https://8.8.8.8')) return new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/movie.mp4' } });
    assert.equal(Object.keys(options.headers).some(k => /cookie|authorization/i.test(k)), false);
    return new Response(options.method === 'HEAD' ? null : Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]), { status: 200, headers: { 'content-type': 'video/mp4' } });
  });
  const result = await new BrowserResolver(runtime).resolve('https://8.8.8.8/page', { userId: '1', browserSniff: true });
  assert.equal(result.headers.Cookie, undefined);
  assert.equal(result.headers.Authorization, undefined);
  assert.deepEqual(result.credentialOrigins, []);
});

test('assisted HLS master keeps highest resolution and external audio groups without lower video variants', () => {
  const { highestHlsMaster } = require('../dist/routes/stream/media');
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1280x720,AUDIO="a"\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=3840x2160,AUDIO="a"\n4k.m3u8';
  const result = highestHlsMaster(master);
  assert.ok(result.includes('audio.m3u8'));
  assert.ok(result.includes('4k.m3u8'));
  assert.equal(result.includes('720.m3u8'), false);
});
test('DASH default Highest uses actual available quality, never marks an unavailable 8K as actual', async t => {
  const video = require('../dist/services/bilibili/video');
  const play = require('../dist/services/bilibili/playurl');
  const cdn = require('../dist/services/bilibili/cdn');
  t.mock.method(video, 'getVideoInfo', async () => ({ bvid: 'BV1111111111', cid: 1, title: 'test', duration: 3 }));
  t.mock.method(play, 'getPlayUrl', async (_id, _cid, _cookie, options) => {
    assert.equal(options.qn, 127);
    return { format: 'dash', currentQn: 80, bestVideo: { id: 80, baseUrl: 'https://cdn.example/1080', codecs: 'avc1', bandwidth: 1000 }, acceptQuality: [{ id: 120, label: '4K' }, { id: 80, label: '1080P' }] };
  });
  t.mock.method(cdn, 'findReachableMediaUrl', async () => null);
  const result = await new BilibiliResolver().resolve('BV1111111111', { userId: '1' });
  assert.equal(result.actualQuality, 80); assert.equal(result.requestedQuality, undefined);
  assert.equal(result.availableMaximumQuality, 80); assert.equal(result.sourceMaximumQuality, 120);
  assert.match(result.qualityLabel, /当前可用最高/);
});
