const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { acquireDatabaseMigrationLock, DatabaseMigrationLockError } = require('../dist/migrations/database-lock');

function config(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-lock-restart-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeLegacy(directory, overrides = {}) {
  fs.writeFileSync(path.join(directory, 'database-migration.lock'), JSON.stringify({
    formatVersion: 1, pid: process.pid, hostname: os.hostname(),
    createdAt: new Date().toISOString(), nonce: 'legacy-restart-owner', ...overrides,
  }));
}

test('a live owner still prevents another initializer and release permits reacquisition', (t) => {
  const directory = config(t);
  const owner = acquireDatabaseMigrationLock(directory);
  assert.throws(() => acquireDatabaseMigrationLock(directory), DatabaseMigrationLockError);
  owner.release();
  acquireDatabaseMigrationLock(directory).release();
});

test('a legacy lock from the previous process using this PID is archived', (t) => {
  const directory = config(t);
  const started = Date.now() - process.uptime() * 1000;
  writeLegacy(directory, { createdAt: new Date(started - 10000).toISOString() });
  const recovered = acquireDatabaseMigrationLock(directory);
  assert.ok(fs.readdirSync(directory).some(name => name.startsWith('database-migration.lock.stale-')));
  recovered.release();
});

test('a recent legacy lock and a foreign host remain protected', (t) => {
  const directory = config(t);
  writeLegacy(directory);
  assert.throws(() => acquireDatabaseMigrationLock(directory), DatabaseMigrationLockError);
  writeLegacy(directory, { hostname: 'another-host', createdAt: '2020-01-01T00:00:00Z' });
  assert.throws(() => acquireDatabaseMigrationLock(directory), DatabaseMigrationLockError);
});

test('Linux detects a reused live PID by its kernel start identity', { skip: process.platform !== 'linux' }, (t) => {
  const directory = config(t);
  const owner = acquireDatabaseMigrationLock(directory);
  const filename = path.join(directory, 'database-migration.lock');
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(record.processIdentity);
  owner.release();
  const [boot, ticks] = record.processIdentity.split(':');
  record.processIdentity = `${boot}:${BigInt(ticks) + 1n}`;
  fs.writeFileSync(filename, JSON.stringify(record));
  acquireDatabaseMigrationLock(directory).release();
  assert.ok(fs.readdirSync(directory).some(name => name.startsWith('database-migration.lock.stale-')));
});
