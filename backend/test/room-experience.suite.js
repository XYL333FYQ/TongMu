const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-room-experience-'));
process.env.CONFIG_DIR = testConfig;
const { createSequentialTestHarness } = require('./helpers/sequential-test-harness');
const { sharedSqlJs } = require('./helpers/shared-sqljs');
const { AppDataSource } = require('../dist/data-source');
const { Room } = require('../dist/entities/Room');
const { Session } = require('../dist/entities/Session');
const { MusicRoomState } = require('../dist/entities/MusicRoomState');
const { PlaybackState } = require('../dist/entities/PlaybackState');
const { Movie } = require('../dist/entities/Movie');
const { HeartbeatHandler } = require('../dist/modules/sync-playback/heartbeat.handler');
const { ViewerEventsHandler } = require('../dist/modules/webrtc-signaling/viewer-events.handler');
const { SignalingHandler } = require('../dist/modules/webrtc-signaling/signaling.handler');
const { MovieListHandler } = require('../dist/modules/movie/handlers/movie-list.handler');
const { RoomLifecycleHandler, RegisterHostHandler, RoomExperienceHandler } = require('../dist/modules/room');
const { ViewerJoinHandler } = require('../dist/modules/viewer/handlers/viewer-join.handler');
const { ViewerManagementHandler } = require('../dist/modules/viewer/handlers/viewer-management.handler');
const { RoomSettingsHandler } = require('../dist/modules/room/handlers/room-settings.handler');
const { RoomDisconnectHandler } = require('../dist/modules/room/handlers/room-disconnect.handler');
const { roomExperienceService } = require('../dist/modules/room/room-experience.service');
const { roomPermissionService } = require('../dist/modules/room/room-permission.service');
const { roomSessionService } = require('../dist/modules/room/room-session.service');
const { roomStateService } = require('../dist/modules/room/room-state.service');
const { musicSyncService, MusicSyncService } = require('../dist/modules/music/music-sync.service');
const { playbackMemoryService } = require('../dist/modules/playback-memory');
const { RealtimeSyncCore, realtimeSyncCore } = require('../dist/modules/realtime-sync-core');
const { roomDelegates, roomScreenPresenters } = require('../dist/modules/room/room-policy');
const test = createSequentialTestHarness();
let serial = 0;

class TestSocket {
  constructor(io, id, userId, role = 'user') {
    this.id = id; this.io = io; this.connected = true; this.rooms = new Set(); this.events = []; this.handlers = new Map();
    this.data = { userId, role, username: role === 'guest' ? 'guest' : id, guestId: role === 'guest' ? `identity-${id}` : undefined };
    io.sockets.sockets.set(id, this);
    for (const Handler of [RoomLifecycleHandler, RegisterHostHandler, ViewerJoinHandler, ViewerManagementHandler, RoomExperienceHandler, RoomSettingsHandler, HeartbeatHandler, ViewerEventsHandler, SignalingHandler, MovieListHandler]) new Handler().register(this, io);
  }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.events.push({ event, payload }); }
  to(target) { return this.io.to(target, this.id); }
  async join(roomId) { this.rooms.add(roomId); }
  async leave(roomId) { this.rooms.delete(roomId); }
  disconnect() { this.connected = false; this.io.sockets.sockets.delete(this.id); }
  invoke(event, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`missing ACK: ${event}`)), 3000);
      const callback = result => { clearTimeout(timer); resolve(result); };
      const handler = this.handlers.get(event);
      Promise.resolve(payload === undefined ? handler(callback) : handler(payload, callback)).catch(reject);
    });
  }
}
async function fixture(t, policy = {}) {
  if (!AppDataSource.isInitialized) {
    AppDataSource.setOptions({ driver: await sharedSqlJs, location: undefined, autoSave: false, autoSaveCallback: undefined, synchronize: true, logging: false });
    await AppDataSource.initialize();
  }
  const io = { sockets: { sockets: new Map() },
    to(target, exclude) { return { emit(event, payload) { for (const socket of io.sockets.sockets.values()) if (socket.id !== exclude && (socket.id === target || socket.rooms.has(target))) socket.emit(event, payload); } }; },
    in(id) { return { async fetchSockets() { return [...io.sockets.sockets.values()].filter(s => s.rooms.has(id)); } }; },
  };
  musicSyncService.setOnlineChecker(id => !!io.sockets.sockets.get(id)?.connected);
  const host = new TestSocket(io, `host-${++serial}`, serial * 10, 'root');
  const created = await host.invoke('create-room', { name: 'A real room', policy });
  assert.equal(created.success, true);
  const roomId = created.data.roomId;
  const member = new TestSocket(io, `member-${serial}`, serial * 10 + 1);
  const guest = new TestSocket(io, `guest-${serial}`, 0, 'guest');
  t.after(async () => {
    roomExperienceService.clear(roomId); roomStateService.delete(roomId);
    await musicSyncService.deletePersistedRoomData(roomId); await playbackMemoryService.clearPlayback(roomId);
    await AppDataSource.getRepository(Session).delete({ roomId }); await AppDataSource.getRepository(Room).delete({ roomId });
    await AppDataSource.getRepository(Movie).delete({ roomId });
    realtimeSyncCore.clearRoom(roomId);
  });
  return { io, host, member, guest, roomId, created };
}

async function holdRoomQueue(roomId) {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const held = realtimeSyncCore.withRoomLock(roomId, async () => { entered(); await gate; });
  await ready;
  return { release, held };
}

