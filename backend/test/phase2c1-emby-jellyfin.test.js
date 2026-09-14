const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { sessionActorIsCurrentUser, toPublicDescriptor } = require('../dist/routes/stream/media');
const { publicMetadata } = require('../dist/services/media/protocol');
const { filterPlaybackCandidates } = require('../dist/services/media/viability');
const {
  validatePlaybackClientProfile,
} = require('../dist/services/media/playback-profile');
const {
  EmbyProvider,
  JellyfinProvider,
} = require('../dist/services/media/providers/media-server-provider');
const { EmbyProviderClient } = require('../dist/services/media/providers/emby-client');
const { JellyfinProviderClient } = require('../dist/services/media/providers/jellyfin-client');
const { fetchWithProxyPolicy } = require('../dist/services/proxy/safe-fetch');
const {
  ProviderPlaybackSessionCoordinator,
} = require('../dist/services/media/provider-playback-session');
const {
  buildMediaServerReference,
  parseMediaServerReference,
} = require('../dist/services/media/providers/media-server-reference');

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

function context(overrides = {}) {
  return {
    actor: { kind: 'user', userId: '7' },
    userId: '7',
    credentialOwnerId: '42',
    roomId: 'room-1',
    movieId: 9,
    sourceGeneration: 1,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    profile: profileWith([
      { transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', pipeline: 'native', supportsCustomHeaders: false },
    ]),
    credentialOwnerPolicy: 'room-owner',
    safeFetch: fetchWithProxyPolicy,
    ...overrides,
  };
}

function mount(type = 'emby') {
  return {
    id: 7,
    userId: 42,
    type,
    name: `${type} fixture`,
    serverUrl: 'http://media.example',
    port: null,
    path: null,
    username: null,
    password: null,
    apiKey: 'server-api-secret',
    embyUserId: 'server-user',
    directLink: false,
  };
}

function source(baseUrl, overrides = {}) {
  return {
    id: 'source-1',
    name: 'fixture-movie',
    path: '/movies/fixture.mp4',
    protocol: 'Http',
    container: 'mp4',
    size: 1024,
    bitrate: 5_000_000,
    width: 1920,
    height: 1080,
    supportsDirectPlay: true,
    supportsDirectStream: false,
    supportsTranscoding: false,
    directPlayUrl: `${baseUrl}/Videos/item-1/stream?static=true`,
    mediaStreams: [
      { index: 0, type: 'Video', codec: 'avc1.640028', bitrate: 4_000_000 },
      { index: 1, type: 'Audio', codec: 'mp4a.40.2', channels: 2, bitrate: 192_000 },
      { index: 2, type: 'Subtitle', codec: 'WebVTT', language: 'zh', displayTitle: '中文', isExternal: false, isDefault: true },
    ],
    ...overrides,
  };
}

function fakeClient(providerId, sources, calls = []) {
  return {
    providerId,
    baseUrl: 'http://media.example',
    userId: 'server-user',
    authHeaders: () => ({ Authorization: 'MediaBrowser private-identity', 'X-Emby-Token': 'server-api-secret' }),
    playbackInfo: async () => ({ playSessionId: 'play-session-1', mediaSources: sources }),
    playbackUrl: (itemId, mediaSourceId, mode) => `http://media.example/Videos/${itemId}/${mode}-${mediaSourceId}`,
    startPlayback: async (session) => calls.push(['start', session]),
    reportProgress: async (session, position, paused) => calls.push(['progress', session, position, paused]),
    stopPlayback: async (session, position) => calls.push(['stop', session, position]),
    cleanupPlayback: async (session) => calls.push(['cleanup', session]),
  };
}

function providerFor(Provider, providerId, sourceOverrides = {}, overrides = {}) {
  const client = fakeClient(providerId, [source('http://media.example', sourceOverrides)]);
  return {
    provider: new Provider({
      loadMount: async (providerContext, reference, type) => {
        assert.equal(reference.mountId, 7);
        assert.equal(type, providerId);
        assert.equal(providerContext.credentialOwnerId, '42');
        return mount(providerId);
      },
      createClient: async () => client,
      ...overrides,
    }),
    client,
  };
}

function fullProxyCandidates(result) {
  return result.candidates.map((candidate) => ({
    ...candidate,
    mode: 'FULL_PROXY',
    url: '/api/stream/media/opaque',
    requiresCustomHeaders: false,
  }));
}

test('Emby and Jellyfin use separate Provider boundaries and stable credential-free references', async () => {
  const reference = buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' });
  assert.deepEqual(parseMediaServerReference(reference), { provider: 'emby', mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' });
  assert.equal(parseMediaServerReference('provider://emby?mountId=7&itemId=item-1&apiKey=secret'), undefined);
  assert.equal(parseMediaServerReference('http://127.0.0.1:8096/emby'), undefined);

  for (const [Provider, providerId] of [[EmbyProvider, 'emby'], [JellyfinProvider, 'jellyfin']]) {
    const { provider } = providerFor(Provider, providerId);
    const result = await provider.resolve(context(), buildMediaServerReference({ provider: providerId, mountId: 7, itemId: 'item-1' }), {});
    assert.equal(result.privateSource.providerId, providerId);
    assert.equal(result.sourceReference, reference.replace('provider://emby', `provider://${providerId}`).replace('&mediaSourceId=source-1', '&mediaSourceId=source-1'));
    assert.equal(result.descriptor.sourceMetadata[providerId].mediaSourceId, 'source-1');
    assert.equal(result.descriptor.sourceMetadata[providerId].itemId, 'item-1');
    assert.equal(result.descriptor.sourceMetadata[providerId].subtitles[0].sourceReference.includes('server-api-secret'), false);

    const publicDescriptor = toPublicDescriptor(result.descriptor, '/api/stream/media/opaque');
    const serialized = JSON.stringify(publicDescriptor);
    assert.equal(serialized.includes('server-api-secret'), false);
    assert.equal(serialized.includes('MediaBrowser private-identity'), false);
    assert.equal(serialized.includes('media.example'), false);
    assert.equal(serialized.includes('play-session-1'), false);
    assert.equal(result.privateSource.providerData.trustedPrivateHosts[0], 'media.example');
  }
  const storedPublic = publicMetadata({
    transportPlan: {
      reason: 'test',
      candidates: [{ mode: 'FULL_PROXY', url: '/api/stream/media/media-handle', playbackSessionUrl: '/api/stream/media/session-handle/session' }],
    },
  });
  assert.equal(storedPublic.transportPlan.candidates[0].playbackSessionUrl, undefined);
});

test('Emby/Jellyfin codec tuples filter independently and never silently add lower quality transcode', async () => {
  const h264Profile = profileWith([
    { transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', pipeline: 'native', supportsCustomHeaders: false },
  ]);
  const hevcOnly = providerFor(EmbyProvider, 'emby', {
    mediaStreams: [
      { index: 0, type: 'Video', codec: 'hvc1.2.4.L153', bitrate: 12_000_000 },
      { index: 1, type: 'Audio', codec: 'mp4a.40.2', channels: 2 },
    ],
  });
  const hevcResult = await hevcOnly.provider.resolve(context({ profile: h264Profile }), buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: 'item-1' }), {});
  assert.equal(hevcResult.candidates.some((candidate) => candidate.qualityChanged), false);
  assert.equal(filterPlaybackCandidates(hevcResult.descriptor, fullProxyCandidates(hevcResult), h264Profile).viable.length, 0);

  const sameQuality = providerFor(JellyfinProvider, 'jellyfin', {
    supportsDirectStream: true,
    directStreamPreservesQuality: true,
    directStreamUrl: 'http://media.example/Videos/item-1/remux-source-1',
  });
  const sameQualityResult = await sameQuality.provider.resolve(context({ profile: h264Profile }), buildMediaServerReference({ provider: 'jellyfin', mountId: 7, itemId: 'item-1' }), {});
  const sameQualityCandidates = fullProxyCandidates(sameQualityResult);
  assert.equal(sameQualityCandidates.some((candidate) => candidate.upstreamMode === 'direct-stream' && candidate.qualityPreserved === true), true);
  assert.equal(filterPlaybackCandidates(sameQualityResult.descriptor, sameQualityCandidates, h264Profile).viable.length > 0, true);

  const withTranscode = providerFor(EmbyProvider, 'emby', {
    height: 2160,
    supportsTranscoding: true,
    transcodingUrl: 'http://media.example/Videos/item-1/master.m3u8',
    transcodingContainer: 'hls',
    transcodingVideoCodec: 'h264',
    transcodingAudioCodec: 'aac',
    transcodingWidth: 1920,
    transcodingHeight: 1080,
    transcodingBitrate: 8_000_000,
  });
  const input = buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: 'item-1' });
  const defaultResult = await withTranscode.provider.resolve(context({ profile: h264Profile }), input, {});
  assert.equal(defaultResult.candidates.some((candidate) => candidate.upstreamMode === 'transcode'), false);
  const explicitProfile = profileWith([
    { transport: 'hls', container: 'hls', pipeline: 'mse', videoCodec: 'h264', audioCodec: 'aac', supportsCustomHeaders: true },
  ]);
  const explicitResult = await withTranscode.provider.resolve(context({ profile: explicitProfile, qualityChangingTranscode: 'explicit' }), input, {});
  const transcoded = explicitResult.candidates.find((candidate) => candidate.upstreamMode === 'transcode');
  assert.ok(transcoded);
  assert.equal(transcoded.qualityChanged, true);
  assert.equal(transcoded.qualityPreserved, false);
  assert.equal(transcoded.actualQuality, 1080);
  assert.equal(filterPlaybackCandidates(explicitResult.descriptor, fullProxyCandidates(explicitResult), explicitProfile).viable.some((candidate) => candidate.qualityChanged), true);
});

