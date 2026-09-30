const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-create-request-'));
process.env.CONFIG_DIR = testConfig;
const { DataSource } = require('typeorm');
const { createSequentialTestHarness } = require('./helpers/sequential-test-harness');
const { sharedSqlJs } = require('./helpers/shared-sqljs');
const { MovieCreateIdempotency } = require('../dist/modules/movie/movie-create-idempotency');
const { AddMovieCreateRequests1790800000000 } = require('../dist/migrations/1790800000000-AddMovieCreateRequests');
const { SecretVault } = require('../dist/services/secret-vault');
const test = createSequentialTestHarness();
const vault = new SecretVault({ masterKey: Buffer.alloc(32, 17) });

async function fixture(t) {
  const db = new DataSource({ type: 'sqljs', driver: await sharedSqlJs, entities: [], autoSave: false });
  await db.initialize();
  await db.query('PRAGMA foreign_keys = ON');
  await db.query('CREATE TABLE room (roomId varchar PRIMARY KEY)');
  await db.query("INSERT INTO room VALUES ('r'), ('other')");
  await db.query('CREATE TABLE movie (id integer PRIMARY KEY AUTOINCREMENT, roomId varchar, title text)');
  await new AddMovieCreateRequests1790800000000().up(db.createQueryRunner());
  t.after(() => db.destroy());
  const create = async manager => {
    await manager.query("INSERT INTO movie (roomId, title) VALUES ('r', 'film')");
    return (await manager.query('SELECT * FROM movie ORDER BY id DESC LIMIT 1'))[0];
  };
  const replay = async (manager, id) => (await manager.query('SELECT * FROM movie WHERE id=?', [id]))[0];
  return { db, create, replay, service: new MovieCreateIdempotency(db, vault) };
}

test('concurrent retries and a new service instance replay one durable movie', async t => {
  const { db, create, replay, service } = await fixture(t);
  const run = instance => instance.execute('r', 1, 'request-123', { title: 'film', url: 'https://example.org/a' }, create, replay);
  const results = await Promise.all(Array.from({ length: 8 }, () => run(service)));
  assert.equal(new Set(results.map(movie => movie.id)).size, 1);
  assert.equal((await run(new MovieCreateIdempotency(db, vault))).id, results[0].id);
  assert.equal((await db.query('SELECT * FROM movie')).length, 1);
  assert.equal((await db.query('SELECT * FROM movie_create_request')).length, 1);
});

test('same key with changed payload conflicts; actor and room scope are independent', async t => {
  const { db, create, replay, service } = await fixture(t);
  await service.execute('r', 1, 'request-123', { a: 1, b: 2 }, create, replay);
  await service.execute('r', 1, 'request-123', { b: 2, a: 1 }, create, replay);
  await assert.rejects(service.execute('r', 1, 'request-123', { a: 2 }, create, replay), { status: 409 });
  await service.execute('other', 1, 'request-123', { a: 1 }, create, replay);
  await service.execute('r', 2, 'request-123', { a: 1 }, create, replay);
  assert.equal((await db.query('SELECT * FROM movie')).length, 3);
});

test('exported SQLite receipt survives closing and reopening the database', async t => {
  const { db, create, replay, service } = await fixture(t);
  const first = await service.execute('r', 1, 'request-123', { url: 'a' }, create, replay);
  const bytes = db.driver.export();
  const restored = new DataSource({ type: 'sqljs', driver: await sharedSqlJs, database: bytes, entities: [], autoSave: false });
  await restored.initialize();
  t.after(() => restored.destroy());
  const result = await new MovieCreateIdempotency(restored, vault).execute('r', 1, 'request-123', { url: 'a' },
    async () => { throw new Error('must never create on replay'); }, replay);
  assert.equal(result.id, first.id);
  assert.equal((await restored.query('SELECT * FROM movie')).length, 1);
});

test('deleted movie cannot be recreated by a delayed retry; a fresh key permits intentional repetition', async t => {
  const { db, create, replay, service } = await fixture(t);
  const movie = await service.execute('r', 1, 'request-123', {}, create, replay);
  await db.query('DELETE FROM movie WHERE id=?', [movie.id]);
  await assert.rejects(service.execute('r', 1, 'request-123', {}, create, replay), { status: 409 });
  await service.execute('r', 1, 'request-456', {}, create, replay);
  assert.equal((await db.query('SELECT * FROM movie')).length, 1);
  await db.query("DELETE FROM room WHERE roomId='r'");
  assert.equal((await db.query('SELECT * FROM movie_create_request')).length, 0);
});

