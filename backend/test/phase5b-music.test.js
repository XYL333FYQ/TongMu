const test = require('node:test');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');

const { Room } = require('../dist/entities/Room');
const { Session } = require('../dist/entities/Session');
const { Movie } = require('../dist/entities/Movie');
const { MusicQueueItem } = require('../dist/entities/MusicQueueItem');
const { MusicRoomState } = require('../dist/entities/MusicRoomState');
const { RealtimeSyncCore } = require('../dist/modules/realtime-sync-core/realtime-sync-core.service');
const { MusicSyncService, MusicSyncError } = require('../dist/modules/music/music-sync.service');
const {
  createStableShuffleOrder,
  selectAdjacentQueueItemId,
  validateMusicQueueItemInput,
} = require('../dist/modules/music/music-sync.domain');
const { canPerformRoomAction } = require('../dist/modules/room/permission-core');

async function createMusicDataSource() {
  const dataSource = new DataSource({
    type: 'sqljs',
    autoSave: false,
    synchronize: true,
    entities: [Room, Session, Movie, MusicQueueItem, MusicRoomState],
  });
  await dataSource.initialize();
  const room = dataSource.getRepository(Room).create({
    roomId: 'phase5b-room',
    name: 'Phase 5B',
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
  });
  await dataSource.getRepository(Room).save(room);
  await dataSource.getRepository(Session).save(dataSource.getRepository(Session).create({
    roomId: 'phase5b-room',
    socketId: 'host-socket',
    role: 'sharer',
    userId: 1,
  }));
  return dataSource;
}

const host = { socketId: 'host-socket', userId: 1, role: 'user' };

function item(title, suffix) {
  return {
    sourceRef: `music://fixture/${suffix}`,
    title,
    artist: 'fixture',
    durationMs: 4_000,
    metadata: { test: true },
  };
}

test('MusicSyncDomain validates opaque refs, preserves duplicate track identity, and bounds metadata', () => {
  const valid = validateMusicQueueItemInput(item('same song', 'same-song'));
  assert.equal(valid.ok, true);
  assert.equal(validateMusicQueueItemInput({ ...item('bad', 'bad'), sourceRef: 'https://cdn.example/song.mp3' }).ok, false);
  assert.equal(validateMusicQueueItemInput({ ...item('secret', 'secret'), sourceRef: 'music://fixture/song?token=x' }).ok, false);
  assert.equal(validateMusicQueueItemInput({ ...item('deep', 'deep'), metadata: { a: { b: { c: { d: { e: 1 } } } } } }).ok, false);
});

test('Music play modes have deterministic shuffle and explicit repeat-all behavior', () => {
  const ids = [11, 12, 13];
  assert.deepEqual(createStableShuffleOrder(ids, 'seed-1'), createStableShuffleOrder(ids, 'seed-1'));
  assert.deepEqual([...createStableShuffleOrder(ids, 'seed-2')].sort((a, b) => a - b), ids);
  assert.equal(selectAdjacentQueueItemId(ids, 13, 'sequential', 1, 'manual'), null);
  assert.equal(selectAdjacentQueueItemId(ids, 13, 'repeat-all', 1, 'manual'), 11);
  assert.equal(selectAdjacentQueueItemId(ids, 12, 'repeat-one', 1, 'ended'), 12);
  const shuffle = createStableShuffleOrder(ids, 'seed-1');
  assert.equal(selectAdjacentQueueItemId(ids, shuffle[0], 'shuffle', 1, 'manual', shuffle), shuffle[1]);
});