async function movieHttpFixture(t, io) {
  const express = require('express');
  const auth = require('../dist/middleware/auth');
  const originalAuth = auth.authenticateToken;
  // Authentication itself is covered elsewhere; bind the HTTP identity to a
  // real fixture socket and exercise current room grants and permissions here.
  auth.authenticateToken = (req, res, next) => {
    const actor = io.sockets.sockets.get(req.get('X-Test-Actor'));
    if (!actor) return res.sendStatus(401);
    req.user = { ...actor.data };
    next();
  };
  const { createMovieRouter } = require('../dist/modules/movie/movie.routes');
  const app = express(); app.use(express.json()); app.use('/api/rooms', createMovieRouter(io));
  auth.authenticateToken = originalAuth;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { createRoomMediaGrant } = require('../dist/services/media/room-access');
  return (socket, roomId, method, suffix = '', body, grant = createRoomMediaGrant(roomId, socket.id)) => fetch(
    `http://127.0.0.1:${server.address().port}/api/rooms/${roomId}/movies${suffix}`,
    { method, headers: { 'Content-Type': 'application/json', 'X-Test-Actor': socket.id, 'X-Room-Grant': grant },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );
}

async function mediaHttpFixture(t, io, resolve) {
  const express = require('express');
  const { generateTokens } = require('../dist/middleware/auth');
  const { createRoomMediaGrant } = require('../dist/services/media/room-access');
  const { User } = require('../dist/entities/User');
  const users = AppDataSource.getRepository(User); const addedUsers = [];
  t.after(() => addedUsers.length ? users.delete(addedUsers) : undefined);
  const resolvers = require('../dist/services/media/resolvers');
  const helpers = require('../dist/routes/stream/helpers');
  const oldResolve = resolvers.resolveMediaProvider; const oldCookie = helpers.getUserCookie;
  helpers.getUserCookie = async () => undefined;
  resolvers.resolveMediaProvider = resolve ?? (async input => {
    const descriptor = { title: 'Resolved public film', input, originalUrl: input, finalUrl: input,
      sourceType: 'url', resolver: 'direct-url', transport: 'direct', container: 'mp4', contentType: 'video/mp4',
      drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] } };
    return { descriptor, privateSource: { input, originalUrl: input, finalUrl: input }, candidates: [] };
  });
  t.after(() => { resolvers.resolveMediaProvider = oldResolve; helpers.getUserCookie = oldCookie; });
  const app = express(); app.set('io', io); app.set('trust proxy', 'loopback'); app.use(express.json());
  app.use('/api/stream', require('../dist/routes/stream/media').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const actorIps = new Map();
  return async (socket, roomId, input = 'https://media.example/public.mp4', options = {}) => {
    const actor = options.actor ?? socket.data;
    if (actor.userId > 0 && !(await users.findOneBy({ id: actor.userId }))) {
      await users.save(users.create({ id: actor.userId, username: actor.username, passwordHash: 'fixture-password-hash', role: actor.role, status: 'active' }));
      addedUsers.push(actor.userId);
    }
    const token = generateTokens(actor.userId, actor.role, actor.username, actor.guestId).accessToken;
    if (!actorIps.has(socket.id)) actorIps.set(socket.id, `192.0.${serial}.${actorIps.size + 1}`);
    const grant = options.grant === undefined ? createRoomMediaGrant(roomId, socket.id) : options.grant;
    return fetch(`http://127.0.0.1:${server.address().port}/api/stream/media/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        'X-Forwarded-For': actorIps.get(socket.id), ...(grant ? { 'X-Room-Grant': grant } : {}) },
      body: JSON.stringify({ input, ...(roomId ? { roomId } : {}), ...(grant ? { roomGrant: grant } : {}) }),
    });
  };
}

async function waitForMediaResolve(ready) {
  let timeout;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('media fixture resolver was not reached')), 2000); })]);
  } finally { clearTimeout(timeout); }
}

test('room media resolution follows select-content permissions and binds live grants to the authenticated actor', async t => {
  const { io, host, member, guest, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  const request = await mediaHttpFixture(t, io);
  const { createRoomMediaGrant } = require('../dist/services/media/room-access');
  assert.equal((await member.invoke('room:experience:get', { roomId })).data.permissions.selectContent, true);
  const selected = await request(member, roomId);
  assert.equal(selected.status, 200); assert.equal((await selected.json()).success, true);
  assert.equal((await request(guest, roomId)).status, 403);
  assert.equal((await request(member, roomId, undefined, { grant: null })).status, 403);
  assert.equal((await request(member, roomId, undefined, { grant: createRoomMediaGrant(roomId, host.id) })).status, 403);
  const outsider = new TestSocket(io, `outside-root-${serial}`, host.data.userId + 2, 'root');
  assert.equal((await request(outsider, roomId, undefined, { grant: createRoomMediaGrant(roomId, host.id) })).status, 403);
  await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'shared', guestCollaboration: true } });
  assert.equal((await request(guest, roomId)).status, 200);
  assert.equal((await request(guest, roomId, undefined, { actor: { ...guest.data, guestId: 'another-guest' } })).status, 403);
  await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'shared', guestCollaboration: true, permissions: { selectContent: false } } });
  assert.equal((await request(member, roomId)).status, 403);
  assert.equal((await request(guest, roomId)).status, 403);
  assert.equal((await request(host, roomId)).status, 200);
  await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'shared', guestCollaboration: true } });
  guest.connected = false;
  assert.equal((await request(guest, roomId)).status, 403);
  await member.invoke('room:leave', { roomId });
  assert.equal((await request(member, roomId)).status, 403);
  await AppDataSource.getRepository(Room).update({ roomId }, { status: 'closed' });
  assert.equal((await request(host, roomId)).status, 403);
});

test('new media inputs use only the selecting user’s private mount while a stored room item can be refreshed safely', async t => {
  const { io, host, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  const { UserMount } = require('../dist/entities/UserMount');
  const { WebDavProvider } = require('../dist/services/media/providers/storage-providers');
  const { buildStorageReference } = require('../dist/services/media/providers/storage-reference');
  const { providerContextFromResolverContext } = require('../dist/services/media/providers/registry');
  const mounts = AppDataSource.getRepository(UserMount);
  const ownerMount = await mounts.save(mounts.create({ userId: host.data.userId, type: 'webdav', name: 'Owner private storage',
    serverUrl: 'https://owner-storage.example/dav', username: 'owner-private-user', password: 'owner-private-secret' }));
  const memberMount = await mounts.save(mounts.create({ userId: member.data.userId, type: 'webdav', name: 'Member private storage',
    serverUrl: 'https://member-storage.example/dav', username: 'member-private-user', password: 'member-private-secret' }));
  t.after(() => mounts.delete([ownerMount.id, memberMount.id]));
  const statCalls = [];
  const provider = new WebDavProvider({ statWebDAV: async params => {
    statCalls.push(params);
    return { name: 'selected.mp4', path: params.path, size: 100, lastModified: new Date(1) };
  } });
  const request = await mediaHttpFixture(t, io, (input, context) => provider.resolve(providerContextFromResolverContext(context), input));
  const ownReference = buildStorageReference({ provider: 'webdav', mountId: memberMount.id, path: '/selected.mp4' });
  const foreignReference = buildStorageReference({ provider: 'webdav', mountId: ownerMount.id, path: '/selected.mp4' });
  const ownResponse = await request(member, roomId, ownReference);
  assert.equal(ownResponse.status, 200);
  const ownBody = await ownResponse.json();
  assert.equal(ownBody.success, true); assert.equal(statCalls[0].username, memberMount.username);
  for (const secret of [memberMount.username, memberMount.password, ownerMount.username, ownerMount.password]) {
    assert.equal(JSON.stringify(ownBody).includes(secret), false);
  }
  assert.equal((await request(member, roomId, foreignReference)).status, 422);
  assert.equal(statCalls.length, 1, 'a foreign new mount is rejected before contacting its source');
  await host.invoke('add-movie', { roomId, movie: { title: 'One shared private film', url: 'https://media.example/selected.mp4',
    source: 'webdav', sourceInput: foreignReference, path: '/selected.mp4', serverUrl: ownerMount.serverUrl } });
  const [movie] = roomStateService.getMovies(roomId);
  const restored = await request(member, roomId, `media-movie:${movie.id}`);
  assert.equal(restored.status, 200); assert.equal((await restored.json()).success, true);
  assert.equal(statCalls.at(-1).path, '/selected.mp4'); assert.equal(statCalls.at(-1).username, ownerMount.username);
  const other = await fixture(t, { collaboration: 'shared' });
  assert.equal((await request(other.host, other.roomId, `media-movie:${movie.id}`)).status, 403);
  assert.equal((await request(member, undefined, `media-movie:${movie.id}`, { grant: null })).status, 403);
});

test('media resolution rechecks revoked permissions and cannot recreate a removed room item after an upstream wait', async t => {
  const { io, host, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  const { movieService } = require('../dist/modules/movie/movie.service');
  const movie = await movieService.createMovie(roomId, { title: 'Legacy film', url: 'https://media.example/old.mp4', sourceInput: 'https://media.example/old.mp4' });
  let entered; let release;
  let ready = new Promise(resolve => { entered = resolve; });
  let gate = new Promise(resolve => { release = resolve; });
  const request = await mediaHttpFixture(t, io, async input => {
    entered(); await gate;
    return { sourceReference: 'https://media.example/stable.mp4', candidates: [],
      privateSource: { input, originalUrl: input, finalUrl: input },
      descriptor: { title: 'Resolved film', input, originalUrl: input, finalUrl: input, sourceType: 'url', resolver: 'direct-url',
        transport: 'direct', container: 'mp4', contentType: 'video/mp4', drm: { protected: false },
        probe: { method: 'resolver', bytesRead: 0, warnings: [] } } };
  });
  t.after(() => release());
  const pending = request(member, roomId, `media-movie:${movie.id}`);
  await waitForMediaResolve(ready);
  await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'host' } });
  release();
  const denied = await pending; assert.equal(denied.status, 403);
  assert.equal((await AppDataSource.getRepository(Movie).findOneBy({ id: movie.id })).sourceInput, 'https://media.example/old.mp4');
  await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'shared' } });
  ready = new Promise(resolve => { entered = resolve; }); gate = new Promise(resolve => { release = resolve; });
  const removed = request(member, roomId, `media-movie:${movie.id}`);
  await waitForMediaResolve(ready);
  await host.invoke('remove-movie', { roomId, movieId: movie.id });
  release(); assert.equal((await removed).status, 403);
  assert.equal(await AppDataSource.getRepository(Movie).countBy({ id: movie.id }), 0);
});

test('legacy movie events respect shared, guest and fine permissions without playing queued content', async t => {
  const { host, member, guest, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  const content = { title: 'Selected film', url: 'https://media.example/film.mp4', username: 'private-user', password: 'private-secret' };
  assert.equal((await member.invoke('add-movie', { roomId, movie: content })).success, true);
  const [movie] = roomStateService.getMovies(roomId);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
  assert.equal(JSON.stringify(movie).includes(content.password), false);
  assert.equal(JSON.stringify(movie).includes(content.username), false);
  assert.equal((await member.invoke('play-movie', { roomId, movieId: movie.id })).success, true);
  for (const [event, payload] of [
    ['add-movie', { roomId, movie: content }], ['remove-movie', { roomId, movieId: movie.id }], ['play-movie', { roomId, movieId: movie.id }],
  ]) assert.equal((await guest.invoke(event, payload)).success, false);
  assert.equal((await host.invoke('update-room-settings', { roomId, policy: { collaboration: 'shared', guestCollaboration: true, permissions: { playback: false } } })).success, true);
  assert.equal((await guest.invoke('add-movie', { roomId, movie: { ...content, title: 'Guest selection' } })).success, true);
  assert.equal((await member.invoke('play-movie', { roomId, movieId: movie.id })).success, false);
  assert.equal((await guest.invoke('play-movie', { roomId, movieId: movie.id })).success, false);
  assert.equal((await guest.invoke('remove-movie', { roomId, movieId: movie.id })).success, true);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
  assert.ok(member.events.some(event => event.event === 'current-movie' && event.payload.movieId === null));
  await host.invoke('room:activity:switch', { roomId, activity: 'listen' });
  const remaining = roomStateService.getMovies(roomId)[0];
  assert.equal((await host.invoke('play-movie', { roomId, movieId: remaining.id })).success, false);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
});

test('movie event authorization waits for earlier room mutations and sees revoked collaboration', async t => {
  const { host, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  await host.invoke('add-movie', { roomId, movie: { title: 'Kept film', url: 'https://media.example/kept.mp4' } });
  const [movie] = roomStateService.getMovies(roomId);
  const queue = await holdRoomQueue(roomId);
  t.after(() => queue.release());
  const originalPermission = roomPermissionService.canPerform;
  let memberChecks = 0;
  roomPermissionService.canPerform = async function(socket, ...args) {
    if (socket.id === member.id) memberChecks += 1;
    return originalPermission.call(this, socket, ...args);
  };
  t.after(() => { roomPermissionService.canPerform = originalPermission; });
  const operations = [
    member.invoke('add-movie', { roomId, movie: { title: 'Blocked film', url: 'https://media.example/blocked.mp4' } }),
    member.invoke('remove-movie', { roomId, movieId: movie.id }),
    member.invoke('play-movie', { roomId, movieId: movie.id }),
  ];
  assert.equal(memberChecks, 0, 'queued mutations must not authorize before acquiring the room lock');
  await AppDataSource.getRepository(Room).update({ roomId }, { policyJson: JSON.stringify({ collaboration: 'host' }) });
  queue.release(); await queue.held;
  for (const result of await Promise.all(operations)) assert.equal(result.success, false);
  assert.equal(await AppDataSource.getRepository(Movie).countBy({ roomId }), 1);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
});

test('HTTP and legacy socket additions share ordering; active grants bind guests to their own identity', async t => {
  const { io, host, member, guest, roomId } = await fixture(t, { collaboration: 'shared', guestCollaboration: true });
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  const request = await movieHttpFixture(t, io);
  const selections = Array.from({ length: 8 }, (_, index) => ({ title: `Film ${index}`, url: `https://media.example/${index}.mp4` }));
  const results = await Promise.all(selections.map((movie, index) => index % 2 === 0
    ? request(member, roomId, 'POST', '', movie).then(async response => { assert.equal(response.status, 201); return (await response.json()).movie; })
    : member.invoke('add-movie', { roomId, movie }).then(response => { assert.equal(response.success, true); })));
  const movies = await AppDataSource.getRepository(Movie).find({ where: { roomId }, order: { order: 'ASC' } });
  assert.deepEqual(movies.map(movie => movie.order), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(roomStateService.getMovies(roomId).length, 8);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
  const selected = results[0];
  const updated = await request(member, roomId, 'PUT', `/${selected.id}`, { title: 'Renamed by member' });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).movie.title, 'Renamed by member');
  assert.equal((await request(member, roomId, 'POST', '/reorder', { orderedIds: movies.map(movie => movie.id).reverse() })).status, 200);
  const otherGuest = new TestSocket(io, `other-guest-${serial}`, 0, 'guest');
  await otherGuest.invoke('request-join', { roomId, nickname: 'Another' });
  const { createRoomMediaGrant } = require('../dist/services/media/room-access');
  const guestGrant = createRoomMediaGrant(roomId, guest.id);
  assert.equal((await request(otherGuest, roomId, 'POST', '', selections[0], guestGrant)).status, 403);
  assert.equal((await request(guest, roomId, 'POST', '', selections[0])).status, 201);
  assert.equal((await request(member, roomId, 'DELETE', `/${selected.id}`)).status, 200);
  await member.invoke('room:leave', { roomId });
  assert.equal((await request(member, roomId, 'POST', '', selections[0])).status, 403);
  assert.equal((await request(host, roomId, 'POST', '', selections[0])).status, 201);
});

