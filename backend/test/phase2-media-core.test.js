const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  PlaybackProfileError,
  legacyPlaybackClientProfile,
  playbackClientProfileFingerprint,
  profileSupportsCapability,
  validatePlaybackClientProfile,
} = require('../dist/services/media/playback-profile');
const { filterPlaybackCandidates } = require('../dist/services/media/viability');
const { publicMetadata } = require('../dist/services/media/protocol');
const {
  MediaProviderRegistry,
  providerContextFromResolverContext,
} = require('../dist/services/media/providers/registry');
const {
  assertProviderActive,
  providerActorForUser,
} = require('../dist/services/media/providers/types');

function profileWith(capabilities, overrides = {}) {
  return validatePlaybackClientProfile({
    profileVersion: 1,
    environment: 'web',
    mediaCapabilities: capabilities,
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: true,
    mixedContentRestricted: false,
    subtitlePreference: 'embedded-or-external',
    liveTransports: [],
    ...overrides,
  });
}

function descriptor(overrides = {}) {
  return {
    input: 'https://source.example/video.mp4',
    originalUrl: 'https://source.example/video.mp4',
    finalUrl: 'https://cdn.example/video.mp4',
    transport: 'direct',
    container: 'mp4',
    videoCodec: 'avc1.42e01e',
    audioCodec: 'mp4a.40.2',
    actualQuality: 1080,
    headers: {},
    drm: { protected: false },
    probe: { method: 'resolver', bytesRead: 0, warnings: [] },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    mode: 'DIRECT',
    url: 'https://cdn.example/video.mp4',
    transport: 'direct',
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'],
    actualQuality: 1080,
    requiredPipelines: ['native'],
    ...overrides,
  };
}

test('PlaybackClientProfile V1 defaults, empty support, bounds, and future versions are explicit', () => {
  const legacy = validatePlaybackClientProfile(undefined);
  assert.deepEqual(legacy, legacyPlaybackClientProfile());

  const empty = profileWith([]);
  assert.deepEqual(empty.mediaCapabilities, []);
  assert.throws(
    () => validatePlaybackClientProfile({ ...empty, profileVersion: 2 }),
    (error) => error instanceof PlaybackProfileError && error.code === 'UNSUPPORTED_PROFILE_VERSION',
  );
  assert.throws(
    () => validatePlaybackClientProfile({ ...empty, mediaCapabilities: Array.from({ length: 65 }, () => ({
      transport: 'progressive', container: 'mp4', pipeline: 'native', supportsCustomHeaders: false,
    })) }),
    (error) => error instanceof PlaybackProfileError && error.code === 'MALFORMED_PROFILE',
  );
  assert.throws(
    () => validatePlaybackClientProfile({ ...empty, mediaCapabilities: [{
      transport: 'progressive', container: 'mp4', pipeline: 'native', supportsCustomHeaders: false,
      exactCodecStrings: Array.from({ length: 17 }, () => 'avc1.42e01e'),
    }] }),
    (error) => error instanceof PlaybackProfileError && error.code === 'MALFORMED_PROFILE',
  );
  assert.throws(
    () => validatePlaybackClientProfile({ ...empty, mediaCapabilities: [{ transport: 'not-a-transport', container: 'mp4', pipeline: 'native', supportsCustomHeaders: false }] }),
    (error) => error instanceof PlaybackProfileError && error.code === 'MALFORMED_PROFILE',
  );
});

test('profile fingerprint is deterministic and capability matching is tuple-based', () => {
  const profile = profileWith([
    {
      transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
      pipeline: 'native', exactCodecStrings: ['mp4a.40.2', 'avc1.42e01e'], supportsCustomHeaders: false,
    },
  ]);
  const reordered = profileWith([
    {
      transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
      pipeline: 'native', exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'], supportsCustomHeaders: false,
    },
  ]);
  assert.equal(playbackClientProfileFingerprint(profile), playbackClientProfileFingerprint(reordered));
  assert.match(playbackClientProfileFingerprint(profile), /^pcp-v1-[0-9a-f]{64}$/);

  assert.equal(profileSupportsCapability(profile, {
    transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
    exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'], requiredPipelines: ['native'],
  }), true);
  assert.equal(profileSupportsCapability(profile, {
    transport: 'progressive', container: 'mp4', videoCodec: 'vp9', audioCodec: 'aac',
    exactCodecStrings: ['vp09.00.10.08', 'mp4a.40.2'], requiredPipelines: ['native'],
  }), false);
  assert.equal(profileSupportsCapability(profile, {
    transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
    exactCodecStrings: ['avc1.640028', 'mp4a.40.2'], requiredPipelines: ['native'],
  }), false);
  const tsProfile = profileWith([{
    transport: 'mpeg-ts', container: 'ts', videoCodec: 'h264', audioCodec: 'aac',
    pipeline: 'playsvideo', supportsCustomHeaders: false,
  }]);
  assert.equal(profileSupportsCapability(tsProfile, {
    transport: 'mpeg-ts', container: 'ts', videoCodec: 'h264', audioCodec: 'aac',
    requiredPipelines: ['playsvideo'],
  }), true);
});

