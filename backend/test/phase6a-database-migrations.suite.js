const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSequentialTestHarness } = require('./helpers/sequential-test-harness');
const { DataSource } = require('typeorm');
const { AppDataSource } = require('../dist/data-source');
const {
  DatabaseUpgradeError,
  EXPECTED_SCHEMA_V2_FINGERPRINT,
  ORDERED_MIGRATIONS,
  runDatabaseUpgrade,
  SUPPORTED_DATABASE_SCHEMAS,
} = require('../dist/migrations/database-upgrade');
const { DatabaseBackupError } = require('../dist/migrations/database-backup');
const { DatabaseRestoreError, restoreDatabaseBackup } = require('../dist/migrations/database-restore');
const {
  acquireDatabaseMigrationLock,
  DatabaseMigrationLockError,
} = require('../dist/migrations/database-lock');
const { inspectSchemaFingerprint } = require('../dist/migrations/schema-inventory');
const { SecretVault } = require('../dist/services/secret-vault');
const {
  __setMigrationVaultForTests,
} = require('../dist/migrations/1790500000000-EncryptLegacyCredentials');
const { HISTORICAL_FIXTURES, buildHistoricalFixture } = require('./fixtures/historical-database-fixtures');
const { sharedSqlJs } = require('./helpers/shared-sqljs');

const test = createSequentialTestHarness();

function persistRawDatabase(dataSource, databasePath) {
  fs.writeFileSync(databasePath, Buffer.from(dataSource.driver.export()));
}

function temporaryConfig(t, label = 'config') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-phase6a-'));
  const configDir = path.join(root, `${label} 中文 space`);
  fs.mkdirSync(configDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, configDir, databasePath: path.join(configDir, 'dev.sqlite') };
}

async function createApplicationDataSource(databasePath) {
  let dataSource;
  dataSource = new DataSource({
    ...AppDataSource.options,
    driver: await sharedSqlJs,
    location: databasePath,
    logging: false,
    synchronize: false,
    migrationsRun: false,
    autoSave: true,
    autoSaveCallback: (database) => {
      fs.writeFileSync(databasePath, Buffer.from(database));
      dataSource.driver.databaseConnection.exec('PRAGMA foreign_keys = ON');
    },
  });
  return dataSource;
}

async function upgradeDatabase({ configDir, databasePath, ...options }) {
  const existed = fs.existsSync(databasePath);
  const dataSource = await createApplicationDataSource(databasePath);
  __setMigrationVaultForTests(new SecretVault({ configDir }));
  try {
    await dataSource.initialize();
    const result = await runDatabaseUpgrade(dataSource, {
      configDir,
      databasePath,
      databaseFileExisted: existed,
      ...options,
    });
    return { dataSource, result };
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy();
    throw error;
  } finally {
    __setMigrationVaultForTests();
  }
}

async function rawDatabase(databasePath) {
  const dataSource = new DataSource({
    type: 'sqljs', location: databasePath, autoSave: false,
    driver: await sharedSqlJs,
    useLocalForage: false, synchronize: false, migrationsRun: false, entities: [],
  });
  await dataSource.initialize();
  return dataSource;
}

