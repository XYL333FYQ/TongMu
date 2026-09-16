const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { DataSource } = require('typeorm');

process.env.NODE_ENV = 'test';
process.env.MEDIA_HANDLE_SECRET = process.env.MEDIA_HANDLE_SECRET || 'phase5b2a-media-handle-secret';

const { SecretVault } = require('../dist/services/secret-vault');
const { Room } = require('../dist/entities/Room');
const { Session } = require('../dist/entities/Session');
const { Movie } = require('../dist/entities/Movie');
const { NcmCredential } = require('../dist/entities/NcmCredential');
const { MusicQueueItem } = require('../dist/entities/MusicQueueItem');
const { MusicRoomState } = require('../dist/entities/MusicRoomState');
const { RealtimeSyncCore } = require('../dist/modules/realtime-sync-core/realtime-sync-core.service');
const { MusicSyncService } = require('../dist/modules/music/music-sync.service');
const { CredentialedMusicProviderRegistry } = require('../dist/modules/music/music-provider');
const { NcmMusicProvider } = require('../dist/modules/music/ncm/ncm-provider');
const { NcmCredentialService } = require('../dist/modules/music/ncm/ncm-credential.service');
const { NcmLoginService } = require('../dist/modules/music/ncm/ncm-login.service');
const { NcmProviderError } = require('../dist/modules/music/ncm/types');
const { MusicPlaybackService } = require('../dist/modules/music/ncm/music-playback.service');
const { createNcmMusicRouter } = require('../dist/modules/music/ncm/routes');
const { issueRoomMediaGrant, resolveMediaHandle } = require('../dist/services/media/handles');

class FakeNcmClient {
  constructor() {
    this.qrPolls = 0;
    this.resolveCalls = [];
    this.logoutCalls = 0;
    this.audioUrl = 'https://m1.music.126.net/fixture-audio';
  }

  async createQr() {
    return {
      qrKey: 'fake-qr-key',
      qrUrl: 'ncm://fixture/fake-qr-key',
      qrImageDataUrl: 'data:image/png;base64,fixture',
      expiresAt: Date.now() + 60_000,
    };
  }

  async checkQr() {
    this.qrPolls += 1;
    if (this.qrPolls === 1) return { status: 'waiting' };
    return {
      status: 'authorized',
      cookieHeader: 'MUSIC_U=fake-secret; NCM_CSRF=fake-csrf',
      profile: { accountId: 'fake-account', displayName: 'NCM Fake', avatarUrl: null },
    };
  }