test('Music queue and selection persist independently of ephemeral position after restart', async (t) => {
  const dataSource = await createMusicDataSource();
  t.after(() => dataSource.destroy());
  const core = new RealtimeSyncCore();
  const service = new MusicSyncService(dataSource, core);

  const first = await service.addQueueItem('phase5b-room', item('same song', 'same-song'), { baseVersion: 0, generation: 0, mutationId: 'add-1' }, host);
  const second = await service.addQueueItem('phase5b-room', item('same song', 'same-song'), { baseVersion: first.version, generation: first.musicGeneration, mutationId: 'add-2' }, host);
  assert.equal(first.queue.length, 1);
  assert.equal(second.queue.length, 2);
  assert.notEqual(first.queue[0].queueItemId, second.queue[1].queueItemId);

  const reordered = await service.reorderQueue(
    'phase5b-room',
    [second.queue[1].queueItemId, second.queue[0].queueItemId],
    { baseVersion: second.version, generation: second.musicGeneration, mutationId: 'reorder-1' },
    host,
  );
  const selected = await service.selectTrack(
    'phase5b-room',
    reordered.queue[1].queueItemId,
    { baseVersion: reordered.version, generation: reordered.musicGeneration, mutationId: 'select-1' },
    host,
  );
  const mode = await service.setPlayMode(
    'phase5b-room',
    'repeat-all',
    { baseVersion: selected.version, generation: selected.musicGeneration, mutationId: 'mode-1' },
    host,
  );
  assert.equal(mode.playMode, 'repeat-all');
  assert.equal(mode.positionSec, 0);
  assert.equal(mode.isPlaying, false);

  await assert.rejects(
    () => service.applyPlayback('phase5b-room', 'play', undefined, {
      baseVersion: mode.version,
      generation: mode.musicGeneration - 1,
      mutationId: 'old-play',
    }, host),
    (error) => error instanceof MusicSyncError && error.code === 'STALE_GENERATION',
  );

  const restarted = new MusicSyncService(dataSource, new RealtimeSyncCore());
  const recovered = await restarted.getSnapshot('phase5b-room', host);
  assert.deepEqual(recovered.queue.map((entry) => entry.queueItemId), mode.queue.map((entry) => entry.queueItemId));
  assert.equal(recovered.currentQueueItemId, mode.currentQueueItemId);
  assert.equal(recovered.playMode, 'repeat-all');
  assert.equal(recovered.positionSec, 0);
  assert.equal(recovered.isPlaying, false);
  assert.equal(recovered.musicGeneration, mode.musicGeneration);

  const stored = await dataSource.getRepository(MusicQueueItem).find();
  assert.equal('audioUrl' in stored[0], false);
  assert.match(stored[0].sourceRef, /^music:\/\/fixture\//);
});

test('Music playback advances from the previous authoritative timestamp before pausing', async (t) => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const dataSource = await createMusicDataSource();
  t.after(async () => {
    Date.now = originalNow;
    await dataSource.destroy();
  });
  const service = new MusicSyncService(dataSource, new RealtimeSyncCore());
  const added = await service.addQueueItem('phase5b-room', item('clock', 'clock'), {
    mutationId: 'clock-add',
  }, host);
  const playing = await service.applyPlayback('phase5b-room', 'play', undefined, {
    baseVersion: added.version,
    generation: added.musicGeneration,
    mutationId: 'clock-play',
  }, host);
  now = 11_000;
  const paused = await service.applyPlayback('phase5b-room', 'pause', undefined, {
    baseVersion: playing.version,
    generation: playing.musicGeneration,
    mutationId: 'clock-pause',
  }, host);
  assert.equal(paused.isPlaying, false);
  assert.equal(paused.positionSec, 4);
});