test('failed creation rolls back both movie and receipt; receipt does not expose payload secrets', async t => {
  const { db, create, replay, service } = await fixture(t);
  const data = { password: 'sensitive-password', url: 'https://example.org/?token=private' };
  await assert.rejects(service.execute('r', 1, 'request-123', data, async manager => {
    await create(manager); throw new Error('fixture failure');
  }, replay));
  assert.equal((await db.query('SELECT * FROM movie')).length, 0);
  assert.equal((await db.query('SELECT * FROM movie_create_request')).length, 0);
  await service.execute('r', 1, 'request-123', data, create, replay);
  const stored = JSON.stringify(await db.query('SELECT * FROM movie_create_request'));
  assert.equal(stored.includes('sensitive-password'), false);
  assert.equal(stored.includes('private'), false);
  assert.equal(stored.includes('request-123'), false);
  await assert.rejects(service.execute('r', 1, 'bad key', data, create, replay), { status: 400 });
});

test('HTTP create route keeps legacy clients compatible and rechecks permission before replay', async t => {
  const express = require('express');
  const { AppDataSource } = require('../dist/data-source');
  AppDataSource.setOptions({ location: undefined, database: undefined, autoSave: false, logging: false });
  await AppDataSource.initialize();
  await AppDataSource.runMigrations({ transaction: 'all' });
  t.after(async () => { await AppDataSource.destroy(); fs.rmSync(testConfig, { recursive: true, force: true }); });
  const { Room } = require('../dist/entities/Room');
  await AppDataSource.getRepository(Room).save({ roomId: 'r', ownerUserId: 11 });
  let actor = { userId: 11, role: 'admin' };
  // Authentication has its own E2E coverage. Exercise the route's actual room
  // authorization using injected authenticated identities, not a fake service.
  require('../dist/middleware/auth').authenticateToken = (req, _res, next) => { req.user = actor; next(); };
  const broadcaster = require('../dist/modules/movie/movie-broadcaster.service').movieBroadcasterService;
  broadcaster.broadcastMovieList = async () => {};
  const { createMovieRouter } = require('../dist/modules/movie/movie.routes');
  const app = express(); app.use(express.json()); app.use('/api/rooms', createMovieRouter({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/rooms/r/movies`;
  const payload = { title: 'film', url: 'https://example.org/a.mp4' };
  const post = (key, data = payload) => fetch(endpoint, { method: 'POST', body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } });
  const first = await post('request-123'); assert.equal(first.status, 201);
  const id = (await first.json()).movie.id;
  const repeated = await post('request-123'); assert.equal((await repeated.json()).movie.id, id);
  assert.equal((await post('request-123', { ...payload, title: 'other' })).status, 409);
  assert.equal((await post('invalid key')).status, 400);
  actor = { userId: 12, role: 'admin' };
  assert.equal((await post('request-123')).status, 403);
  actor = { userId: 11, role: 'admin' };
  await AppDataSource.query('DELETE FROM movie WHERE id=?', [id]);
  assert.equal((await post('request-123')).status, 409);
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  assert.equal((await AppDataSource.query('SELECT * FROM movie')).length, 2);
});

test('completed HTTP POST body followed by client disconnect aborts pending media resolution', async t => {
  const express = require('express');
  const http = require('node:http');
  const helpers = require('../dist/routes/stream/helpers');
  const resolvers = require('../dist/services/media/resolvers');
  const oldCookie = helpers.getUserCookie;
  const oldResolve = resolvers.resolveMediaProvider;
  let started; let stopped;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { stopped = resolve; });
  helpers.getUserCookie = async () => undefined;
  resolvers.resolveMediaProvider = (_input, context) => new Promise((_resolve, reject) => {
    started();
    context.signal.addEventListener('abort', () => { stopped(); reject(new Error('fixture resolution cancelled')); }, { once: true });
  });
  t.after(() => { helpers.getUserCookie = oldCookie; resolvers.resolveMediaProvider = oldResolve; });
  const app = express(); app.use(express.json());
  app.use('/api/stream', require('../dist/routes/stream/media').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = http.request(`http://127.0.0.1:${server.address().port}/api/stream/media/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({ input: 'https://example.org/page', browserSniff: true }));
  let guard;
  try {
    await Promise.race([ready, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('fixture route not reached')), 1000); })]);
    clearTimeout(guard);
    request.destroy();
    await Promise.race([aborted, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('client disconnect did not cancel')), 1000); })]);
  } finally { clearTimeout(guard); request.destroy(); }
});