  async getStatus(credential) {
    return { loggedIn: credential.cookieHeader.includes('MUSIC_U=fake-secret') };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  async resolveTrack(trackId, requestedQuality, credential) {
    this.resolveCalls.push({ trackId, requestedQuality, cookieHeader: credential.cookieHeader });
    const codec = trackId === '1001' ? 'mp3' : trackId === '1002' ? 'aac' : trackId === '1003' ? 'flac' : 'wav';
    const actualQuality = trackId === '9001' && requestedQuality === 'lossless' ? 'exhigh' : requestedQuality;
    const availableQualities = trackId === '9001'
      ? ['standard', 'higher', 'exhigh']
      : [actualQuality];
    return {
      trackId,
      title: `Track ${trackId}`,
      artist: 'NCM Fake',
      album: 'Fixture',
      durationMs: 1000,
      url: this.audioUrl,
      actualQuality,
      availableQualities,
      availableMaximum: availableQualities[availableQualities.length - 1],
      codec,
      container: codec,
      mimeType: codec === 'mp3' ? 'audio/mpeg' : codec === 'aac' ? 'audio/aac' : codec === 'flac' ? 'audio/flac' : 'audio/wav',
      expiresAt: Date.now() + 60_000,
    };
  }
}

async function createDataSource() {
  const dataSource = new DataSource({
    type: 'sqljs',
    autoSave: false,
    synchronize: true,
    entities: [Room, Session, Movie, NcmCredential, MusicQueueItem, MusicRoomState],
  });
  await dataSource.initialize();
  await dataSource.getRepository(Room).save(dataSource.getRepository(Room).create({
    roomId: 'ncm-phase-room',
    name: 'NCM phase room',
    password: null,
    maxViewers: 10,
    status: 'active',
    mode: 'watch-together',
    shareMethod: 'webrtc',
    streamKey: null,
    requireApproval: false,
    ownerUserId: 1,
    mutedViewers: '[]',
    approvedViewers: '[]',
    moderators: '[]',
    voiceMuted: '[]',
  }));
  const sessionRepo = dataSource.getRepository(Session);
  await sessionRepo.save(sessionRepo.create({ roomId: 'ncm-phase-room', socketId: 'host-socket', role: 'sharer', userId: 1 }));
  await sessionRepo.save(sessionRepo.create({ roomId: 'ncm-phase-room', socketId: 'viewer-socket', role: 'viewer', userId: 2 }));
  return dataSource;
}

function setup(dataSource, client) {
  const vault = new SecretVault({ masterKey: Buffer.alloc(32, 7) });
  const credentials = new NcmCredentialService(dataSource, vault);
  const provider = new NcmMusicProvider(client, credentials);
  const providers = new CredentialedMusicProviderRegistry();
  providers.register(provider);
  const music = new MusicSyncService(dataSource, new RealtimeSyncCore());
  const playback = new MusicPlaybackService(dataSource, music, providers, credentials);
  return { vault, credentials, provider, providers, music, playback };
}

function actor(socketId, userId, role = 'user') {
  return { socketId, userId, role };
}

test('NCM QR login is user-bound and stores only SecretVault ciphertext', async (t) => {
  const dataSource = await createDataSource();
  t.after(() => dataSource.destroy());
  const client = new FakeNcmClient();
  const { credentials } = setup(dataSource, client);
  const login = new NcmLoginService(client, credentials);

  const created = await login.createQr(1);
  assert.equal(created.status, 'qr-created');
  assert.equal(JSON.stringify(created).includes('fake-secret'), false);
  await assert.rejects(
    () => login.pollQr(2, created.sessionId),
    (error) => error instanceof NcmProviderError && error.code === 'NCM_QR_SESSION_NOT_FOUND',
  );
  assert.equal((await login.pollQr(1, created.sessionId)).status, 'waiting');
  assert.equal((await login.pollQr(1, created.sessionId)).status, 'logged-in');

  const row = await dataSource.getRepository(NcmCredential).findOneBy({ userId: 1 });
  assert.ok(row);
  assert.match(row.credentialEnvelope, /^v1:/);
  assert.equal(row.credentialEnvelope.includes('fake-secret'), false);
  const status = await credentials.getStatus(1);
  assert.equal(status.loggedIn, true);
  assert.equal(status.displayName, 'NCM Fake');
  assert.equal(JSON.stringify(status).includes('MUSIC_U'), false);

  await login.logout(1);
  assert.equal(client.logoutCalls, 1);
  assert.equal(await credentials.getPrivateCredential(1), null);
  const revoked = await credentials.getStatus(1);
  assert.equal(revoked.status, 'invalid');
  assert.equal(revoked.loggedIn, false);
  assert.equal(revoked.credentialVersion, 2);
  assert.equal((await dataSource.getRepository(NcmCredential).findOneBy({ userId: 1 })).credentialEnvelope.includes('fake-secret'), false);
});

test('NCM QR operations serialize replacement for one user', async (t) => {
  const dataSource = await createDataSource();
  t.after(() => dataSource.destroy());
  const client = new FakeNcmClient();
  const { credentials } = setup(dataSource, client);
  const login = new NcmLoginService(client, credentials);

  const [first, second] = await Promise.all([
    login.createQr(1),
    login.createQr(1),
  ]);
  assert.equal((await login.pollQr(1, first.sessionId)).status, 'failed');
  assert.equal((await login.pollQr(1, second.sessionId)).status, 'waiting');
});

test('NCM provider requests exactly the requested quality and preserves codec facts', async (t) => {
  const dataSource = await createDataSource();
  t.after(() => dataSource.destroy());
  const client = new FakeNcmClient();
  const { credentials, provider } = setup(dataSource, client);
  await credentials.saveCredential(1, { cookieHeader: 'MUSIC_U=fake-secret' }, { accountId: '1', displayName: 'Fake' });

  const exact = await provider.resolve({ roomId: 'ncm-phase-room', userId: 1, credentialOwnerId: 1, requestedQuality: 'exhigh' }, 'music://ncm/track/9001');
  assert.equal(exact.descriptor.requestedQuality, 'exhigh');
  assert.equal(exact.descriptor.actualQuality, 'exhigh');
  assert.deepEqual(exact.descriptor.availableQualities, ['standard', 'higher', 'exhigh']);
  assert.equal(exact.descriptor.codec, 'wav');
  assert.equal(exact.descriptor.url, undefined);
  assert.equal(exact.privateSource.headers.Cookie, 'MUSIC_U=fake-secret');

  await assert.rejects(
    () => provider.resolve({ roomId: 'ncm-phase-room', userId: 1, credentialOwnerId: 1, requestedQuality: 'lossless' }, 'music://ncm/track/9001'),
    (error) => error instanceof NcmProviderError && error.code === 'NCM_QUALITY_UNAVAILABLE' &&
      error.details.actualQuality === 'exhigh',
  );
  assert.equal(client.resolveCalls.at(-1).requestedQuality, 'lossless');
  assert.equal(client.resolveCalls.some((call) => call.trackId === '9001' && call.requestedQuality === 'standard'), false);

  for (const [trackId, codec] of [['1001', 'mp3'], ['1002', 'aac'], ['1003', 'flac']]) {
    const result = await provider.resolve({ roomId: 'ncm-phase-room', userId: 1, credentialOwnerId: 1, requestedQuality: 'standard' }, `music://ncm/track/${trackId}`);
    assert.equal(result.descriptor.codec, codec);
  }
});

test('NCM capability is actor/generation bound and uses the shared exact Range gateway', async (t) => {
  const dataSource = await createDataSource();
  const client = new FakeNcmClient();
  const { credentials, music, playback } = setup(dataSource, client);
  await credentials.saveCredential(1, { cookieHeader: 'MUSIC_U=fake-secret' }, { accountId: '1', displayName: 'Fake' });
  const hostGrant = issueRoomMediaGrant('ncm-phase-room', 'host-socket');
  const viewerGrant = issueRoomMediaGrant('ncm-phase-room', 'viewer-socket');
  const host = actor('host-socket', 1);
  const first = await music.addQueueItem('ncm-phase-room', {
    sourceRef: 'music://ncm/track/9001', title: 'Gateway Fixture', artist: 'Fake', durationMs: 1000,
  }, { mutationId: 'ncm-add-1' }, host);

  const body = Buffer.from('ncm-range-fixture');
  let authFailures = 1;
  const upstream = http.createServer((req, res) => {
    if (req.headers.cookie !== 'MUSIC_U=fake-secret') {
      res.writeHead(401); res.end(); return;
    }
    if (authFailures > 0) { authFailures -= 1; res.writeHead(403); res.end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') res.end(); else res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  process.env.MEDIA_E2E_FIXTURE_ORIGIN = `http://127.0.0.1:${port}`;
  client.audioUrl = `http://127.0.0.1:${port}/ncm-audio/9001`;

  const resolved = await playback.resolve({
    roomId: 'ncm-phase-room', roomGrant: viewerGrant, queueItemId: first.currentQueueItemId,
    sourceRef: first.currentSourceRef, musicGeneration: first.musicGeneration, requestedQuality: 'exhigh',
  });
  assert.equal(resolved.descriptor.actualQuality, 'exhigh');
  assert.equal(resolved.playbackUrl.includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(resolved).includes('MUSIC_U'), false);
  const token = resolved.playbackUrl.split('/').at(-1);
  const sealed = resolveMediaHandle(token, '', { roomId: 'ncm-phase-room', socketId: 'viewer-socket', expiresAt: Date.now() + 1000 });
  assert.ok(sealed);
  assert.equal(JSON.stringify(sealed.providerData).includes('ncm-audio'), false);
  assert.equal(JSON.stringify(sealed.providerData).includes('MUSIC_U'), false);

  const app = express();
  app.use('/api/music', createNcmMusicRouter({ credentials, playback }));
  const gateway = http.createServer(app);
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}${resolved.playbackUrl}?roomGrant=${encodeURIComponent(viewerGrant)}`;
  const response = await fetch(gatewayUrl, { headers: { Range: 'bytes=2-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 2-6/${body.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(2, 7));
  assert.equal(authFailures, 0, '401/403 should re-resolve once at the same requested quality');

  const second = await music.addQueueItem('ncm-phase-room', {
    sourceRef: 'music://ncm/track/9002', title: 'Second', artist: 'Fake', durationMs: 1000,
  }, { baseVersion: first.version, generation: first.musicGeneration, mutationId: 'ncm-add-2' }, host);
  const switched = await music.selectTrack('ncm-phase-room', second.queue[1].queueItemId, {
    baseVersion: second.version, generation: second.musicGeneration, mutationId: 'ncm-select-2',
  }, host);
  const stale = await fetch(gatewayUrl);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'MUSIC_TRACK_NOT_CURRENT');

  await credentials.clearCredential(1);
  const afterOwnerLogout = await fetch(gatewayUrl);
  assert.equal(afterOwnerLogout.status, 403);
  await afterOwnerLogout.text();

  await dataSource.getRepository(Session).update({ roomId: 'ncm-phase-room', socketId: 'viewer-socket' }, { endedAt: new Date() });
  const nextViewerGrant = issueRoomMediaGrant('ncm-phase-room', 'viewer-socket');
  const afterLeave = await fetch(`${gatewayUrl.split('?')[0]}?roomGrant=${encodeURIComponent(nextViewerGrant)}`);
  assert.equal(afterLeave.status, 403);
  await afterLeave.text();
  await gateway.close();
  await upstream.close();
  await dataSource.destroy();
  delete process.env.MEDIA_E2E_FIXTURE_ORIGIN;
});