test('VP9, AV1, AC3/EAC3/DTS and MKV retain exact candidate tuple facts', async () => {
  const cases = [
    ['vp09.00.10.08', 'opus', 'webm'],
    ['av01.0.05M.08', 'aac', 'mp4'],
    ['avc1.640028', 'ac-3', 'mp4'],
    ['avc1.640028', 'ec-3', 'mp4'],
    ['avc1.640028', 'dts', 'mkv'],
  ];
  for (const [video, audio, container] of cases) {
    const { provider } = providerFor(JellyfinProvider, 'jellyfin', {
      container,
      path: `/movies/fixture.${container}`,
      mediaStreams: [
        { index: 0, type: 'Video', codec: video },
        { index: 1, type: 'Audio', codec: audio, channels: 6 },
      ],
    });
    const result = await provider.resolve(context(), buildMediaServerReference({ provider: 'jellyfin', mountId: 7, itemId: 'item-1' }), {});
    const candidate = result.candidates.find((item) => item.upstreamMode === 'direct-play');
    assert.ok(candidate);
    assert.equal(candidate.container, container);
    assert.equal(candidate.videoCodec, video.toLowerCase().startsWith('vp09') ? 'vp9' : video.toLowerCase().startsWith('av01') ? 'av1' : 'h264');
    assert.equal(candidate.audioCodec, audio.startsWith('ec') ? 'eac3' : audio.startsWith('ac') ? 'ac3' : audio === 'dts' ? 'dts' : audio === 'opus' ? 'opus' : 'aac');
    assert.equal(candidate.qualityIdentity.container, container);
    assert.equal(candidate.exactCodecStrings.some((value) => value.startsWith(video.toLowerCase().slice(0, 4))), true);
  }
});

