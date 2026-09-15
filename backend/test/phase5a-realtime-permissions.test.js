const test = require('node:test');
const assert = require('node:assert/strict');

const { RealtimeSyncCore } = require('../dist/modules/realtime-sync-core/realtime-sync-core.service');
const { VideoSyncDomain } = require('../dist/modules/sync-playback/video-sync.domain');
const { canPerformRoomAction } = require('../dist/modules/room/permission-core');
const { AppDataSource } = require('../dist/data-source');
const { Room } = require('../dist/entities/Room');
const { Session } = require('../dist/entities/Session');
const { RoomSessionService } = require('../dist/modules/room/room-session.service');
const { playbackMemoryService } = require('../dist/modules/playback-memory/playback-memory.service');
const { roomPermissionService } = require('../dist/modules/room/room-permission.service');
const { realtimeSyncCore } = require('../dist/modules/realtime-sync-core');

test('RealtimeSyncCore enforces monotonic version, duplicate and generation guards', () => {
  const core = new RealtimeSyncCore();
  const first = core.commit('room-a', { sourceGeneration: 1, mutationId: 'm1' }, 1_000);
  assert.deepEqual(first, { ok: true, version: 1, sourceGeneration: 1, serverTimestamp: 1_000 });
  assert.equal(core.commit('room-a', { sourceGeneration: 1, mutationId: 'm1' }, 1_001).code, 'DUPLICATE');
  assert.equal(core.commit('room-a', { sourceGeneration: 1, baseVersion: 0, mutationId: 'm2' }, 1_002).code, 'STALE_VERSION');
  assert.equal(core.commit('room-a', { sourceGeneration: 0, baseVersion: 1, mutationId: 'm3' }, 1_003).code, 'STALE_GENERATION');
  const second = core.commit('room-a', { sourceGeneration: 1, baseVersion: 1, mutationId: 'm4' }, 1_004);
  assert.equal(second.version, 2);
  const nextGeneration = core.commit('room-a', { sourceGeneration: 2, baseVersion: 2, mutationId: 'm5' }, 1_005);
  assert.equal(nextGeneration.version, 3);
  assert.equal(core.shouldApplyEvent(2, 3, 2, 3), false);
  assert.equal(core.shouldApplyEvent(2, 3, 2, 2), false);
  assert.equal(core.shouldApplyEvent(2, 3, 2, 4), true);
  assert.equal(core.shouldApplyEvent(2, 3, 1, 99), false);
});

test('RealtimeSyncCore rejects absurd clocks and keeps readiness generation-bound', () => {
  const core = new RealtimeSyncCore();
  assert.equal(core.commit('room-a', { clientTimestamp: Number.NaN }, 100).code, 'INVALID_TIMESTAMP');
  assert.equal(core.commit('room-a', { clientTimestamp: Number.POSITIVE_INFINITY }, 100).code, 'INVALID_TIMESTAMP');
  assert.equal(core.commit('room-a', { clientTimestamp: -1_000_000_000 }, 100).code, 'INVALID_TIMESTAMP');
  core.commit('room-a', { sourceGeneration: 4, mutationId: 'seed' }, 100);
  assert.equal(core.recordReadiness('room-a', 'socket-a', 3), false);
  assert.equal(core.recordReadiness('room-a', 'socket-a', 4), true);
  core.clearSocket('socket-a');
  assert.equal(core.recordReadiness('room-a', 'socket-a', 4), true);
});

test('VideoSyncDomain bounds malformed playback payloads', () => {
  const base = {
    sourceUrl: 'https://example.test/video.mp4', sourceType: 'url', isPlaying: false,
    currentTime: 0, playbackRate: 1, duration: 10, sourceGeneration: 1,
  };
  assert.equal(VideoSyncDomain.validateState({ ...base, currentTime: Number.NaN }).ok, false);
  assert.equal(VideoSyncDomain.validateState({ ...base, playbackRate: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(VideoSyncDomain.validateState({ ...base, sourceUrl: 'x'.repeat(9000) }).ok, false);
  assert.equal(VideoSyncDomain.validateState(base).ok, true);
});

function facts(actorRole, overrides = {}) {
  return { actorRole, userId: 1, isHost: actorRole === 'owner', isRoomMember: true, ...overrides };
}

function target(role, overrides = {}) {
  return { role, userId: 2, isRoomMember: true, isSelf: false, ...overrides };
}

test('Room Permission Core covers role/action anti-escalation matrix', () => {
  assert.equal(canPerformRoomAction(facts('guest'), 'playback.play').allowed, false);
  assert.equal(canPerformRoomAction(facts('member'), 'playback.seek').allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'playback.seek').allowed, true);
  assert.equal(canPerformRoomAction(facts('owner'), 'viewer.approve').allowed, true);
  assert.equal(canPerformRoomAction(facts('member'), 'viewer.reject').allowed, false);
  assert.equal(canPerformRoomAction(facts('system'), 'host.transfer', target('member')).allowed, true);
  assert.equal(canPerformRoomAction(facts('moderator'), 'voice.mute', target('member')).allowed, true);
  assert.equal(canPerformRoomAction(facts('moderator'), 'voice.kick', target('owner')).allowed, false);
  assert.equal(canPerformRoomAction(facts('moderator'), 'voice.kick', target('moderator')).allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'viewer.mute', target('system')).allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'viewer.kick', target('member', { isSelf: true })).allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'moderator.manage', target('member')).allowed, true);
  assert.equal(canPerformRoomAction(facts('moderator'), 'moderator.manage', target('member')).allowed, false);
  assert.equal(canPerformRoomAction(facts('owner'), 'moderator.manage', target('owner')).allowed, false);
});