test('Music queue mutations keep order deterministic, roll back failures, and reject stale concurrency', async (t) => {
  const dataSource = await createMusicDataSource();
  t.after(() => dataSource.destroy());
  const core = new RealtimeSyncCore();
  const service = new MusicSyncService(dataSource, core);

  const first = await service.addQueueItem('phase5b-room', item('one', 'one'), {
    mutationId: 'queue-one',
  }, host);
  const second = await service.addQueueItem('phase5b-room', item('two', 'two'), {
    baseVersion: first.version,
    generation: first.musicGeneration,
    mutationId: 'queue-two',
  }, host);
  const third = await service.addQueueItem('phase5b-room', item('three', 'three'), {
    baseVersion: second.version,
    generation: second.musicGeneration,
    mutationId: 'queue-three',
  }, host);

  const failingDataSource = new Proxy(dataSource, {
    get(target, property) {
      if (property === 'transaction') {
        return async () => {
          throw new Error('forced transaction failure');
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const failingService = new MusicSyncService(failingDataSource, core);
  await assert.rejects(
    () => failingService.addQueueItem('phase5b-room', item('failed', 'failed'), {
      baseVersion: third.version,
      generation: third.musicGeneration,
      mutationId: 'queue-failed',
    }, host),
    /forced transaction failure/,
  );
  const afterFailure = await service.getSnapshot('phase5b-room', host);
  const rowsAfterFailure = await dataSource.getRepository(MusicQueueItem).find({ where: { roomId: 'phase5b-room' } });
  assert.equal(afterFailure.queue.length, 3);
  assert.deepEqual(rowsAfterFailure.map((row) => row.queueItemId).sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(afterFailure.version, third.version);

  const ids = third.queue.map((entry) => entry.queueItemId);
  const outcomes = await Promise.allSettled([
    service.reorderQueue('phase5b-room', [ids[2], ids[0], ids[1]], {
      baseVersion: third.version,
      generation: third.musicGeneration,
      mutationId: 'queue-reorder-a',
    }, host),
    service.reorderQueue('phase5b-room', [ids[1], ids[2], ids[0]], {
      baseVersion: third.version,
      generation: third.musicGeneration,
      mutationId: 'queue-reorder-b',
    }, host),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((entry) => entry.status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  assert.equal(rejected?.reason.code, 'STALE_VERSION');

  const current = await service.getSnapshot('phase5b-room', host);
  const removed = await service.removeQueueItem('phase5b-room', current.queue[0].queueItemId, {
    baseVersion: current.version,
    generation: current.musicGeneration,
    mutationId: 'queue-remove',
  }, host);
  assert.equal(removed.queue.length, 2);
  const cleared = await service.clearQueue('phase5b-room', {
    baseVersion: removed.version,
    generation: removed.musicGeneration,
    mutationId: 'queue-clear',
  }, host);
  assert.deepEqual(cleared.queue, []);
  assert.equal(cleared.currentQueueItemId, null);
  assert.equal(cleared.isPlaying, false);
});

test('Music control requests are bound to the host and expire without execution', async (t) => {
  const originalNow = Date.now;
  let now = 5_000;
  Date.now = () => now;
  const dataSource = await createMusicDataSource();
  t.after(async () => {
    Date.now = originalNow;
    await dataSource.destroy();
  });
  const service = new MusicSyncService(dataSource, new RealtimeSyncCore());
  service.setOnlineChecker((socketId) => socketId === 'host-socket');
  const added = await service.addQueueItem('phase5b-room', item('request', 'request'), {
    mutationId: 'request-add',
  }, host);
  const viewer = { socketId: 'viewer-socket', userId: 2, role: 'user' };
  const request = await service.createControlRequest(
    'phase5b-room',
    viewer,
    'play',
    { baseVersion: added.version, generation: added.musicGeneration, mutationId: 'request-play' },
  );
  assert.equal(request.targetHostSocketId, 'host-socket');
  await assert.rejects(
    () => service.applyRequestedControl(request, { socketId: 'forged-host', userId: 3, role: 'user' }),
    (error) => error instanceof MusicSyncError && error.code === 'FORBIDDEN',
  );
  now += 31_000;
  assert.equal(service.getControlRequest(request.requestId), null);
  await assert.rejects(
    () => service.applyRequestedControl(request, host),
    (error) => error instanceof MusicSyncError && error.code === 'STALE_REQUEST',
  );
  service.setOnlineChecker(() => false);
  const offline = await service.getSnapshot('phase5b-room', host);
  assert.equal(offline.hostOffline, true);
  await assert.rejects(
    () => service.createControlRequest('phase5b-room', viewer, 'play', {
      baseVersion: offline.version,
      generation: offline.musicGeneration,
      mutationId: 'request-offline',
    }),
    (error) => error instanceof MusicSyncError && error.code === 'HOST_OFFLINE',
  );
});

test('Music clock is isolated from the video clock and stale heartbeat/ACK cannot cross generations', async (t) => {
  const core = new RealtimeSyncCore();
  core.commit('same-room', { sourceGeneration: 7, mutationId: 'video-1' }, 1000);
  core.commitDomain('same-room', { generation: 3, mutationId: 'music-1' }, 1001, 'music');
  assert.deepEqual(core.current('same-room'), { version: 1, sourceGeneration: 7, serverTimestamp: 1000 });
  assert.equal(core.currentDomain('same-room', 'music').generation, 3);

  const dataSource = await createMusicDataSource();
  t.after(() => dataSource.destroy());
  const service = new MusicSyncService(dataSource, new RealtimeSyncCore());
  const added = await service.addQueueItem('phase5b-room', item('heartbeat', 'heartbeat'), { mutationId: 'heartbeat-add' }, host);
  await assert.rejects(
    () => service.applyHeartbeat('phase5b-room', {
      roomId: 'phase5b-room',
      queueItemId: added.currentQueueItemId,
      musicGeneration: added.musicGeneration - 1,
      positionSec: 2,
      isPlaying: true,
      baseVersion: added.version,
    }, host),
    (error) => error instanceof MusicSyncError && error.code === 'STALE_GENERATION',
  );
  await assert.rejects(
    () => service.recordTrackAck(host, {
      roomId: 'phase5b-room',
      queueItemId: added.currentQueueItemId,
      musicGeneration: added.musicGeneration,
      version: added.version - 1,
      ready: true,
    }),
    (error) => error instanceof MusicSyncError && error.code === 'STALE_VERSION',
  );
  const heartbeat = await service.applyHeartbeat('phase5b-room', {
    roomId: 'phase5b-room',
    queueItemId: added.currentQueueItemId,
    musicGeneration: added.musicGeneration,
    positionSec: 2,
    isPlaying: true,
    playbackRate: 1,
    baseVersion: added.version,
  }, host);
  assert.equal(heartbeat.version, added.version);
  assert.equal(heartbeat.positionSec, 2);
  const ended = await service.applyEnded('phase5b-room', {
    baseVersion: heartbeat.version,
    generation: heartbeat.musicGeneration,
    mutationId: 'ended-once',
  }, host, added.currentQueueItemId);
  assert.equal(ended.isPlaying, false);
  assert.equal(ended.positionSec, 4);
  await assert.rejects(
    () => service.applyEnded('phase5b-room', {
      baseVersion: heartbeat.version,
      generation: heartbeat.musicGeneration,
      mutationId: 'ended-stale',
    }, host, added.currentQueueItemId),
    (error) => error instanceof MusicSyncError && error.code === 'STALE_GENERATION',
  );
});

test('Music permissions distinguish queue management, host authority, and viewer requests', () => {
  const facts = (actorRole, isHost = actorRole === 'owner') => ({ actorRole, userId: 1, isHost, isRoomMember: true });
  assert.equal(canPerformRoomAction(facts('moderator'), 'music.queue.add').allowed, true);
  assert.equal(canPerformRoomAction(facts('moderator'), 'music.play').allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'music.play').allowed, true);
  assert.equal(canPerformRoomAction(facts('owner', false), 'music.play').allowed, false);
  assert.equal(canPerformRoomAction(facts('member'), 'music.control.request').allowed, true);
  assert.equal(canPerformRoomAction(facts('guest'), 'music.control.request').allowed, false);
});