test('configured private LAN access is allowed, arbitrary endpoint and wrong credential owner are rejected', async () => {
  const { provider } = providerFor(EmbyProvider, 'emby', {}, {
    loadMount: async (providerContext, reference) => {
      assert.equal(providerContext.credentialOwnerId, '42');
      assert.equal(reference.mountId, 7);
      return mount('emby');
    },
  });
  const resolved = await provider.resolve(context(), buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: 'item-1' }), {});
  assert.equal(resolved.privateSource.providerId, 'emby');
  assert.throws(() => provider.validateInput(context(), 'http://127.0.0.1:8096/emby/Videos/item-1/stream'), /无效/);

  const wrongOwner = new EmbyProvider({
    loadMount: async (providerContext) => {
      if (providerContext.credentialOwnerId !== '42') return undefined;
      return mount('emby');
    },
    createClient: async () => fakeClient('emby', [source('http://media.example')]),
  });
  await assert.rejects(wrongOwner.resolve(context({ credentialOwnerId: '7' }), buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: 'item-1' }), {}), /无权/);
});

test('provider HTTP fixture covers playback info, stream Range, subtitles and session calls for both protocols', async (t) => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, token: req.headers['x-emby-token'], authorization: req.headers.authorization });
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path.endsWith('/PlaybackInfo')) {
      const raw = source(`http://127.0.0.1:${server.address().port}`, { directPlayUrl: undefined });
      const body = JSON.stringify({
        PlaySessionId: 'fixture-session',
        MediaSources: [{
          Id: raw.id, Name: raw.name, Path: raw.path, Protocol: raw.protocol, Container: raw.container,
          Size: raw.size, Bitrate: raw.bitrate, Width: raw.width, Height: raw.height,
          SupportsDirectPlay: raw.supportsDirectPlay, SupportsDirectStream: raw.supportsDirectStream,
          SupportsTranscoding: raw.supportsTranscoding,
          MediaStreams: raw.mediaStreams.map((stream) => ({
            Index: stream.index, Type: stream.type, Codec: stream.codec, Language: stream.language,
            DisplayTitle: stream.displayTitle, IsExternal: stream.isExternal, IsDefault: stream.isDefault,
            IsForced: stream.isForced, Channels: stream.channels, BitRate: stream.bitrate,
          })),
        }],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (path.includes('/Subtitles/0/Stream')) {
      res.writeHead(200, { 'content-type': 'text/vtt' });
      res.end('WEBVTT\n\n');
      return;
    }
    if (path.endsWith('/stream')) {
      const body = Buffer.from('0123456789');
      const range = /^bytes=(\d+)-(\d*)$/i.exec(String(req.headers.range || ''));
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : body.length - 1;
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
        res.end(body.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      }
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const emby = new EmbyProviderClient({ serverUrl, token: 'fixture-token', userId: 'fixture-user', context: context() });
  const jellyfin = new JellyfinProviderClient({ serverUrl, token: 'fixture-token', userId: 'fixture-user', context: context() });
  for (const client of [emby, jellyfin]) {
    const info = await client.playbackInfo({
      itemId: 'item-1', userId: 'fixture-user', profile: context().profile,
      allowTranscoding: false, context: context(),
    });
    assert.equal(info.playSessionId, 'fixture-session');
    assert.equal(info.mediaSources[0].id, 'source-1');
    const stream = await fetch(`${serverUrl}${client.providerId === 'emby' ? '/emby' : ''}/Videos/item-1/stream`, { headers: { ...client.authHeaders(), Range: 'bytes=2-4' } });
    assert.equal(stream.status, 206);
    assert.equal(await stream.text(), '234');
    assert.equal(await client.subtitleContent('item-1', 'source-1', 0, context()), 'WEBVTT\n\n');
    await client.startPlayback({ providerId: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'fixture-session', reference: buildMediaServerReference({ provider: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' }) }, context());
    await client.reportProgress({ providerId: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'fixture-session', reference: buildMediaServerReference({ provider: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' }) }, 12.5, false, context());
    await client.stopPlayback({ providerId: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'fixture-session', reference: buildMediaServerReference({ provider: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' }) }, 12.5, context());
    await client.cleanupPlayback({ providerId: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1', playSessionId: 'fixture-session', reference: buildMediaServerReference({ provider: client.providerId, mountId: 7, itemId: 'item-1', mediaSourceId: 'source-1' }) }, context());
  }
  assert.equal(calls.some((call) => call.token === 'fixture-token'), true);
  assert.equal(calls.some((call) => String(call.url).includes('api_key=fixture-token')), false);
});

test('abort reaches media-server HTTP and deadline is bounded', async (t) => {
  let requestSeenResolve;
  const requestSeen = new Promise((resolve) => { requestSeenResolve = resolve; });
  const server = http.createServer((req, res) => {
    requestSeenResolve();
    setTimeout(() => res.end(JSON.stringify({ MediaSources: [] })), 500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const controller = new AbortController();
  const requestContext = context({ signal: controller.signal, deadline: Date.now() + 2_000 });
  const client = new EmbyProviderClient({ serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token', userId: 'fixture-user', context: requestContext });
  const pending = client.playbackInfo({ itemId: 'item-1', userId: 'fixture-user', profile: requestContext.profile, allowTranscoding: false, context: requestContext });
  await requestSeen;
  controller.abort();
  await assert.rejects(pending, /取消|超时/);
});

function lifecycleProvider(calls, options = {}) {
  const lifecycle = {
    start: async (ctx, session) => { if (ctx.signal.aborted) throw new Error('cancelled'); calls.push(['start', session.playSessionId]); },
    progress: async (_ctx, session, position) => calls.push(['progress', session.playSessionId, position]),
    stop: async (_ctx, session) => calls.push(['stop', session.playSessionId]),
    cleanup: async (_ctx, session) => {
      calls.push(['cleanup', session.playSessionId]);
      if (options.failCleanup) throw new Error('cleanup failed');
    },
  };
  return { id: 'emby', playbackSession: lifecycle };
}

function session(id, generation) {
  return {
    providerId: 'emby', mountId: 7, itemId: id, mediaSourceId: 'source-1', playSessionId: `session-${id}`,
    reference: buildMediaServerReference({ provider: 'emby', mountId: 7, itemId: id, mediaSourceId: 'source-1' }),
    actorUserId: '7', credentialOwnerId: '42', roomId: 'room-1', movieId: 9, sourceGeneration: generation,
  };
}

test('session lifecycle is generation-aware, idempotent, abort-safe and does not accept foreign raw ids', async () => {
  const calls = [];
  const coordinator = new ProviderPlaybackSessionCoordinator();
  const provider = lifecycleProvider(calls);
  const first = session('item-a', 1);
  const second = session('item-b', 2);
  await coordinator.start(provider, context({ sourceGeneration: 1 }), first);
  await coordinator.progress(provider, context({ sourceGeneration: 1 }), first, 10, false);
  await coordinator.start(provider, context({ sourceGeneration: 2 }), second);
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.progress(provider, context({ sourceGeneration: 1 }), first, 20, false);
  assert.equal(calls.some((call) => call[0] === 'cleanup' && call[1] === 'session-item-a'), true);
  assert.equal(calls.some((call) => call[0] === 'progress' && call[2] === 20), false);
  await coordinator.cleanup(provider, context(), first);
  await coordinator.cleanup(provider, context(), first);
  assert.equal(calls.filter((call) => call[0] === 'cleanup' && call[1] === 'session-item-a').length, 1);

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(coordinator.start(provider, context({ signal: abortController.signal }), session('item-c', 3)), /cancelled/);
  const afterStart = new AbortController();
  const third = session('item-d', 4);
  await coordinator.start(provider, context({ signal: afterStart.signal }), third);
  afterStart.abort();
  await coordinator.cleanup(provider, context({ signal: afterStart.signal }), third);
  assert.equal(calls.some((call) => call[0] === 'cleanup' && call[1] === 'session-item-d'), true);
  assert.equal(calls.some((call) => call[1] === 'raw-provider-session-id'), false);
  assert.equal(sessionActorIsCurrentUser(first, '7'), true);
  assert.equal(sessionActorIsCurrentUser(first, '8'), false);
  assert.equal(sessionActorIsCurrentUser(first, ''), false);
});

test('cleanup network failure is best effort and remains idempotent', async () => {
  const calls = [];
  const coordinator = new ProviderPlaybackSessionCoordinator();
  const provider = lifecycleProvider(calls, { failCleanup: true });
  const current = session('item-failure', 1);
  await coordinator.start(provider, context(), current);
  await coordinator.cleanup(provider, context(), current);
  await coordinator.cleanup(provider, context(), current);
  assert.equal(calls.filter((call) => call[0] === 'cleanup').length, 1);
});
