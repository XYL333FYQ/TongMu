const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlayUrlData, CodecUnavailableError } = require('../dist/services/bilibili/playurl');
const { buildAnimeProviderReference } = require('../dist/services/media/providers/anime-provider');
const { defaultProviderRegistry } = require('../dist/services/media/providers/registry');
const { filterPlaybackCandidates } = require('../dist/services/media/viability');
const { compileRuleRegex, isSafeRuleUrl } = require('../dist/services/anisubs/rule-safety');

const h264DashProfile = {
  profileVersion: 1,
  environment: 'web',
  mediaCapabilities: [{
    transport: 'dash',
    container: 'dash',
    videoCodec: 'h264',
    audioCodec: 'aac',
    pipeline: 'mse',
    exactCodecStrings: ['avc1.640028', 'mp4a.40.2'],
    supportsCustomHeaders: true,
  }],
  supportsProviderProxy: true,
  supportsInsecureHttpMedia: true,
  mixedContentRestricted: false,
  subtitlePreference: 'external',
  liveTransports: ['hls', 'flv'],
};

function dashData(videos) {
  return {
    quality: 80,
    dash: {
      video: videos,
      audio: [{ id: 30280, bandwidth: 128000, codecs: 'mp4a.40.2', base_url: 'https://cdn.example/audio' }],
    },
  };
}

test('Phase 2C-2 Bilibili DASH filters exact codec tuple without lowering requested quality', () => {
  const result = normalizePlayUrlData(dashData([
    { id: 80, bandwidth: 2, codecs: 'hev1.2.4.L153.90', base_url: 'https://cdn.example/hevc' },
    { id: 80, bandwidth: 1, codecs: 'avc1.640028', base_url: 'https://cdn.example/avc' },
    { id: 64, bandwidth: 3, codecs: 'avc1.64001f', base_url: 'https://cdn.example/720' },
  ]), 80, undefined, h264DashProfile);
  assert.equal(result.currentQn, 80);
  assert.equal(result.bestVideo.codecs, 'avc1.640028');
  assert.equal(result.bestAudio.codecs, 'mp4a.40.2');
});

test('Phase 2C-2 rejects an unsupported exact tuple instead of silently selecting 720P', () => {
  assert.throws(() => normalizePlayUrlData(dashData([
    { id: 80, bandwidth: 2, codecs: 'hev1.2.4.L153.90', base_url: 'https://cdn.example/hevc' },
    { id: 64, bandwidth: 3, codecs: 'avc1.64001f', base_url: 'https://cdn.example/720' },
  ]), 80, undefined, h264DashProfile), CodecUnavailableError);
});

test('anime provider references retain stable selectors but never persist media URLs or credentials', () => {
  const reference = buildAnimeProviderReference('anisubs', 'source-a', {
    id: 'ep-1', title: 'Episode 1', episodeNumber: 1,
    playbackParams: {
      episodeUrl: 'https://provider.example/episode/1',
      url: 'https://cdn.example/temporary.m3u8?token=secret',
      token: 'secret',
    },
  });
  assert.match(reference, /^provider:\/\/anisubs\?/);
  assert.match(reference, /episodeUrl/);
  assert.equal(reference.includes('temporary.m3u8'), false);
  assert.equal(reference.includes('secret'), false);
});

test('public HLS/HTTP-FLV live sources have an explicit provider and profile gate', () => {
  const providers = defaultProviderRegistry();
  assert.ok(providers.some((provider) => provider.id === 'anisubs'));
  assert.ok(providers.some((provider) => provider.id === 'kazumi'));
  const live = providers.find((provider) => provider.id === 'live');
  assert.ok(live);
  assert.equal(live.canHandle('https://stream.example/live.m3u8'), true);
  assert.equal(live.canHandle('https://stream.example/live.flv'), true);
  const result = filterPlaybackCandidates(
    { transport: 'hls', container: 'hls', isLive: true, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] } },
    [{ mode: 'FULL_PROXY', url: 'https://stream.example/live.m3u8', transport: 'hls', container: 'hls', requiredPipelines: ['mse'] }],
    { ...h264DashProfile, liveTransports: [] },
  );
  assert.equal(result.viable.length, 0);
  assert.equal(result.removed[0].reason, 'unsupported-transport');
});

test('imported anime rules stay bounded before regex and URL evaluation', () => {
  assert.equal(compileRuleRegex('(a+)+$'), undefined);
  assert.equal(compileRuleRegex('a'.repeat(513)), undefined);
  assert.equal(compileRuleRegex('(a)\\1'), undefined);
  assert.equal(isSafeRuleUrl('file:///etc/passwd'), false);
  assert.equal(isSafeRuleUrl('https://user:pass@example.com/rule.json'), false);
  assert.equal(isSafeRuleUrl('https://example.com/rule.json'), true);
});
