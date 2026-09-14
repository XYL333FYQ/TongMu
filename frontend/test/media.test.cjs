const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
function load(file, imports = {}, directory = path.join(__dirname, '../src/modules/media')) {
  const source = fs.readFileSync(path.join(directory, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(name => imports[name] ?? {}, module, module.exports);
  return module.exports;
}
const playbackProfile = load('playbackProfile.ts');
const { planPlayback } = load('localPlanner.ts', { './playbackProfile': playbackProfile });
const media = { drm: { protected: false }, transport: 'dash', container: 'dash', videoCodec: 'hvc1.1.6.L93.B0' };
test('each client independently plans the same shared HEVC DASH media', () => {
  assert.equal(planPlayback(media, { mediaSource: true, hevc: true }).engine, 'dash');
  assert.equal(planPlayback(media, { mediaSource: true, hevc: false }).engine, 'blocked');
  assert.equal(planPlayback({ ...media, transport: 'hls' }, { nativeHls: true, mediaSource: false, hevc: true }).engine, 'hls');
  assert.equal(planPlayback(media, { mediaSource: false, hevc: true }).engine, 'blocked');
});
test('local and server planners agree on supported client capability matrix', () => {
  const server = load('planner.ts', {}, path.join(__dirname, '../../backend/src/services/media'));
  for (const transport of ['direct','hls','dash','flv']) for (const hevc of [true,false]) for (const mediaSource of [true,false]) {
    const descriptor = { ...media, transport };
    const caps = { hevc, mediaSource, nativeHls: false, playsvideo: true };
    assert.deepEqual(planPlayback(descriptor, caps), server.planPlayback(descriptor, caps));
  }
});
class Video extends EventTarget {
  currentTime = 0; paused = true; playbackRate = 1; dataset = {}; error = null;
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}
const newTransport = () => load('transport.ts', { '@/lib/api': { getApiUrl: () => 'https://app.example' } });
const descriptor = { finalUrl: 'https://cdn.example/4k', actualQuality: 120, transportPlan: { candidates: [{ mode: 'DIRECT', url: 'https://cdn.example/4k' }, { mode: 'FULL_PROXY', url: '/api/stream/media/same-4k' }] } };
test('initial direct attach failure retries exact same quality and start position through proxy', async () => {
  const { registerMediaTransport, withMediaTransport } = newTransport();
  registerMediaTransport(descriptor);
  const calls = [];
  const engine = { type: 'direct', async attach(video, source) { calls.push(source); video.currentTime = 0; if (calls.length === 1) throw new Error('network'); return { cleanup() {} }; } };
  const video = new Video(); video.paused = false; video.playbackRate = 1.5;
  const result = await withMediaTransport(engine).attach(video, { url: descriptor.finalUrl, startTime: 42, format: 'mp4', videoCodec: 'avc1' });
  assert.equal(calls.length, 2); assert.equal(calls[1].url, 'https://app.example/api/stream/media/same-4k');
  assert.equal(calls[1].videoCodec, 'avc1'); assert.equal(calls[1].startTime, 42);
  assert.equal(video.currentTime, 42); assert.equal(video.paused, false); assert.equal(video.playbackRate, 1.5);
  result.cleanup();
});
test('runtime direct network failure retains currentTime, paused state, speed and bounds retries', async () => {
  const { registerMediaTransport, withMediaTransport } = newTransport(); registerMediaTransport(descriptor);
  let calls = 0, cleanups = 0;
  const engine = { type: 'direct', async attach(video) { calls++; video.currentTime = 0; return { cleanup() { cleanups++; } }; } };
  const video = new Video(); const result = await withMediaTransport(engine).attach(video, { url: descriptor.finalUrl });
  video.currentTime = 81; video.playbackRate = 2; video.paused = true;
  video.dispatchEvent(new Event('error')); await new Promise(setImmediate);
  assert.equal(video.currentTime, 81); assert.equal(video.paused, true); assert.equal(video.playbackRate, 2); assert.equal(calls, 2);
  video.dispatchEvent(new Event('error')); await new Promise(setImmediate); assert.equal(calls, 2);
  result.cleanup(); assert.equal(cleanups, 2);
});

test('native HLS uses assisted single-quality master instead of uncontrolled native ABR', async () => {
  const previous = globalThis.window; globalThis.window = {};
  try {
    const { registerMediaTransport, withMediaTransport } = load('transport.ts', { '@/lib/api': { getApiUrl: () => 'https://app.example' }, 'hls.js': { default: { isSupported: () => false } } });
    registerMediaTransport({ ...descriptor, transport: 'hls', transportPlan: { candidates: [...descriptor.transportPlan.candidates.slice(0, 1), { mode: 'MANIFEST_ASSISTED', url: '/api/stream/media/highest' }] } });
    const calls = [];
    const result = await withMediaTransport({ type: 'hls', async attach(_video, source) { calls.push(source.url); return { cleanup() {} }; } }).attach(new Video(), { url: descriptor.finalUrl });
    assert.deepEqual(calls, ['https://app.example/api/stream/media/highest']); result.cleanup();
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('V1 profile matching keeps codec tuples together and preserves the selected route', () => {
  const profile = {
    profileVersion: 1,
    environment: 'web',
    mediaCapabilities: [
      { transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', pipeline: 'native', supportsCustomHeaders: false },
      { transport: 'progressive', container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', pipeline: 'native', supportsCustomHeaders: false },
    ],
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: true,
    mixedContentRestricted: false,
    subtitlePreference: 'embedded-or-external',
    liveTransports: [],
  };
  const h264 = {
    drm: { protected: false }, transport: 'direct', container: 'mp4',
    videoCodec: 'h264', audioCodec: 'aac', actualQuality: 1080,
    finalUrl: 'https://cdn.example/h264',
  };
  const selected = planPlayback(h264, profile, [
    { mode: 'DIRECT', url: h264.finalUrl },
    { mode: 'FULL_PROXY', url: '/api/stream/media/h264' },
  ]);
  assert.equal(selected.engine, 'direct');
  assert.equal(selected.candidateMode, 'DIRECT');
  assert.equal(selected.candidateUrl, h264.finalUrl);

  const splitTuple = planPlayback({ ...h264, audioCodec: 'opus' }, profile, [
    { mode: 'DIRECT', url: 'https://cdn.example/split' },
  ]);
  assert.equal(splitTuple.engine, 'blocked');
});

test('empty V1 capabilities are an explicit no-support profile', () => {
  const profile = {
    profileVersion: 1,
    environment: 'web',
    mediaCapabilities: [],
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: true,
    mixedContentRestricted: false,
    subtitlePreference: 'none',
    liveTransports: [],
  };
  const result = planPlayback({
    drm: { protected: false }, transport: 'direct', container: 'mp4',
    videoCodec: 'h264', audioCodec: 'aac', finalUrl: 'https://cdn.example/empty',
  }, profile, [{ mode: 'DIRECT', url: 'https://cdn.example/empty' }]);
  assert.equal(result.engine, 'blocked');
});

test('browser capability collector is bounded and fingerprints deterministically', () => {
  const previous = {
    document: global.document,
    MediaSource: global.MediaSource,
    ManagedMediaSource: global.ManagedMediaSource,
    Worker: global.Worker,
    window: global.window,
    location: global.location,
    RTCPeerConnection: global.RTCPeerConnection,
  };
  class FakeVideo {
    canPlayType(mime) { return /video\/(?:mp4|webm)|mpegurl/.test(mime) ? 'probably' : ''; }
  }
  global.document = { createElement: () => new FakeVideo() };
  global.MediaSource = { isTypeSupported: (mime) => /video\/(?:mp4|webm)/.test(mime) };
  global.ManagedMediaSource = undefined;
  global.Worker = class {};
  global.window = {};
  global.location = { protocol: 'https:' };
  global.RTCPeerConnection = undefined;
  try {
    const profile = playbackProfile.collectPlaybackClientProfileSync();
    assert.equal(profile.profileVersion, 1);
    assert.equal(profile.environment, 'web');
    assert.equal(profile.mixedContentRestricted, true);
    assert.equal(profile.supportsInsecureHttpMedia, false);
    assert.ok(profile.mediaCapabilities.length > 0);
    assert.ok(profile.mediaCapabilities.length <= 64);
    assert.ok(profile.mediaCapabilities.some((item) => item.videoCodec === 'h264' && item.audioCodec === 'aac'));
    const reversed = { ...profile, mediaCapabilities: [...profile.mediaCapabilities].reverse(), liveTransports: [...profile.liveTransports].reverse() };
    assert.equal(
      playbackProfile.playbackClientProfileFingerprint(profile),
      playbackProfile.playbackClientProfileFingerprint(reversed),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
});