test('RealtimeSyncCore serializes concurrent room mutations', async () => {
  const core = new RealtimeSyncCore();
  const order = [];
  await Promise.all([
    core.withRoomLock('room-a', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 5)); order.push('a-end'); }),
    core.withRoomLock('room-a', async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

function createTransferManager(state, failOnRoomUpdate = false) {
  const matches = (entity, where) => Object.entries(where).every(([key, expected]) => {
    if (key === 'endedAt' && expected && expected._type === 'isNull') return entity[key] === null;
    return entity[key] === expected;
  });
  return {
    async findOne(Entity, options) {
      const where = options.where;
      if (Entity === Room) return matches(state.room, where) ? state.room : null;
      return state.sessions.find((session) => matches(session, where)) ?? null;
    },
    async count(Entity, options) {
      assert.equal(Entity, Session);
      return state.sessions.filter((session) => matches(session, options.where)).length;
    },
    async update(Entity, where, values) {
      if (Entity === Room && failOnRoomUpdate) throw new Error('simulated room persistence failure');
      const target = Entity === Room
        ? (state.room.id === where.id ? state.room : null)
        : state.sessions.find((session) => matches(session, where));
      if (!target) throw new Error('fake update target missing');
      Object.assign(target, values);
    },
  };
}

function transferState() {
  return {
    room: { id: 1, roomId: 'transfer-room', status: 'active', ownerUserId: 1, moderators: '[2]' },
    sessions: [
      { id: 1, roomId: 'transfer-room', socketId: 'old-host', userId: 1, role: 'sharer', endedAt: null },
      { id: 2, roomId: 'transfer-room', socketId: 'new-host', userId: 2, role: 'viewer', endedAt: null },
    ],
  };
}

test('host transfer is atomic, removes the new host moderator row, and invalidates the old authority', async () => {
  const state = transferState();
  const manager = createTransferManager(state);
  const originalTransaction = AppDataSource.transaction;
  const originalUpdateHostSocket = playbackMemoryService.updateHostSocket;
  const originalInvalidate = roomPermissionService.invalidatePermissionCache;
  const cacheInvalidations = [];
  let playbackHostUpdate;
  AppDataSource.transaction = async (callback) => callback(manager);
  playbackMemoryService.updateHostSocket = async (...args) => { playbackHostUpdate = args; };
  roomPermissionService.invalidatePermissionCache = (...args) => { cacheInvalidations.push(args); };
  try {
    await new RoomSessionService().transferHost('transfer-room', 'new-host', 'old-host', 2);
    assert.equal(state.room.ownerUserId, 2);
    assert.equal(state.room.moderators, '[]');
    assert.equal(state.sessions.find((session) => session.socketId === 'old-host').role, 'viewer');
    assert.equal(state.sessions.find((session) => session.socketId === 'new-host').role, 'sharer');
    assert.deepEqual(playbackHostUpdate, ['transfer-room', 'new-host']);
    assert.equal(cacheInvalidations.length, 2);
    assert.equal(canPerformRoomAction(facts('member'), 'playback.seek').allowed, false);
    assert.equal(canPerformRoomAction(facts('owner'), 'playback.seek').allowed, true);
  } finally {
    AppDataSource.transaction = originalTransaction;
    playbackMemoryService.updateHostSocket = originalUpdateHostSocket;
    roomPermissionService.invalidatePermissionCache = originalInvalidate;
    realtimeSyncCore.clearRoom('transfer-room');
  }
});

test('concurrent transfer and persistence failure cannot create split-brain host state', async () => {
  const state = transferState();
  const originalTransaction = AppDataSource.transaction;
  const originalUpdateHostSocket = playbackMemoryService.updateHostSocket;
  const originalInvalidate = roomPermissionService.invalidatePermissionCache;
  let playbackHostUpdates = 0;
  AppDataSource.transaction = async (callback) => callback(createTransferManager(state));
  playbackMemoryService.updateHostSocket = async () => { playbackHostUpdates += 1; };
  roomPermissionService.invalidatePermissionCache = () => {};
  try {
    const results = await Promise.allSettled([
      new RoomSessionService().transferHost('transfer-room', 'new-host', 'old-host', 2),
      new RoomSessionService().transferHost('transfer-room', 'new-host', 'old-host', 2),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(state.sessions.filter((session) => session.role === 'sharer').length, 1);
    assert.equal(playbackHostUpdates, 1);

    const rollbackState = transferState();
    const rollbackManager = createTransferManager(rollbackState, true);
    AppDataSource.transaction = async (callback) => {
      const before = JSON.parse(JSON.stringify(rollbackState));
      try {
        return await callback(rollbackManager);
      } catch (error) {
        rollbackState.room = before.room;
        rollbackState.sessions = before.sessions;
        throw error;
      }
    };
    await assert.rejects(() => new RoomSessionService().transferHost('transfer-room', 'new-host', 'old-host', 2));
    assert.equal(rollbackState.room.ownerUserId, 1);
    assert.equal(rollbackState.sessions.find((session) => session.socketId === 'old-host').role, 'sharer');
    assert.equal(rollbackState.sessions.find((session) => session.socketId === 'new-host').role, 'viewer');
  } finally {
    AppDataSource.transaction = originalTransaction;
    playbackMemoryService.updateHostSocket = originalUpdateHostSocket;
    roomPermissionService.invalidatePermissionCache = originalInvalidate;
    realtimeSyncCore.clearRoom('transfer-room');
  }
});