test('periodic cleanup preserves a connected room’s new HTTP queue before its first playback state', async t => {
  const { io, host, member, guest, roomId } = await fixture(t);
  io.sockets.adapter = { rooms: { get(id) {
    const online = [...io.sockets.sockets.values()].filter(socket => socket.connected && socket.rooms.has(id)).map(socket => socket.id);
    return online.length ? new Set(online) : undefined;
  } } };
  assert.equal(playbackMemoryService.hasCache(roomId), false);
  assert.equal(playbackMemoryService.isHostOnline(roomId), false, 'no playback record exists before first play');
  const request = await movieHttpFixture(t, io);
  const added = await request(host, roomId, 'POST', '', { title: 'First queued film', url: 'https://media.example/first.mp4' });
  assert.equal(added.status, 201); const movie = (await added.json()).movie;
  assert.equal(roomStateService.getMovies(roomId).length, 1);
  roomStateService.cleanupStaleStates(io);
  assert.deepEqual(roomStateService.getMovies(roomId).map(value => value.id), [movie.id]);
  assert.equal((await guest.invoke('play-movie', { roomId, movieId: movie.id })).success, false);
  assert.equal((await host.invoke('play-movie', { roomId, movieId: movie.id })).success, true);
  assert.equal(roomStateService.getCurrentMovieId(roomId), movie.id);
  await member.invoke('request-join', { roomId });
  host.connected = false;
  roomStateService.cleanupStaleStates(io);
  assert.equal(roomStateService.getCurrentMovieId(roomId), movie.id, 'online members retain the queue while the host is offline');
  member.connected = false;
  roomStateService.cleanupStaleStates(io);
  assert.equal(roomStateService.getActiveRoomIds().includes(roomId), false, 'an offline phantom Session cannot retain runtime state');
  assert.equal(await AppDataSource.getRepository(Movie).countBy({ roomId }), 1, 'durable queue remains recoverable');
});