async function assertGoldenData(dataSource, configDir, sourceLevel) {
  assert.deepEqual(await dataSource.query('SELECT "id", "username", "passwordHash", "role", "tokenInvalidBefore" FROM "user"'), [{
    id: 11, username: '历史用户', passwordHash: 'bcrypt-hash-preserved', role: 'root', tokenInvalidBefore: '2026-09-01 00:00:00.000',
  }]);
  const rooms = await dataSource.query('SELECT "id", "roomId", "ownerUserId", "moderators", "voiceMuted" FROM "room"');
  assert.equal(rooms[0].id, 21);
  assert.equal(rooms[0].roomId, '历史 房间 α');
  assert.equal(rooms[0].ownerUserId, 11);
  assert.equal(rooms[0].moderators, sourceLevel >= 3 ? '[12]' : '[]');
  assert.equal(rooms[0].voiceMuted, sourceLevel >= 3 ? '[13]' : '[]');
  assert.deepEqual(await dataSource.query('SELECT "id", "roomId", "userId", "role" FROM "session"'), [
    { id: 31, roomId: '历史 房间 α', userId: 11, role: 'sharer' },
  ]);
  const movies = await dataSource.query('SELECT "id", "roomId", "source", "sourceInput", "mediaDescriptor", "sourceMeta", "order" FROM "movie"');
  assert.equal(movies[0].id, 41);
  assert.equal(movies[0].sourceInput, sourceLevel >= 1 ? 'provider://anime/legacy' : null);
  assert.equal(movies[0].order, 7);
  assert.match(movies[0].sourceMeta, /legacy-anime/);

  const vault = new SecretVault({ configDir, createIfMissing: false });
  const mounts = await dataSource.query('SELECT "id", "type", "password", "apiKey" FROM "user_mount" ORDER BY "id"');
  assert.deepEqual(mounts.map((row) => row.id), [51, 52, 53, 54, 55]);
  for (const row of mounts) {
    assert.match(row.password, /^v1:/);
    assert.equal(vault.decrypt(row.password), `${row.type}-password`);
    if (row.apiKey) assert.equal(vault.decrypt(row.apiKey), `${row.type}-api-key`);
  }
  const bili = (await dataSource.query('SELECT "cookie", "refreshToken" FROM "bilibili_credential"'))[0];
  assert.match(bili.cookie, /^v1:/);
  assert.equal(vault.decrypt(bili.cookie), 'SESSDATA=legacy-secret; bili_jct=csrf');
  assert.equal(vault.decrypt(bili.refreshToken), 'legacy-refresh-token');
  const rawSecrets = JSON.stringify({ mounts, bili });
  for (const plaintext of ['webdav-password', 'ftp-password', 'openlist-password', 'emby-password', 'jellyfin-password', 'legacy-secret', 'legacy-refresh-token']) {
    assert.equal(rawSecrets.includes(plaintext), false);
  }

  const settings = (await dataSource.query('SELECT * FROM "system_settings" WHERE "id" = 71'))[0];
  assert.equal(settings.autoDeleteAfterHours, 72);
  assert.equal(settings.mediaPolicyVersion, sourceLevel >= 2 ? 3 : 0);
  const playback = (await dataSource.query('SELECT "roomId", "currentTime", "version", "sourceGeneration" FROM "playback_states"'))[0];
  assert.equal(playback.roomId, '历史 房间 α');
  assert.equal(playback.currentTime, 123.5);
  assert.equal(playback.version, sourceLevel >= 4 ? 9 : 0);
  assert.equal(playback.sourceGeneration, sourceLevel >= 4 ? 4 : 0);

  const queue = await dataSource.query('SELECT "queueItemId", "orderIndex", "sourceRef" FROM "music_queue_items" ORDER BY "orderIndex"');
  if (sourceLevel >= 5) {
    assert.deepEqual(queue, [
      { queueItemId: 91, orderIndex: 0, sourceRef: 'music://fixture/golden-a' },
      { queueItemId: 92, orderIndex: 1, sourceRef: 'music://fixture/golden-b' },
    ]);
    const state = (await dataSource.query('SELECT "currentQueueItemId", "playMode", "version", "musicGeneration" FROM "music_room_states"'))[0];
    assert.deepEqual(state, { currentQueueItemId: 92, playMode: 'shuffle', version: 14, musicGeneration: 6 });
  } else {
    assert.deepEqual(queue, []);
  }
  const ncm = await dataSource.query('SELECT "userId", "credentialEnvelope", "credentialVersion", "status" FROM "ncm_credentials"');
  if (sourceLevel >= 6) {
    assert.equal(ncm[0].userId, 11);
    assert.equal(ncm[0].credentialVersion, 7);
    assert.match(vault.decrypt(ncm[0].credentialEnvelope), /MUSIC_U=ncm-secret/);
  } else {
    assert.deepEqual(ncm, []);
  }

  const schema = await inspectSchemaFingerprint(dataSource);
  assert.equal(schema.fingerprint, EXPECTED_SCHEMA_V2_FINGERPRINT);
  const migrationRows = await dataSource.query('SELECT "name", "timestamp" FROM "migrations" ORDER BY "timestamp"');
  assert.deepEqual(migrationRows.map((row) => row.name), ORDERED_MIGRATIONS.map((row) => row.name));
  assert.deepEqual(await dataSource.query('PRAGMA foreign_key_check'), []);
  assert.deepEqual(await dataSource.query('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
  // The auto-save callback restores this PRAGMA after sql.js export.
  assert.deepEqual(await dataSource.query('PRAGMA foreign_keys'), [{ foreign_keys: 1 }]);
}

test('historical Git-backed fixture matrix upgrades with identity and credential golden assertions', async (t) => {
  assert.deepEqual(
    HISTORICAL_FIXTURES.map((fixture) => fixture.id),
    SUPPORTED_DATABASE_SCHEMAS.map((schema) => schema.id),
  );
  for (const fixture of HISTORICAL_FIXTURES) {
    await t.test(`${fixture.id} (${fixture.evidence})`, async (t) => {
      const paths = temporaryConfig(t, fixture.id);
      await buildHistoricalFixture({ fixtureId: fixture.id, ...paths });
      const before = await rawDatabase(paths.databasePath);
      const beforeSchema = await inspectSchemaFingerprint(before);
      await before.destroy();
      assert.equal(beforeSchema.fingerprint, SUPPORTED_DATABASE_SCHEMAS.find((item) => item.id === fixture.id).fingerprint);

      const { dataSource, result } = await upgradeDatabase(paths);
      try {
        assert.equal(result.sourceSchemaId, fixture.id);
        assert.ok(result.backupDir);
        assert.equal(result.baselineAdopted, fixture.level === 6);
        await assertGoldenData(dataSource, paths.configDir, fixture.level);
      } finally {
        await dataSource.destroy();
      }
    });
  }
});

test('fresh no-file and existing empty-file installs are migration-created', async (t) => {
  for (const existingEmpty of [false, true]) {
    await t.test(existingEmpty ? 'existing empty file' : 'no database file', async (t) => {
      const paths = temporaryConfig(t, existingEmpty ? 'empty file' : 'fresh no file');
      if (existingEmpty) fs.writeFileSync(paths.databasePath, Buffer.alloc(0));
      const { dataSource, result } = await upgradeDatabase(paths);
      try {
        assert.equal(result.sourceSchemaId, 'fresh-empty');
        assert.equal(result.finalFingerprint, EXPECTED_SCHEMA_V2_FINGERPRINT);
        assert.equal(Boolean(result.backupDir), existingEmpty);
        assert.equal((await dataSource.query('SELECT COUNT(*) AS count FROM "migrations"'))[0].count, ORDERED_MIGRATIONS.length);
      } finally {
        await dataSource.destroy();
      }
    });
  }
});

test('current synchronize-created V2 adopts only after exact fingerprint and repeated startup is idempotent', async (t) => {
  const paths = temporaryConfig(t, 'current adoption');
  await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
  const first = await upgradeDatabase(paths);
  const firstBackup = first.result.backupDir;
  try {
    assert.equal(first.result.baselineAdopted, true);
    assert.deepEqual(first.result.executed, ['EncryptLegacyCredentials1790500000000']);
  } finally {
    await first.dataSource.destroy();
  }
  for (let run = 0; run < 3; run += 1) {
    const next = await upgradeDatabase(paths);
    try {
      assert.equal(next.result.executed.length, 0);
      assert.equal(next.result.backupDir, null);
      assert.equal(next.result.baselineAdopted, false);
    } finally {
      await next.dataSource.destroy();
    }
  }
  const backups = fs.readdirSync(path.join(paths.configDir, 'backups')).filter((name) => !name.startsWith('.'));
  assert.equal(backups.length, 1);
  assert.equal(path.basename(firstBackup), backups[0]);
});

test('an existing historical migrations table is validated and resumed without duplicate records', async (t) => {
  const paths = temporaryConfig(t, 'existing migration table');
  await buildHistoricalFixture({ fixtureId: 'tongmu-fe16563-media-core', ...paths });
  const historical = await rawDatabase(paths.databasePath);
  await historical.query('CREATE TABLE "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)');
  await historical.query('INSERT INTO "migrations" ("timestamp", "name") VALUES (1789160000000, \'AddMediaCoreMetadata1789160000000\')');
  persistRawDatabase(historical, paths.databasePath);
  await historical.destroy();
  const upgraded = await upgradeDatabase(paths);
  try {
    const rows = await upgraded.dataSource.query('SELECT "name" FROM "migrations" ORDER BY "timestamp"');
    assert.deepEqual(rows.map((row) => row.name), ORDERED_MIGRATIONS.map((row) => row.name));
    assert.equal(new Set(rows.map((row) => row.name)).size, ORDERED_MIGRATIONS.length);
  } finally { await upgraded.dataSource.destroy(); }
});

test('a forged completed migration history cannot hide legacy plaintext credentials', async (t) => {
  const paths = temporaryConfig(t, 'forged migration history');
  await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
  const forged = await rawDatabase(paths.databasePath);
  await forged.query('CREATE TABLE "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)');
  for (const migration of ORDERED_MIGRATIONS) {
    await forged.query('INSERT INTO "migrations" ("timestamp", "name") VALUES (?, ?)', [migration.timestamp, migration.name]);
  }
  persistRawDatabase(forged, paths.databasePath);
  await forged.destroy();
  await assert.rejects(
    upgradeDatabase(paths),
    (error) => error instanceof DatabaseUpgradeError && error.code === 'UNSUPPORTED_MIGRATION_HISTORY',
  );
});

test('entity schema exactly equals migration-created ExpectedSchemaV2', async (t) => {
  const paths = temporaryConfig(t, 'entity drift');
  const migrated = await upgradeDatabase(paths);
  let entityDataSource;
  try {
    entityDataSource = new DataSource({
      ...AppDataSource.options,
      driver: await sharedSqlJs,
      location: undefined,
      database: undefined,
      autoSave: false,
      autoSaveCallback: undefined,
      synchronize: true,
      migrations: [],
      migrationsRun: false,
      logging: false,
    });
    await entityDataSource.initialize();
    const entitySchema = await inspectSchemaFingerprint(entityDataSource);
    const migrationSchema = await inspectSchemaFingerprint(migrated.dataSource);
    assert.equal(entitySchema.fingerprint, EXPECTED_SCHEMA_V2_FINGERPRINT);
    assert.deepEqual(migrationSchema.inventory, entitySchema.inventory);
  } finally {
    if (entityDataSource?.isInitialized) await entityDataSource.destroy();
    await migrated.dataSource.destroy();
  }
});

test('unknown and corrupted databases fail closed without mutation', async (t) => {
  await t.test('unknown schema', async (t) => {
    const paths = temporaryConfig(t, 'unknown');
    await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
    const unknown = await rawDatabase(paths.databasePath);
    await unknown.query('ALTER TABLE "room" ADD COLUMN "rogueColumn" text');
    persistRawDatabase(unknown, paths.databasePath);
    await unknown.destroy();
    const before = crypto.createHash('sha256').update(fs.readFileSync(paths.databasePath)).digest('hex');
    await assert.rejects(upgradeDatabase(paths), (error) => error instanceof DatabaseUpgradeError && error.code === 'UNSUPPORTED_DATABASE_SCHEMA');
    const after = crypto.createHash('sha256').update(fs.readFileSync(paths.databasePath)).digest('hex');
    assert.equal(after, before);
    assert.equal(fs.existsSync(path.join(paths.configDir, 'backups')), false);
  });
  await t.test('corrupt database', async (t) => {
    const paths = temporaryConfig(t, 'corrupt');
    const corrupt = Buffer.from('not-a-sqlite-database-corrupt');
    fs.writeFileSync(paths.databasePath, corrupt);
    await assert.rejects(upgradeDatabase(paths));
    assert.deepEqual(fs.readFileSync(paths.databasePath), corrupt);
  });
});

test('wrong or missing SecretVault key fails without generating a replacement', async (t) => {
  for (const mode of ['missing', 'wrong']) {
    await t.test(mode, async (t) => {
      const paths = temporaryConfig(t, `key ${mode}`);
      await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
      const keyPath = path.join(paths.configDir, 'secret-vault.json');
      if (mode === 'missing') fs.unlinkSync(keyPath);
      else {
        const other = path.join(paths.root, 'other-key');
        new SecretVault({ configDir: other }).encrypt('create-key');
        fs.copyFileSync(path.join(other, 'secret-vault.json'), keyPath);
      }
      await assert.rejects(upgradeDatabase(paths), (error) => error instanceof DatabaseUpgradeError && error.code === 'DATABASE_SECRET_KEY_INVALID');
      if (mode === 'missing') assert.equal(fs.existsSync(keyPath), false);
    });
  }
});

test('backup failure blocks migration and migration failure is retryable from one verified backup', async (t) => {
  await t.test('backup write failure', async (t) => {
    const paths = temporaryConfig(t, 'backup failure');
    await buildHistoricalFixture({ fixtureId: 'tongmu-71ba034', ...paths });
    await assert.rejects(
      upgradeDatabase({ ...paths, backupFailureInjector(point) { if (point === 'after-database') throw new Error('disk full'); } }),
      DatabaseBackupError,
    );
    const raw = await rawDatabase(paths.databasePath);
    try {
      const schema = await inspectSchemaFingerprint(raw);
      assert.equal(schema.fingerprint, SUPPORTED_DATABASE_SCHEMAS[0].fingerprint);
    } finally { await raw.destroy(); }
    assert.equal(fs.existsSync(path.join(paths.configDir, 'database-migration-state.json')), false);
  });

  await t.test('failed migration then retry', async (t) => {
    const paths = temporaryConfig(t, 'migration retry');
    await buildHistoricalFixture({ fixtureId: 'tongmu-71ba034', ...paths });
    await assert.rejects(
      upgradeDatabase({ ...paths, migrationFailureInjector(point) { if (point === 'before-migrations') throw new Error('simulated crash'); } }),
      (error) => error instanceof DatabaseUpgradeError && error.code === 'DATABASE_MIGRATION_FAILED',
    );
    assert.equal(fs.existsSync(path.join(paths.configDir, 'database-migration-state.json')), true);
    const retry = await upgradeDatabase(paths);
    try {
      assert.equal(retry.result.recoveredInterruptedMarker, true);
      await assertGoldenData(retry.dataSource, paths.configDir, 0);
    } finally { await retry.dataSource.destroy(); }
    assert.equal(fs.existsSync(path.join(paths.configDir, 'database-migration-state.json')), false);
    assert.equal(fs.readdirSync(path.join(paths.configDir, 'backups')).filter((name) => !name.startsWith('.')).length, 1);
  });
});

test('interruption after baseline adoption and after migration commit recovers safely', async (t) => {
  for (const point of ['before-migrations', 'after-migrations']) {
    await t.test(point, async (t) => {
      const paths = temporaryConfig(t, `interruption ${point}`);
      await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
      await assert.rejects(
        upgradeDatabase({ ...paths, migrationFailureInjector(current) { if (current === point) throw new Error(`crash ${point}`); } }),
        DatabaseUpgradeError,
      );
      const retry = await upgradeDatabase(paths);
      try {
        assert.equal(retry.result.recoveredInterruptedMarker, true);
        await assertGoldenData(retry.dataSource, paths.configDir, 6);
      } finally { await retry.dataSource.destroy(); }
    });
  }
});

test('backup restore is validated, rollback-safe, removes post-backup keys, and can migrate again', async (t) => {
  const paths = temporaryConfig(t, 'restore workflow');
  await buildHistoricalFixture({ fixtureId: 'tongmu-71ba034', ...paths });
  const upgraded = await upgradeDatabase(paths);
  const backupId = path.basename(upgraded.result.backupDir);
  await upgraded.dataSource.query(`UPDATE "user" SET "username" = 'mutated-v2' WHERE "id" = 11`);
  await upgraded.dataSource.query(`INSERT INTO "music_queue_items" ("roomId", "sourceRef", "title", "orderIndex", "createdAt") VALUES ('历史 房间 α', 'music://fixture/new-v2', 'new-v2', 0, datetime('now'))`);
  await upgraded.dataSource.destroy();
  assert.equal(fs.existsSync(path.join(paths.configDir, 'secret-vault.json')), true);

  await assert.rejects(
    restoreDatabaseBackup({ ...paths, backupId, failureInjector(point) { if (point === 'after-first-replace') throw new Error('restore write error'); } }),
    /restore 失败/,
  );
  const stillV2 = await rawDatabase(paths.databasePath);
  assert.equal((await stillV2.query('SELECT "username" FROM "user" WHERE "id" = 11'))[0].username, 'mutated-v2');
  await stillV2.destroy();

  await restoreDatabaseBackup({ ...paths, backupId });
  assert.equal(fs.existsSync(path.join(paths.configDir, 'secret-vault.json')), false);
  const historical = await rawDatabase(paths.databasePath);
  try {
    assert.equal((await historical.query('SELECT "username" FROM "user" WHERE "id" = 11'))[0].username, '历史用户');
    assert.equal(await historical.createQueryRunner().hasTable('music_queue_items'), false);
  } finally { await historical.destroy(); }

  const migratedAgain = await upgradeDatabase(paths);
  try {
    await assertGoldenData(migratedAgain.dataSource, paths.configDir, 0);
  } finally { await migratedAgain.dataSource.destroy(); }
});

test('restore rejects missing/wrong SecretVault key and migration lock blocks concurrent access', async (t) => {
  const paths = temporaryConfig(t, 'restore key lock');
  await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...paths });
  const upgraded = await upgradeDatabase(paths);
  const backupId = path.basename(upgraded.result.backupDir);
  await upgraded.dataSource.destroy();
  const backupDir = path.join(paths.configDir, 'backups', backupId);
  fs.unlinkSync(path.join(backupDir, 'secret-vault.json'));
  await assert.rejects(restoreDatabaseBackup({ ...paths, backupId }), DatabaseBackupError);

  const wrongPaths = temporaryConfig(t, 'restore wrong key');
  await buildHistoricalFixture({ fixtureId: 'tongmu-8eea2bc-current-v2', ...wrongPaths });
  const wrongUpgraded = await upgradeDatabase(wrongPaths);
  const wrongBackupId = path.basename(wrongUpgraded.result.backupDir);
  await wrongUpgraded.dataSource.destroy();
  const wrongBackupDir = path.join(wrongPaths.configDir, 'backups', wrongBackupId);
  const replacementDir = path.join(wrongPaths.root, 'replacement-key');
  new SecretVault({ configDir: replacementDir }).encrypt('replacement');
  const replacement = fs.readFileSync(path.join(replacementDir, 'secret-vault.json'));
  fs.writeFileSync(path.join(wrongBackupDir, 'secret-vault.json'), replacement);
  const manifestPath = path.join(wrongBackupDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const keyRecord = manifest.files.find((file) => file.logicalName === 'secret-vault-key');
  keyRecord.size = replacement.length;
  keyRecord.sha256 = crypto.createHash('sha256').update(replacement).digest('hex');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    restoreDatabaseBackup({ ...wrongPaths, backupId: wrongBackupId }),
    (error) => error instanceof DatabaseRestoreError && /SecretVault|解密/.test(error.message),
  );

  const lock = acquireDatabaseMigrationLock(paths.configDir);
  try {
    assert.throws(() => acquireDatabaseMigrationLock(paths.configDir), DatabaseMigrationLockError);
  } finally {
    lock.release();
  }

  const stale = {
    formatVersion: 1,
    pid: 2147483647,
    hostname: os.hostname(),
    createdAt: '2026-09-15T00:00:00.000Z',
    nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
  };
  fs.writeFileSync(path.join(paths.configDir, 'database-migration.lock'), `${JSON.stringify(stale)}\n`);
  const recovered = acquireDatabaseMigrationLock(paths.configDir);
  recovered.release();
  assert.equal(
    fs.readdirSync(paths.configDir).some((name) => name.startsWith('database-migration.lock.stale-')),
    true,
  );
});