test('server viability removes only impossible or unsafe candidates and keeps quality identity', () => {
  const profile = profileWith([
    { transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', pipeline: 'native', supportsCustomHeaders: false },
  ], { supportsProviderProxy: true, supportsInsecureHttpMedia: true, mixedContentRestricted: true });

  const media = descriptor();
  const direct = candidate({ url: 'https://cdn.example/video.mp4?token=private-secret' });
  const fullProxy = candidate({ mode: 'FULL_PROXY', url: '/api/stream/media/same-quality' });
  const result = filterPlaybackCandidates(media, [direct, fullProxy], profile, { pageProtocol: 'https' });
  assert.deepEqual(result.viable.map((item) => item.mode), ['FULL_PROXY']);
  assert.deepEqual(result.removed, [{ mode: 'DIRECT', reason: 'private-direct-url' }]);

  const mixed = filterPlaybackCandidates(
    media,
    [candidate({ url: 'http://cdn.example/video.mp4' }), fullProxy],
    profile,
    { pageProtocol: 'https' },
  );
  assert.deepEqual(mixed.viable.map((item) => item.mode), ['FULL_PROXY']);
  assert.equal(mixed.removed[0].reason, 'mixed-content');

  const badQuality = filterPlaybackCandidates(media, [candidate({ actualQuality: 720 })], profile);
  assert.deepEqual(badQuality.removed, [{ mode: 'DIRECT', reason: 'quality-mismatch' }]);

  const noProxy = filterPlaybackCandidates(media, [fullProxy], { ...profile, supportsProviderProxy: false });
  assert.deepEqual(noProxy.removed, [{ mode: 'FULL_PROXY', reason: 'provider-proxy-unavailable' }]);

  const drm = filterPlaybackCandidates({ ...media, drm: { protected: true } }, [direct], profile);
  assert.deepEqual(drm.removed, [{ mode: 'DIRECT', reason: 'drm-protected' }]);

  const publicValue = publicMetadata({
    descriptor: media,
    playbackPlan: { engine: 'direct' },
    secret: 'do-not-publish',
  });
  assert.equal(publicValue.playbackPlan, undefined);
  assert.equal(publicValue.secret, undefined);
});

test('provider context separates credentials, propagates cancellation, and enforces deadlines', async () => {
  assert.deepEqual(providerActorForUser('user-1'), { kind: 'user', userId: 'user-1' });
  assert.deepEqual(providerActorForUser(), { kind: 'guest' });

  const controller = new AbortController();
  const context = providerContextFromResolverContext({
    userId: 'user-1', signal: controller.signal, deadline: Date.now() + 10_000,
  });
  assert.equal(context.actor.kind, 'user');
  assert.equal(context.profile.profileVersion, 1);
  assert.equal(context.providerCookie, undefined);
  assert.doesNotThrow(() => assertProviderActive(context));
  controller.abort();
  assert.equal(context.signal.aborted, true);
  assert.throws(() => assertProviderActive(context), /cancelled/);
  assert.throws(() => assertProviderActive({ signal: new AbortController().signal, deadline: Date.now() - 1 }), /deadline/);

  let seenContext;
  let seenPrivate;
  const provider = {
    id: 'test-provider', sourceKinds: ['test'],
    canHandle: (input) => input.startsWith('test:'),
    validateInput: () => undefined,
    normalizeInput: (input) => input.trim(),
    credentialDependencies: () => [{ providerId: 'test-provider', owner: 'source-creator', requirement: 'optional' }],
    availability: () => ({ available: true }),
    resolve: async (providerContext, input, privateContext) => {
      seenContext = providerContext;
      seenPrivate = privateContext;
      return {
        privateSource: { input, originalUrl: input, finalUrl: 'https://cdn.example/test.mp4' },
        descriptor: descriptor({ input, originalUrl: input }),
        candidates: [candidate()],
      };
    },
  };
  const registry = new MediaProviderRegistry([provider]);
  const resolved = await registry.resolve('test:source', {
    ...context,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
  }, { providerCookie: 'private-cookie' });
  assert.equal(resolved.input, 'test:source');
  assert.equal(seenContext.providerCookie, undefined);
  assert.equal(seenPrivate.providerCookie, 'private-cookie');
  const fullResolution = await registry.resolveProvider('test:source', {
    ...context,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
  }, { providerCookie: 'private-cookie' });
  assert.equal(fullResolution.privateSource.finalUrl, 'https://cdn.example/test.mp4');
  assert.equal(fullResolution.candidates[0].mode, 'DIRECT');
  assert.throws(() => registry.register(provider), /duplicate media provider/);
});

test('media resolve route no longer returns or invokes a server PlaybackPlan', () => {
  const source = fs.readFileSync(require('node:path').resolve(__dirname, '../src/routes/stream/media.ts'), 'utf8');
  assert.doesNotMatch(source, /planPlayback/);
  assert.doesNotMatch(source, /\bplan:\s*plan/);
});
