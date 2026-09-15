const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  VoiceChatHandler,
  __resetVoiceStateForTests,
  __sweepVoiceGhostsForTests,
} = require('../dist/modules/voice-chat/voice-chat.handler');
const { roomPermissionService } = require('../dist/modules/room/room-permission.service');

class FakeSocket extends EventEmitter {
  constructor(id, data = {}) {
    super();
    this.id = id;
    this.data = data;
    this.rooms = new Set(['room-1']);
    this.connected = true;
    this.received = [];
  }

  to(roomId) {
    return this.io.to(roomId, this.id);
  }
}

function createIo(sockets) {
  const io = {
    sockets: { sockets: new Map(sockets.map((socket) => [socket.id, socket])) },
    to(roomId, excludedSocketId) {
      return {
        emit(event, payload) {
          if (io.sockets.sockets.has(roomId)) {
            const target = io.sockets.sockets.get(roomId);
            target.received.push({ event, payload });
            return;
          }
          for (const target of io.sockets.sockets.values()) {
            if (target.id !== excludedSocketId && target.rooms.has(roomId)) {
              target.received.push({ event, payload });
            }
          }
        },
      };
    },
  };
  for (const socket of sockets) socket.io = io;
  return io;
}

function emitEvent(socket, event, payload) {
  return new Promise((resolve) => {
    EventEmitter.prototype.emit.call(socket, event, payload, resolve);
  });
}

function join(socket) {
  return emitEvent(socket, 'voice-join', {
    roomId: 'room-1',
    username: socket.data.username,
  });
}

function setup(sockets) {
  __resetVoiceStateForTests();
  const io = createIo(sockets);
  const handler = new VoiceChatHandler();
  for (const socket of sockets) handler.register(socket, io);
  return { io, handler };
}

test.afterEach(() => {
  __resetVoiceStateForTests();
  roomPermissionService.isRoomHostOrModerator = async () => false;
  roomPermissionService.isRoomHost = async () => false;
  roomPermissionService.canModeratorActOn = async () => null;
});

test('uses stable identity and replaces a reconnect without stale disconnect removal', async () => {
  const first = new FakeSocket('socket-a', { userId: 7, role: 'user', username: 'alice' });
  const replacement = new FakeSocket('socket-b', { userId: 7, role: 'user', username: 'alice' });
  const observer = new FakeSocket('observer', { userId: 8, role: 'user', username: 'bob' });
  const { io, handler } = setup([first, replacement, observer]);

  const firstJoin = await join(first);
  const secondJoin = await join(replacement);

  assert.equal(firstJoin.success, true);
  assert.equal(secondJoin.success, true);
  assert.equal(secondJoin.members.length, 0);
  assert.ok(observer.received.some((item) => item.event === 'voice-user-left' && item.payload.socketId === 'socket-a'));
  const joined = observer.received.filter((item) => item.event === 'voice-user-joined');
  assert.equal(joined.at(-1).payload.identity, 'user:7');
  assert.equal(joined.at(-1).payload.socketId, 'socket-b');
  assert.equal(joined.at(-1).payload.generation, 2);

  EventEmitter.prototype.emit.call(first, 'disconnect');
  assert.equal(observer.received.filter((item) => item.event === 'voice-user-left' && item.payload.socketId === 'socket-b').length, 0);

  handler.dispose();
});

test('serializes rapid reconnect joins so the last connection remains active', async () => {
  const sockets = ['a', 'b', 'c'].map((id) =>
    new FakeSocket('rapid-' + id, { userId: 11, role: 'user', username: 'rapid' }),
  );
  const { io, handler } = setup(sockets);
  const results = await Promise.all(sockets.map(join));

  assert.equal(results.filter((result) => result.success).length, 3);
  assert.equal(results[2].members.length, 0);
  for (const socket of sockets.slice(0, 2)) {
    const joinedEvents = socket.received.filter((item) => item.event === 'voice-user-joined');
    assert.equal(joinedEvents.at(-1).payload.socketId, 'rapid-c');
    assert.equal(joinedEvents.at(-1).payload.generation, 3);
  }

  handler.dispose();
});

test('drops muted, malformed and oversized packets at the server boundary', async () => {
  const host = new FakeSocket('host', { userId: 1, role: 'user', username: 'host' });
  const target = new FakeSocket('target', { userId: 0, role: 'guest', username: 'target' });
  const observer = new FakeSocket('observer', { userId: 3, role: 'user', username: 'observer' });
  const { io, handler } = setup([host, target, observer]);
  roomPermissionService.isRoomHostOrModerator = async (socket) => socket === host;
  roomPermissionService.isRoomHost = async (socket) => socket === host;

  await join(host);
  await join(target);
  await join(observer);
  const muted = await emitEvent(host, 'voice-mute', {
    roomId: 'room-1',
    socketId: target.id,
    muted: true,
  });
  assert.deepEqual(muted, { success: true });

  const before = observer.received.filter((item) => item.event === 'voice-audio-data').length;
  EventEmitter.prototype.emit.call(target, 'voice-audio-data', {
    roomId: 'room-1',
    data: new ArrayBuffer(1920),
    codec: 'pcm-s16',
    sampleRate: 48000,
    channels: 1,
    frameSamples: 960,
    timestamp: Date.now(),
    encoded: false,
  });
  EventEmitter.prototype.emit.call(host, 'voice-audio-data', {
    roomId: 'room-1',
    data: new ArrayBuffer(1920),
    codec: 'pcm-s16',
    sampleRate: 44100,
    channels: 1,
    frameSamples: 960,
    timestamp: Date.now(),
    encoded: false,
  });
  EventEmitter.prototype.emit.call(host, 'voice-audio-data', {
    roomId: 'room-1',
    data: new ArrayBuffer(65 * 1024),
    codec: 'opus',
    sampleRate: 48000,
    channels: 1,
    frameSamples: 960,
    timestamp: Date.now(),
    encoded: true,
  });
  const after = observer.received.filter((item) => item.event === 'voice-audio-data').length;
  assert.equal(after, before);

  handler.dispose();
});

test('enforces moderator target protection, kick cooldown and ghost sweep', async () => {
  const moderator = new FakeSocket('moderator', { userId: 4, role: 'user', username: 'mod' });
  const root = new FakeSocket('root', { userId: 5, role: 'root', username: 'root' });
  const guest = new FakeSocket('guest', { userId: 0, role: 'guest', username: 'guest' });
  const { io, handler } = setup([moderator, root, guest]);
  roomPermissionService.isRoomHostOrModerator = async (socket) => socket === moderator;
  roomPermissionService.isRoomHost = async () => false;
  roomPermissionService.canModeratorActOn = async (_roomId, _targetId, targetRole) =>
    targetRole === 'root' ? '不能对管理员操作' : null;

  await join(moderator);
  await join(root);
  await join(guest);
  const denied = await emitEvent(moderator, 'voice-mute', {
    roomId: 'room-1',
    socketId: root.id,
    muted: true,
  });
  assert.deepEqual(denied, { success: false, message: '不能对管理员操作' });

  const kicked = await emitEvent(moderator, 'voice-kick', {
    roomId: 'room-1',
    socketId: guest.id,
  });
  assert.deepEqual(kicked, { success: true });
  const rejoin = await join(guest);
  assert.equal(rejoin.success, false);
  assert.match(rejoin.message, /秒后可重新加入/);

  io.sockets.sockets.delete(root.id);
  __sweepVoiceGhostsForTests(io);
  assert.ok(guest.received.some((item) => item.event === 'voice-user-left' && item.payload.socketId === root.id));

  handler.dispose();
});