test('every HTTP movie mutation rechecks collaboration after acquiring the room lock', async t => {
  const { io, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  await member.invoke('add-movie', { roomId, movie: { title: 'Kept film', url: 'https://media.example/kept.mp4' } });
  const [movie] = roomStateService.getMovies(roomId);
  const request = await movieHttpFixture(t, io);
  const originalLock = realtimeSyncCore.withRoomLock;
  for (const [method, suffix, body] of [
    ['POST', '', { title: 'Blocked film', url: 'https://media.example/blocked.mp4' }],
    ['POST', '/reorder', { orders: [{ id: movie.id, order: 10 }] }],
    ['PUT', `/${movie.id}`, { title: 'Blocked title' }],
    ['DELETE', `/${movie.id}`, undefined],
  ]) {
    await AppDataSource.getRepository(Room).update({ roomId }, { policyJson: JSON.stringify({ collaboration: 'shared' }) });
    const queue = await holdRoomQueue(roomId);
    let arrived;
    const queued = new Promise(resolve => { arrived = resolve; });
    realtimeSyncCore.withRoomLock = function(id, operation) {
      if (id === roomId) arrived();
      return originalLock.call(this, id, operation);
    };
    const response = request(member, roomId, method, suffix, body);
    let timeout;
    try {
      await Promise.race([queued, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${method} ${suffix} did not enter the room queue`)), 2000); })]);
      await AppDataSource.getRepository(Room).update({ roomId }, { policyJson: JSON.stringify({ collaboration: 'host' }) });
    } finally {
      clearTimeout(timeout);
      realtimeSyncCore.withRoomLock = originalLock;
      queue.release(); await queue.held;
    }
    assert.equal((await response).status, 403);
  }
  const persisted = await AppDataSource.getRepository(Movie).findOneBy({ id: movie.id, roomId });
  assert.equal(persisted.title, 'Kept film'); assert.equal(persisted.order, 0);
  assert.equal(await AppDataSource.getRepository(Movie).countBy({ roomId }), 1);
});

test('authorized HTTP selections fill only the selecting user’s mount credentials and keep public DTOs private', async t => {
  const { io, host, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  const { UserMount } = require('../dist/entities/UserMount');
  const mounts = AppDataSource.getRepository(UserMount);
  const serverUrl = 'http://192.168.10.20/dav';
  const own = await mounts.save({ userId: member.data.userId, type: 'webdav', name: 'Member source', serverUrl, username: 'member-private-user', password: 'member-private-password' });
  const unrelated = await mounts.save({ userId: host.data.userId, type: 'webdav', name: 'Other source', serverUrl, username: 'other-private-user', password: 'other-private-password' });
  t.after(async () => { await mounts.delete(own.id); await mounts.delete(unrelated.id); });
  const request = await movieHttpFixture(t, io);
  const response = await request(member, roomId, 'POST', '', { title: 'Selected private film', url: `${serverUrl}/selected.mp4`, source: 'webdav', serverUrl, path: '/selected.mp4', directLink: true });
  assert.equal(response.status, 201);
  const dto = (await response.json()).movie;
  const persisted = await AppDataSource.getRepository(Movie).findOneBy({ id: dto.id, roomId });
  assert.equal(persisted.username, own.username); assert.equal(persisted.password, own.password);
  assert.equal(persisted.directLink, false, 'an internal mount retains its original-quality gateway fallback');
  const text = JSON.stringify(dto);
  for (const value of [own.username, own.password, unrelated.username, unrelated.password, serverUrl, '/selected.mp4']) assert.equal(text.includes(value), false);
  assert.equal(dto.serverUrl, null); assert.equal(dto.path, null); assert.equal(dto.username, null); assert.equal(dto.password, null);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
});

test('legacy room renaming cannot apply an old owner authorization after formal transfer', async t => {
  const { host, member, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId });
  // This owner deliberately uses an ordinary account: platform root continues
  // to retain its existing administration rights after ownership changes.
  host.data.role = 'user';
  const queue = await holdRoomQueue(roomId);
  const originalPermission = roomPermissionService.canPerform;
  let renameChecks = 0;
  roomPermissionService.canPerform = async function(socket, ...args) {
    if (socket.id === host.id) renameChecks += 1;
    return originalPermission.call(this, socket, ...args);
  };
  const transfer = roomSessionService.transferHost(roomId, member.id, host.id, member.data.userId);
  const rename = host.invoke('update-room-name', { roomId, name: 'Unauthorized later name' });
  try {
    assert.equal(renameChecks, 0);
  } finally {
    roomPermissionService.canPerform = originalPermission;
    queue.release(); await queue.held;
  }
  await transfer;
  assert.equal((await rename).success, false);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).name, 'A real room');
  assert.equal((await member.invoke('update-room-name', { roomId, name: 'New owner name' })).success, true);
});

test('a queued legacy close cannot end the new owner room after formal transfer', async t => {
  const { io, host, member, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: 'https://media.example/retained.mp4', sourceType: 'mp4', currentTime: 77, isPlaying: false, playbackRate: 1 }, host.id);
  const queue = await holdRoomQueue(roomId);
  const originalClose = roomStateService.closeRoomAndNotify;
  let reached;
  const ready = new Promise(resolve => { reached = resolve; });
  // Capture only entry: the real close implementation and all database/session
  // changes remain intact. Old ownership has already been read by this point.
  roomStateService.closeRoomAndNotify = function(...args) {
    reached();
    return originalClose.apply(this, args);
  };
  const transfer = roomSessionService.transferHost(roomId, member.id, host.id, member.data.userId);
  const closing = host.invoke('close-room');
  try {
    await waitForMediaResolve(ready);
  } finally {
    roomStateService.closeRoomAndNotify = originalClose;
    queue.release(); await queue.held;
  }
  await transfer;
  assert.equal((await closing).success, false, 'the old sharer snapshot is no longer closing authority, even for a root account');
  const room = await AppDataSource.getRepository(Room).findOneBy({ roomId });
  assert.equal(room.status, 'active'); assert.equal(room.ownerUserId, member.data.userId);
  assert.equal((await roomSessionService.getSharer(roomId)).socketId, member.id);
  assert.equal((await AppDataSource.getRepository(PlaybackState).findOneBy({ roomId })).currentTime, 77);
  assert.equal(member.connected, true);
  assert.equal(host.events.some(event => event.event === 'room-closed'), false);
  assert.equal((await member.invoke('close-room')).success, true, 'the current owner can still use the legacy close event');
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).status, 'closed');
});

test('administrator force-close is explicit, rechecks its live actor and follows the current host after transfer', async t => {
  const first = await fixture(t);
  await first.member.invoke('request-join', { roomId: first.roomId });
  assert.equal((await first.member.invoke('admin-close-room', { roomId: first.roomId })).success, false);
  const queue = await holdRoomQueue(first.roomId);
  const originalClose = roomStateService.closeRoomAndNotify;
  let reached;
  const ready = new Promise(resolve => { reached = resolve; });
  roomStateService.closeRoomAndNotify = function(...args) {
    reached();
    return originalClose.apply(this, args);
  };
  const closing = first.host.invoke('admin-close-room', { roomId: first.roomId });
  try {
    await waitForMediaResolve(ready);
    first.host.data.role = 'user';
  } finally {
    roomStateService.closeRoomAndNotify = originalClose;
    queue.release(); await queue.held;
  }
  assert.equal((await closing).success, false, 'queued administration cannot rely on a revoked socket role');
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId: first.roomId })).status, 'active');

  const second = await fixture(t);
  await second.member.invoke('request-join', { roomId: second.roomId });
  await roomSessionService.transferHost(second.roomId, second.member.id, second.host.id, second.member.data.userId);
  assert.equal((await second.host.invoke('admin-close-room', { roomId: second.roomId })).success, true);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId: second.roomId })).status, 'closed');
  assert.equal(second.member.connected, true, 'the freshly selected host remains the compatibility exempt socket');
  assert.equal(second.host.connected, false, 'the old host does not remain exempt after the transfer');
});
test('new room rules are persisted, guests choose a nickname and login-only rooms reject guests', async t => {
  const { created, roomId, guest, member } = await fixture(t, { lifetime: 'persistent', visibility: 'private', collaboration: 'shared' });
  assert.equal(created.data.activity, 'watch');
  assert.equal((await guest.invoke('request-join', { roomId })).code, 'NICKNAME_REQUIRED');
  assert.equal((await guest.invoke('request-join', { roomId, nickname: 'Ada' })).success, true);
  assert.equal(guest.data.username, 'Ada');
  assert.equal((await member.invoke('request-join', { roomId })).success, true);
  const snapshot = (await member.invoke('room:experience:get', { roomId })).data;
  assert.equal(snapshot.permissions.selectContent, true);
  assert.equal(snapshot.permissions.switchActivity, false);
  assert.equal(snapshot.policy.visibility, 'private');
  await AppDataSource.getRepository(Room).update({ roomId }, { policyJson: JSON.stringify({ allowGuests: false }) });
  const secondGuest = new TestSocket(guest.io, 'other-guest', 0, 'guest');
  assert.equal((await secondGuest.invoke('request-join', { roomId, nickname: 'Bob' })).code, 'LOGIN_REQUIRED');
});
test('host disconnect delegates by room permission, owner returns, formal transfer remains authoritative', async t => {
  const { io, host, member, guest, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Guest' });
  await AppDataSource.getRepository(Room).update({ roomId }, { moderators: `[${member.data.userId}]` });
  await roomSessionService.endSession(host.id); await host.leave(roomId); host.disconnect();
  await roomExperienceService.memberLeft(io, roomId, host.id, true);
  await roomExperienceService.electDelegate(io, roomId);
  assert.equal(roomDelegates.get(roomId), member.id);
  assert.equal((await roomPermissionService.canPerform(member, roomId, 'playback.play')).allowed, true);
  assert.equal((await roomPermissionService.canPerform(member, roomId, 'host.transfer')).allowed, false);
  const returningHost = new TestSocket(io, 'returning-host', host.data.userId, 'root');
  assert.equal((await returningHost.invoke('register-host', { roomId })).success, true);
  assert.equal(roomDelegates.has(roomId), false);
  await roomSessionService.transferHost(roomId, member.id, returningHost.id, member.data.userId);
  assert.equal((await returningHost.invoke('register-host', { roomId })).success, false);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).ownerUserId, member.data.userId);
});
test('a guest can host an abandoned room without gaining settings or permanent transfer', async t => {
  const { io, host, guest, roomId } = await fixture(t);
  await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  await roomSessionService.endSession(host.id); host.disconnect();
  await roomExperienceService.electDelegate(io, roomId);
  assert.equal(roomDelegates.get(roomId), guest.id);
  for (const action of ['room.settings', 'host.transfer', 'viewer.approve']) assert.equal((await roomPermissionService.canPerform(guest, roomId, action)).allowed, false);
  assert.equal((await guest.invoke('room:activity:switch', { roomId, activity: 'listen' })).success, true);
});
test('activity switching pauses both domains, retains progress and lists, and resumes paused', async t => {
  const { host, roomId } = await fixture(t, { lifetime: 'persistent' });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: 'https://media.example/video.mp4', sourceType: 'mp4', isPlaying: true, currentTime: 42, playbackRate: 1, duration: 120 }, host.id);
  const actor = { socketId: host.id, userId: host.data.userId, role: 'root' };
  await musicSyncService.addQueueItem(roomId, { sourceRef: 'music://fixture/a', title: 'A', artist: 'Artist', durationMs: 200000 }, {}, actor);
  assert.equal((await host.invoke('room:activity:switch', { roomId, activity: 'listen' })).success, true);
  const video = await playbackMemoryService.getAdvancedPlayback(roomId);
  assert.equal(video.isPlaying, false); assert.ok(video.currentTime >= 42 && video.currentTime < 44);
  await musicSyncService.applyPlayback(roomId, 'seek', 23, {}, actor);
  await musicSyncService.applyPlayback(roomId, 'play', undefined, {}, actor);
  await host.invoke('room:activity:switch', { roomId, activity: 'watch' });
  const restarted = new MusicSyncService(AppDataSource, new RealtimeSyncCore());
  const recovered = await restarted.getSnapshot(roomId, actor);
  assert.equal(recovered.isPlaying, false); assert.ok(recovered.positionSec >= 23 && recovered.positionSec < 25); assert.equal(recovered.queue.length, 1);
  assert.equal((await playbackMemoryService.getAdvancedPlayback(roomId)).currentTime, video.currentTime);
  assert.equal((await AppDataSource.getRepository(PlaybackState).findOneBy({ roomId })).isPlaying, false);
});
test('requests and advisory votes are member-bound, mutable, and invalidated by switching', async t => {
  const { host, member, guest, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Guest' });
  assert.equal((await member.invoke('room:activity:switch', { roomId, activity: 'listen' })).success, false);
  assert.equal((await member.invoke('room:activity:request', { roomId, activity: 'listen' })).success, true);
  const requestId = (await host.invoke('room:experience:get', { roomId })).data.requests[0].id;
  await host.invoke('room:activity:resolve', { roomId, requestId, decision: 'poll' });
  const pollId = (await host.invoke('room:experience:get', { roomId })).data.poll.id;
  await guest.invoke('room:activity:vote', { roomId, pollId, value: true });
  await guest.invoke('room:activity:vote', { roomId, pollId, value: false });
  const vote = (await guest.invoke('room:experience:get', { roomId })).data.poll;
  assert.deepEqual([vote.yes, vote.no, vote.ownVote], [0, 1, false]);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).activity, 'watch');
  await host.invoke('room:activity:switch', { roomId, activity: 'screen' });
  assert.equal((await guest.invoke('room:activity:vote', { roomId, pollId, value: true })).success, false);
  await host.invoke('room:activity:switch', { roomId, activity: 'watch' });
  assert.ok(host.events.some(event => event.event === 'room:stop-screen'));
});
test('empty rooms start a deadline, return cancels it, and explicit exit revokes membership', async t => {
  const { io, host, member, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId });
  assert.equal((await host.invoke('room:leave', { roomId })).success, true);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).emptySince, null);
  await member.invoke('room:leave', { roomId });
  assert.ok((await AppDataSource.getRepository(Room).findOneBy({ roomId })).emptySince instanceof Date);
  assert.equal((await member.invoke('room:experience:get', { roomId })).success, false);
  await member.invoke('request-join', { roomId });
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).emptySince, null);
  assert.equal((await AppDataSource.getRepository(Room).findOneBy({ roomId })).status, 'active');
});
test('fixed rooms retain settings and progress when the owner ends the activity for everyone', async t => {
  const { io, host, roomId } = await fixture(t, { lifetime: 'persistent', visibility: 'private' });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: 'https://media.example/a.mp4', sourceType: 'mp4', isPlaying: false, currentTime: 77, playbackRate: 1 }, host.id);
  await roomStateService.closeRoomAndNotify(io, roomId, host.id);
  const room = await AppDataSource.getRepository(Room).findOneBy({ roomId });
  assert.equal(room.status, 'active'); assert.equal(JSON.parse(room.policyJson).visibility, 'private');
  assert.equal((await AppDataSource.getRepository(PlaybackState).findOneBy({ roomId })).currentTime, 77);
  assert.equal((await host.invoke('register-host', { roomId })).success, true);
});
test('shared controllers cannot publish host heartbeats, and old or inactive heartbeats cannot overwrite progress', async t => {
  const { host, member, roomId } = await fixture(t, { collaboration: 'shared' });
  await member.invoke('request-join', { roomId });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: 'https://media.example/a.mp4', sourceType: 'mp4', currentTime: 42, isPlaying: false, playbackRate: 1 }, host.id);
  const state = await playbackMemoryService.getRawPlayback(roomId);
  const heartbeat = { roomId, currentTime: 50, isPlaying: false, playbackRate: 1, suppressed: false, version: state.version, sourceGeneration: state.sourceGeneration };
  assert.equal((await member.invoke('host-heartbeat', heartbeat)).code, 'FORBIDDEN');
  assert.equal((await host.invoke('host-heartbeat', { ...heartbeat, version: (state.version ?? 0) - 1 })).code, 'STALE_VERSION');
  assert.equal((await playbackMemoryService.getRawPlayback(roomId)).currentTime, 42);
  assert.equal((await host.invoke('host-heartbeat', heartbeat)).success, true);
  await host.invoke('room:activity:switch', { roomId, activity: 'listen' });
  assert.equal((await host.invoke('host-heartbeat', heartbeat)).code, 'FORBIDDEN');
});

test('inactive music mutations cannot restart playback or advance a queue', async t => {
  const { host, roomId } = await fixture(t);
  const actor = { socketId: host.id, userId: host.data.userId, role: 'root' };
  await musicSyncService.addQueueItem(roomId, { sourceRef: 'music://fixture/a', title: 'A', durationMs: 200000 }, {}, actor);
  for (const operation of [
    () => musicSyncService.applyPlayback(roomId, 'play', undefined, {}, actor),
    () => musicSyncService.applyHeartbeat(roomId, {}, actor),
    () => musicSyncService.applyEnded(roomId, {}, actor),
  ]) await assert.rejects(operation, error => error.code === 'INACTIVE_ACTIVITY');
  const state = await musicSyncService.getSnapshot(roomId, actor);
  assert.equal(state.isPlaying, false); assert.equal(state.queue.length, 1);
});

test('guest suggestions expose only selected titles, require authorized review, and never start playing', async t => {
  const { host, member, guest, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId }); await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  const content = { url: 'https://private.example/selected.mp4', title: 'One selected movie', source: 'webdav', username: 'private-user', password: 'private-password' };
  assert.equal((await guest.invoke('room:content:suggest', { roomId, content })).success, true);
  const snapshot = (await member.invoke('room:experience:get', { roomId })).data;
  const text = JSON.stringify(snapshot);
  for (const secret of [content.url, content.username, content.password]) assert.equal(text.includes(secret), false);
  const suggestionId = snapshot.suggestions[0].id;
  assert.equal((await member.invoke('room:content:resolve', { roomId, suggestionId, accepted: true })).success, false);
  assert.equal((await host.invoke('room:content:resolve', { roomId, suggestionId, accepted: true })).success, true);
  assert.equal((await host.invoke('room:content:resolve', { roomId, suggestionId, accepted: true })).success, false);
  assert.equal(await AppDataSource.getRepository(Movie).countBy({ roomId }), 1);
  assert.equal(roomStateService.getCurrentMovieId(roomId), null);
});

test('cancelled admission requests cannot leave ghost members even when approval wins the race', async t => {
  const { host, guest, roomId } = await fixture(t);
  assert.equal((await host.invoke('update-room-settings', { roomId, requireApproval: true })).success, true);
  await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  assert.equal((await host.invoke('room:experience:get', { roomId })).data.joinRequests.length, 1);
  await guest.invoke('room:join:cancel', { roomId });
  assert.equal((await host.invoke('approve-join', { viewerSocketId: guest.id })).success, false);
  await guest.invoke('request-join', { roomId, nickname: 'Lee' });
  assert.equal((await host.invoke('approve-join', { viewerSocketId: guest.id })).success, true);
  await guest.invoke('room:join:cancel', { roomId });
  assert.equal(await roomPermissionService.isInRoom(guest, roomId), false);
  assert.equal(guest.rooms.has(roomId), false);
});

test('authorized guest screen presenters are exclusive and stopping releases the presenter', async t => {
  const { host, guest, member, roomId } = await fixture(t, { guestCollaboration: true, permissions: { screenShare: true } });
  await guest.invoke('request-join', { roomId, nickname: 'Lee' }); await member.invoke('request-join', { roomId });
  assert.equal((await guest.invoke('sharer-ready', { roomId })).success, false);
  await host.invoke('room:activity:switch', { roomId, activity: 'screen' });
  assert.equal((await guest.invoke('sharer-ready', { roomId })).success, true);
  assert.equal(roomScreenPresenters.get(roomId), guest.id);
  assert.equal((await host.invoke('sharer-ready', { roomId })).success, false);
  assert.equal((await guest.invoke('signal-offer', { to: member.id, data: { type: 'offer' } })).success, true);
  assert.equal((await host.invoke('signal-offer', { to: member.id, data: { type: 'offer' } })).success, false);
  await guest.invoke('room:screen:stop', { roomId });
  assert.equal(roomScreenPresenters.has(roomId), false);
  assert.equal((await host.invoke('sharer-ready', { roomId })).success, true);
  await host.invoke('room:activity:switch', { roomId, activity: 'watch' });
  assert.equal(roomScreenPresenters.has(roomId), false);
});

test('empty fixed rooms release runtime caches while durable video progress remains restorable', async t => {
  const { host, roomId } = await fixture(t, { lifetime: 'persistent' });
  await host.invoke('add-movie', { roomId, movie: { title: 'Retained film', url: 'https://media.example/a.mp4' } });
  const [movie] = roomStateService.getMovies(roomId);
  await host.invoke('play-movie', { roomId, movieId: movie.id });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: movie.url, sourceType: 'mp4', currentTime: 77, isPlaying: false, playbackRate: 1 }, host.id);
  await host.invoke('room:leave', { roomId });
  assert.equal(playbackMemoryService.hasCache(roomId), false);
  assert.equal((await AppDataSource.getRepository(PlaybackState).findOneBy({ roomId })).currentTime, 77);
  assert.equal((await host.invoke('register-host', { roomId })).success, true);
  assert.equal((await playbackMemoryService.getAdvancedPlayback(roomId)).currentTime, 77);
  assert.equal(roomStateService.getCurrentMovieId(roomId), movie.id);
  assert.equal((await host.invoke('request-current-movie', { roomId })).success, true);
  assert.equal(host.events.filter(event => event.event === 'current-movie').at(-1).payload.movieId, movie.id);
});

test('late old-socket disconnect cannot clear the returned owner or restart delegation', async t => {
  const { io, host, member, roomId } = await fixture(t);
  await member.invoke('request-join', { roomId });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: 'https://media.example/a.mp4', sourceType: 'mp4', currentTime: 77, isPlaying: false, playbackRate: 1 }, host.id);
  new RoomDisconnectHandler().register(host, io);
  const originalLeft = roomExperienceService.memberLeft;
  const originalSchedule = roomExperienceService.scheduleDelegate;
  let release; let entered; let completed; let failed;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const done = new Promise((resolve, reject) => { completed = resolve; failed = reject; });
  let scheduled = 0;
  roomExperienceService.memberLeft = async function(...args) {
    entered(); await gate;
    try { await originalLeft.apply(this, args); completed(); }
    catch (error) { failed(error); throw error; }
  };
  roomExperienceService.scheduleDelegate = function(...args) { scheduled += 1; return originalSchedule.apply(this, args); };
  t.after(() => { release(); roomExperienceService.memberLeft = originalLeft; roomExperienceService.scheduleDelegate = originalSchedule; });
  host.disconnect();
  host.handlers.get('disconnect')('transport close');
  let timeout;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('old disconnect did not reach member cleanup')), 2000); })]);
    const returned = new TestSocket(io, 'returned-owner-after-disconnect', host.data.userId, 'root');
    assert.equal((await returned.invoke('register-host', { roomId })).success, true);
    const notices = member.events.filter(event => event.event === 'host-disconnected').length;
    release(); await done;
    assert.equal((await AppDataSource.getRepository(PlaybackState).findOneBy({ roomId })).hostSocketId, returned.id);
    assert.equal((await roomExperienceService.snapshot(member, roomId, io)).host.socketId, returned.id);
    assert.equal(scheduled, 0);
    assert.equal(member.events.filter(event => event.event === 'host-disconnected').length, notices);
  } finally { clearTimeout(timeout); release(); }
});

test('restart restoration uses public movie DTOs before any admitted socket can read the list', async t => {
  const { host, member, guest, roomId } = await fixture(t, { lifetime: 'persistent' });
  const privateValues = ['fixture-private-user', 'fixture-private-password', 'https://private.example/dav', '/selected-private.mp4'];
  await host.invoke('add-movie', { roomId, movie: { title: 'Private selection', url: 'https://media.example/selected.mp4', source: 'webdav', serverUrl: privateValues[2], path: privateValues[3], username: privateValues[0], password: privateValues[1] } });
  const [selected] = roomStateService.getMovies(roomId);
  await host.invoke('play-movie', { roomId, movieId: selected.id });
  await playbackMemoryService.setPlayback(roomId, { sourceUrl: selected.url, sourceType: 'mp4', currentTime: 42, isPlaying: false, playbackRate: 1 }, host.id);
  const { cleanupStaleRoomSessions } = require('../dist/services/media/room-access');
  await cleanupStaleRoomSessions();
  roomPermissionService.invalidatePermissionCache(undefined, roomId);
  roomStateService.delete(roomId); await playbackMemoryService.releaseRuntime(roomId);
  await roomStateService.initFromDb();
  const stored = await AppDataSource.getRepository(Movie).findOneBy({ id: selected.id, roomId });
  assert.equal(stored.password, privateValues[1], 'private credentials remain available only on the server');
  assert.equal((await guest.invoke('request-movie-list', { roomId })).success, false);
  assert.equal(guest.events.some(event => event.event === 'movie-list'), false);
  // The production admission path creates this session before awaiting its
  // list broadcast; even this interval must expose only a public DTO.
  await roomSessionService.admitViewer(member, roomId, member.data.userId);
  assert.equal((await member.invoke('request-movie-list', { roomId })).success, true);
  const movies = member.events.filter(event => event.event === 'movie-list').at(-1).payload.movies;
  assert.equal(movies.length, 1); assert.equal(movies[0].id, selected.id);
  for (const value of privateValues) assert.equal(JSON.stringify(movies).includes(value), false);
  assert.equal(movies[0].username, null); assert.equal(movies[0].password, null); assert.equal(movies[0].serverUrl, null); assert.equal(movies[0].path, null);
  assert.equal(roomStateService.getCurrentMovieId(roomId), selected.id);
  assert.equal((await playbackMemoryService.getAdvancedPlayback(roomId)).currentTime, 42);
});

test('legacy adapter restoration rebuilds public movies while preserving cached selection and activity state', async t => {
  const { host, member, roomId } = await fixture(t, { lifetime: 'persistent' });
  const privateValues = ['adapter-private-user', 'adapter-private-password', 'https://private.example/adapter', '/private-adapter.mp4'];
  await host.invoke('add-movie', { roomId, movie: { title: 'Adapter selection', url: 'https://media.example/adapter.mp4', source: 'webdav', serverUrl: privateValues[2], path: privateValues[3], username: privateValues[0], password: privateValues[1] } });
  const [selected] = roomStateService.getMovies(roomId);
  const entity = await AppDataSource.getRepository(Movie).findOneBy({ id: selected.id, roomId });
  const playback = { sourceUrl: selected.url, sourceType: 'mp4', currentTime: 33, isPlaying: false, playbackRate: 1 };
  const subtitle = { tracks: [{ label: 'Selected captions', language: 'en' }] };
  const states = new Map([[roomId, { movies: [entity], currentMovieId: selected.id, playback, subtitle }]]);
  roomStateService.setStorageAdapter({ init: async () => {}, entries: () => states.entries(), set: (id, state) => states.set(id, state), delete: id => states.delete(id) });
  t.after(() => roomStateService.setStorageAdapter(null));
  await roomStateService.initFromDb();
  await roomSessionService.admitViewer(member, roomId, member.data.userId);
  assert.equal((await member.invoke('request-movie-list', { roomId })).success, true);
  const movies = member.events.filter(event => event.event === 'movie-list').at(-1).payload.movies;
  for (const value of privateValues) assert.equal(JSON.stringify(movies).includes(value), false);
  assert.equal(movies[0].title, 'Adapter selection'); assert.equal(movies[0].username, null); assert.equal(movies[0].password, null);
  assert.equal(roomStateService.getCurrentMovieId(roomId), selected.id);
  assert.deepEqual(roomStateService.getPlayback(roomId), playback);
  assert.deepEqual(roomStateService.getSubtitle(roomId), subtitle);
});

test('admitted members receive a complete safe directory including themselves across joins and leaves', async t => {
  const { io, host, member, guest, roomId } = await fixture(t);
  assert.equal((await guest.invoke('room:experience:get', { roomId })).success, false);
  member.data.ip = '192.0.2.1'; member.data.password = 'fixture-private-password'; member.data.guestId = 'fixture-private-identity';
  await member.invoke('request-join', { roomId });
  await guest.invoke('request-join', { roomId, nickname: 'Visible guest' });
  const snapshot = (await guest.invoke('room:experience:get', { roomId })).data;
  assert.deepEqual(snapshot.members.map(value => value.socketId).sort(), [member.id, guest.id].sort());
  const own = snapshot.members.find(value => value.socketId === guest.id);
  assert.equal(own.username, 'Visible guest'); assert.equal(own.role, 'guest'); assert.equal(own.userId, null);
  assert.equal(snapshot.members.find(value => value.socketId === member.id).role, 'user');
  assert.equal(snapshot.members.some(value => value.socketId === host.id), false, 'the host retains the separate host row');
  for (const value of snapshot.members) assert.deepEqual(Object.keys(value).sort(), ['role', 'socketId', 'userId', 'username']);
  for (const privateValue of [member.data.ip, member.data.password, member.data.guestId]) assert.equal(JSON.stringify(snapshot.members).includes(privateValue), false);
  assert.ok(guest.events.some(event => event.event === 'room:experience' && event.payload.members.some(value => value.socketId === guest.id)));
  const pending = new TestSocket(io, 'directory-pending-member', 0, 'guest');
  await host.invoke('update-room-settings', { roomId, requireApproval: true });
  await pending.invoke('request-join', { roomId, nickname: 'Waiting visitor' });
  assert.equal((await pending.invoke('room:experience:get', { roomId })).success, false);
  assert.equal((await host.invoke('room:experience:get', { roomId })).data.members.some(value => value.socketId === pending.id), false);
  await member.invoke('room:leave', { roomId });
  assert.deepEqual((await guest.invoke('room:experience:get', { roomId })).data.members.map(value => value.socketId), [guest.id]);
  assert.ok(guest.events.filter(event => event.event === 'room:experience').at(-1).payload.members.every(value => value.socketId !== member.id));
  guest.connected = false;
  assert.equal((await host.invoke('room:experience:get', { roomId })).data.members.length, 0, 'stale database sessions cannot expose an offline member');
});

test('test database is closed without modifying application runtime data', async () => {
  await AppDataSource.destroy(); fs.rmSync(testConfig, { recursive: true, force: true });
});
