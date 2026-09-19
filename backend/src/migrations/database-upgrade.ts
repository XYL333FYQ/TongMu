import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DataSource } from 'typeorm';
import { CONFIG_DIR, DATABASE_PATH } from '../services/paths';
import { isSecretVaultEnvelope, SecretVault, secretVaultKeyPath } from '../services/secret-vault';
import { createPreMigrationBackup, readAndValidateBackupManifest } from './database-backup';
import { inspectSchemaFingerprint, schemaTableNames } from './schema-inventory';

export const EXPECTED_SCHEMA_V2_FINGERPRINT = '99b1097bff5278e0365bf0336c29a1369fd6abc0345932f98c3c44ac7934a7a9';
export const ExpectedSchemaV2 = {
  fingerprint: EXPECTED_SCHEMA_V2_FINGERPRINT,
  tables: [
    'audit_logs', 'bilibili_credential', 'comment', 'danmaku_track', 'movie',
    'music_queue_items', 'music_room_states', 'ncm_credentials', 'playback_states',
    'room', 'room_danmaku_meta', 'server_folder', 'session', 'system_settings',
    'user', 'user_mount',
  ],
} as const;
export const MIGRATION_STATE_FILENAME = 'database-migration-state.json';

export interface SupportedDatabaseSchema {
  id: string;
  fingerprint: string;
  evidence: string;
  current: boolean;
}

export const SUPPORTED_DATABASE_SCHEMAS: readonly SupportedDatabaseSchema[] = [
  { id: 'tongmu-71ba034', fingerprint: 'fc203e7eca14ae2b67d16fde345ab13d0ac53afbf1c600effc14e06a344ec889', evidence: 'commit 71ba034 entity snapshot', current: false },
  { id: 'tongmu-fe16563-media-core', fingerprint: '790729dd274e6ed59afe7ac1b8cba2dd63e84f22515071759a6f59400fc2ffc6', evidence: 'commit fe16563 entity snapshot', current: false },
  { id: 'tongmu-f010531-phase1', fingerprint: 'c7cbd128c21cc81ee9497776a6fc6123914f6d6908b7545434306f55b22cddb9', evidence: 'commit f010531 entity snapshot', current: false },
  { id: 'tongmu-0e322a1-voice', fingerprint: '38b0726983d1b1e6f35e9f62c6e965895f1d66ff4a15b618e229d26334f525cb', evidence: 'commit 0e322a1 entity snapshot', current: false },
  { id: 'tongmu-98c6e71-realtime', fingerprint: 'd9a3ebbe0570d8b2c780ee6119b9759dfad751417a1ba5b6a9526bd699c90afd', evidence: 'commit 98c6e71 entity snapshot', current: false },
  { id: 'tongmu-0707e78-music', fingerprint: 'e1f8731bc652498a7c85d6688f9a1c67e4eb7776e88c4ef8ead894934cbc861c', evidence: 'commit 0707e78 entity snapshot', current: false },
  { id: 'tongmu-8eea2bc-current-v2', fingerprint: EXPECTED_SCHEMA_V2_FINGERPRINT, evidence: 'commit 8eea2bc and 75ed7bd entity snapshots', current: true },
] as const;

export const ORDERED_MIGRATIONS = [
  { timestamp: 1789160000000, name: 'AddMediaCoreMetadata1789160000000', schema: true },
  { timestamp: 1790000000000, name: 'CreateHistoricalBaseline1790000000000', schema: true },
  { timestamp: 1790100000000, name: 'CompletePhase1Schema1790100000000', schema: true },
  { timestamp: 1790200000000, name: 'AddRealtimePersistence1790200000000', schema: true },
  { timestamp: 1790300000000, name: 'AddMusicPersistence1790300000000', schema: true },
  { timestamp: 1790400000000, name: 'AddNcmCredential1790400000000', schema: true },
  { timestamp: 1790500000000, name: 'EncryptLegacyCredentials1790500000000', schema: false },
] as const;

interface MigrationRow {
  name: string;
  timestamp: number;
}

interface MigrationMarker {
  formatVersion: 1;
  nonce: string;
  createdAt: string;
  sourceSchemaId: string;
  sourceFingerprint: string;
  targetMigration: string;
  backupDir: string | null;
}

export type DatabaseUpgradeErrorCode =
  | 'DATABASE_INTEGRITY_FAILED'
  | 'DATABASE_FOREIGN_KEY_FAILED'
  | 'UNSUPPORTED_DATABASE_SCHEMA'
  | 'UNSUPPORTED_MIGRATION_HISTORY'
  | 'INCOMPLETE_DATABASE_MIGRATION'
  | 'DATABASE_SECRET_KEY_INVALID'
  | 'DATABASE_MIGRATION_FAILED';

export class DatabaseUpgradeError extends Error {
  readonly code: DatabaseUpgradeErrorCode;
  readonly backupDir?: string;
  cause?: unknown;
  constructor(
    code: DatabaseUpgradeErrorCode,
    message: string,
    options?: { cause?: unknown; backupDir?: string },
  ) {
    super(`${code}: ${message}`);
    this.name = 'DatabaseUpgradeError';
    this.code = code;
    this.backupDir = options?.backupDir;
    this.cause = options?.cause;
  }
}

function migrationStatePath(configDir: string): string {
  return path.join(configDir, MIGRATION_STATE_FILENAME);
}

function writeMarker(configDir: string, marker: MigrationMarker): void {
  const target = migrationStatePath(configDir);
  const temporary = `${target}.${marker.nonce}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
}

function readMarker(configDir: string): MigrationMarker | null {
  const target = migrationStatePath(configDir);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<MigrationMarker>;
    if (
      parsed.formatVersion !== 1 ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.sourceSchemaId !== 'string' ||
      typeof parsed.sourceFingerprint !== 'string' ||
      typeof parsed.targetMigration !== 'string' ||
      !(typeof parsed.backupDir === 'string' || parsed.backupDir === null)
    ) {
      throw new Error('invalid marker fields');
    }
    return parsed as MigrationMarker;
  } catch (error) {
    throw new DatabaseUpgradeError(
      'INCOMPLETE_DATABASE_MIGRATION',
      'migration marker 无法验证；请使用最近 backup 恢复或人工检查。',
      { cause: error },
    );
  }
}

async function assertIntegrity(dataSource: DataSource): Promise<void> {
  const result = await dataSource.query('PRAGMA integrity_check');
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    String(result[0]?.integrity_check || '').toLowerCase() !== 'ok'
  ) {
    throw new DatabaseUpgradeError(
      'DATABASE_INTEGRITY_FAILED',
      'PRAGMA integrity_check 未返回 ok；未修改数据库。',
    );
  }
}

async function assertForeignKeys(dataSource: DataSource): Promise<void> {
  const enabled = await dataSource.query('PRAGMA foreign_keys');
  if (!Array.isArray(enabled) || Number(enabled[0]?.foreign_keys) !== 1) {
    throw new DatabaseUpgradeError(
      'DATABASE_FOREIGN_KEY_FAILED',
      'PRAGMA foreign_keys 未启用；拒绝继续。',
    );
  }
  const violations = await dataSource.query('PRAGMA foreign_key_check');
  if (Array.isArray(violations) && violations.length > 0) {
    throw new DatabaseUpgradeError(
      'DATABASE_FOREIGN_KEY_FAILED',
      `PRAGMA foreign_key_check 发现 ${violations.length} 个 orphan；未继续启动。`,
    );
  }
}

async function readMigrationRows(dataSource: DataSource): Promise<MigrationRow[]> {
  const tables = await dataSource.query("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'");
  if (!Array.isArray(tables) || tables.length === 0) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await dataSource.query('SELECT "name", "timestamp" FROM "migrations" ORDER BY "timestamp"');
  } catch (error) {
    throw new DatabaseUpgradeError(
      'UNSUPPORTED_MIGRATION_HISTORY',
      'migrations table 存在但无法读取。',
      { cause: error },
    );
  }
  return rows.map((row) => ({ name: String(row.name || ''), timestamp: Number(row.timestamp) }));
}

function validateMigrationRows(rows: MigrationRow[]): void {
  const allowed = new Map<string, number>(
    ORDERED_MIGRATIONS.map((migration) => [migration.name, migration.timestamp]),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (!allowed.has(row.name) || allowed.get(row.name) !== row.timestamp || seen.has(row.name)) {
      throw new DatabaseUpgradeError(
        'UNSUPPORTED_MIGRATION_HISTORY',
        `migration history 包含未知、冲突或重复记录：${row.name || '<empty>'}`,
      );
    }
    seen.add(row.name);
  }
}

async function inspectSecretEnvelopes(dataSource: DataSource): Promise<string[]> {
  const tableRows = await dataSource.query("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set((tableRows as Array<{ name: string }>).map((row) => row.name));
  const values: string[] = [];
  if (tables.has('bilibili_credential')) {
    const rows = await dataSource.query('SELECT "cookie", "refreshToken" FROM "bilibili_credential"');
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const value of [row.cookie, row.refreshToken]) {
        if (isSecretVaultEnvelope(value)) values.push(String(value));
      }
    }
  }
  if (tables.has('user_mount')) {
    const rows = await dataSource.query('SELECT "password", "apiKey" FROM "user_mount"');
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const value of [row.password, row.apiKey]) {
        if (isSecretVaultEnvelope(value)) values.push(String(value));
      }
    }
  }
  if (tables.has('ncm_credentials')) {
    const rows = await dataSource.query('SELECT "credentialEnvelope" FROM "ncm_credentials"');
    for (const row of rows as Array<Record<string, unknown>>) {
      const value = String(row.credentialEnvelope || '');
      if (!isSecretVaultEnvelope(value)) {
        throw new DatabaseUpgradeError(
          'DATABASE_SECRET_KEY_INVALID',
          '发现非 SecretVault 格式的 NCM credential；没有历史 plaintext NCM migration，拒绝猜测。',
        );
      }
      values.push(value);
    }
  }
  return values;
}

async function assertNoLegacyCredentialStorage(dataSource: DataSource): Promise<void> {
  const tableRows = await dataSource.query("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set((tableRows as Array<{ name: string }>).map((row) => row.name));
  const legacyLocations: string[] = [];
  if (tables.has('bilibili_credential')) {
    const rows = await dataSource.query('SELECT "id", "cookie", "refreshToken" FROM "bilibili_credential"');
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!isSecretVaultEnvelope(row.cookie)) legacyLocations.push(`bilibili_credential:${row.id}:cookie`);
      if (row.refreshToken && !isSecretVaultEnvelope(row.refreshToken)) {
        legacyLocations.push(`bilibili_credential:${row.id}:refreshToken`);
      }
    }
  }
  if (tables.has('user_mount')) {
    const rows = await dataSource.query('SELECT "id", "password", "apiKey" FROM "user_mount"');
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row.password && !isSecretVaultEnvelope(row.password)) legacyLocations.push(`user_mount:${row.id}:password`);
      if (row.apiKey && !isSecretVaultEnvelope(row.apiKey)) legacyLocations.push(`user_mount:${row.id}:apiKey`);
    }
  }
  if (legacyLocations.length > 0) {
    throw new DatabaseUpgradeError(
      'UNSUPPORTED_MIGRATION_HISTORY',
      `credential migration 已标记完成，但仍发现 ${legacyLocations.length} 个 legacy 字段（仅报告位置，不输出内容）。`,
    );
  }
}

function validateSecretKey(configDir: string, envelopes: string[]): void {
  if (envelopes.length === 0) return;
  if (!fs.existsSync(secretVaultKeyPath(configDir))) {
    throw new DatabaseUpgradeError(
      'DATABASE_SECRET_KEY_INVALID',
      '数据库包含加密 credential，但 secret-vault.json 缺失；不会生成替代 key。',
    );
  }
  try {
    const vault = new SecretVault({ configDir, createIfMissing: false });
    for (const envelope of envelopes) vault.decrypt(envelope);
  } catch (error) {
    throw new DatabaseUpgradeError(
      'DATABASE_SECRET_KEY_INVALID',
      'secret-vault.json 无法解密现有 credential；拒绝启动和迁移。',
      { cause: error },
    );
  }
}

async function adoptCurrentSchemaBaseline(dataSource: DataSource, rows: MigrationRow[]): Promise<void> {
  const applied = new Set(rows.map((row) => row.name));
  const runner = dataSource.createQueryRunner();
  try {
    await runner.startTransaction();
    if (!(await runner.hasTable('migrations'))) {
      await runner.query('CREATE TABLE "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)');
    }
    for (const migration of ORDERED_MIGRATIONS.filter((item) => item.schema)) {
      if (!applied.has(migration.name)) {
        await runner.query(
          'INSERT INTO "migrations" ("timestamp", "name") VALUES (?, ?)',
          [migration.timestamp, migration.name],
        );
      }
    }
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export interface DatabaseUpgradeResult {
  sourceSchemaId: string;
  sourceFingerprint: string;
  finalFingerprint: string;
  executed: string[];
  baselineAdopted: boolean;
  backupDir: string | null;
  recoveredInterruptedMarker: boolean;
}

export interface RunDatabaseUpgradeOptions {
  configDir?: string;
  databasePath?: string;
  databaseFileExisted: boolean;
  backupFailureInjector?: Parameters<typeof createPreMigrationBackup>[0]['failureInjector'];
  migrationFailureInjector?: (point: 'after-backup' | 'before-migrations' | 'after-migrations') => void;
}

async function runDatabaseUpgradeInternal(
  dataSource: DataSource,
  options: RunDatabaseUpgradeOptions,
  enableAutoSaveForMutation: () => void,
): Promise<DatabaseUpgradeResult> {
  const configDir = options.configDir || CONFIG_DIR;
  const databasePath = options.databasePath || DATABASE_PATH;
  await assertIntegrity(dataSource);
  await assertForeignKeys(dataSource);
  const inspected = await inspectSchemaFingerprint(dataSource);
  const tableNames = schemaTableNames(inspected.inventory);
  const rows = await readMigrationRows(dataSource);
  validateMigrationRows(rows);

  const empty = tableNames.length === 0;
  if (empty && rows.length > 0) {
    throw new DatabaseUpgradeError(
      'INCOMPLETE_DATABASE_MIGRATION',
      '空业务 schema 却包含已应用 migration 记录；拒绝猜测。',
    );
  }
  const supported = empty
    ? { id: 'fresh-empty', fingerprint: inspected.fingerprint, evidence: 'no application tables', current: false }
    : SUPPORTED_DATABASE_SCHEMAS.find((schema) => schema.fingerprint === inspected.fingerprint);
  if (!supported) {
    throw new DatabaseUpgradeError(
      'UNSUPPORTED_DATABASE_SCHEMA',
      `fingerprint ${inspected.fingerprint} 不匹配任何有 Git 证据的 TongMu schema。请备份 ${databasePath} 与 config key，并按 docs/upgrade-v2.md 人工恢复。`,
    );
  }

  const envelopes = await inspectSecretEnvelopes(dataSource);
  validateSecretKey(configDir, envelopes);
  const applied = new Set(rows.map((row) => row.name));
  const allApplied = ORDERED_MIGRATIONS.every((migration) => applied.has(migration.name));
  const marker = readMarker(configDir);
  let recoveredInterruptedMarker = false;
  let existingBackupDir: string | null = null;
  if (marker) {
    const sourceStillPresent = marker.sourceFingerprint === inspected.fingerprint;
    const completedBeforeMarkerCleanup = inspected.fingerprint === EXPECTED_SCHEMA_V2_FINGERPRINT && allApplied;
    if (!sourceStillPresent && !completedBeforeMarkerCleanup) {
      throw new DatabaseUpgradeError(
        'INCOMPLETE_DATABASE_MIGRATION',
        `检测到未完成 migration marker，当前 schema 既不是原始 fingerprint，也不是完整 V2。请 restore ${marker.backupDir || 'pre-upgrade backup'}。`,
        { backupDir: marker.backupDir || undefined },
      );
    }
    if (marker.backupDir) {
      readAndValidateBackupManifest(marker.backupDir);
      existingBackupDir = marker.backupDir;
    }
    recoveredInterruptedMarker = true;
    if (completedBeforeMarkerCleanup) {
      await assertNoLegacyCredentialStorage(dataSource);
      fs.unlinkSync(migrationStatePath(configDir));
      return {
        sourceSchemaId: supported.id,
        sourceFingerprint: inspected.fingerprint,
        finalFingerprint: inspected.fingerprint,
        executed: [],
        baselineAdopted: false,
        backupDir: existingBackupDir,
        recoveredInterruptedMarker,
      };
    }
  }

  if (allApplied) {
    if (inspected.fingerprint !== EXPECTED_SCHEMA_V2_FINGERPRINT) {
      throw new DatabaseUpgradeError(
        'UNSUPPORTED_DATABASE_SCHEMA',
        'migration history 已完成，但 schema 不等于 ExpectedSchemaV2。',
      );
    }
    await assertNoLegacyCredentialStorage(dataSource);
    return {
      sourceSchemaId: supported.id,
      sourceFingerprint: inspected.fingerprint,
      finalFingerprint: inspected.fingerprint,
      executed: [],
      baselineAdopted: false,
      backupDir: null,
      recoveredInterruptedMarker,
    };
  }

  let backupDir = existingBackupDir;
  if (!backupDir && options.databaseFileExisted) {
    const backup = createPreMigrationBackup({
      dataSource,
      configDir,
      databasePath,
      databaseFileExisted: true,
      schemaId: supported.id,
      schemaFingerprint: inspected.fingerprint,
      targetMigration: ORDERED_MIGRATIONS[ORDERED_MIGRATIONS.length - 1].name,
      secretVaultKeyRequired: envelopes.length > 0,
      failureInjector: options.backupFailureInjector,
    });
    backupDir = backup.backupDir;
  }
  options.migrationFailureInjector?.('after-backup');
  if (!marker) {
    writeMarker(configDir, {
      formatVersion: 1,
      nonce: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      sourceSchemaId: supported.id,
      sourceFingerprint: inspected.fingerprint,
      targetMigration: ORDERED_MIGRATIONS[ORDERED_MIGRATIONS.length - 1].name,
      backupDir,
    });
  }

  let baselineAdopted = false;
  const executed: string[] = [];
  try {
    // Everything above this point is inspection/backup only. Re-enable sql.js
    // persistence exactly where the first database mutation may begin.
    enableAutoSaveForMutation();
    if (supported.current) {
      await adoptCurrentSchemaBaseline(dataSource, rows);
      baselineAdopted = true;
    }
    options.migrationFailureInjector?.('before-migrations');
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    executed.push(...migrations.map((migration) => migration.name));
    options.migrationFailureInjector?.('after-migrations');
    await assertIntegrity(dataSource);
    await assertForeignKeys(dataSource);
    const finalSchema = await inspectSchemaFingerprint(dataSource);
    if (finalSchema.fingerprint !== EXPECTED_SCHEMA_V2_FINGERPRINT) {
      throw new DatabaseUpgradeError(
        'UNSUPPORTED_DATABASE_SCHEMA',
        `migration 后 fingerprint ${finalSchema.fingerprint} 不等于 ExpectedSchemaV2。`,
        { backupDir: backupDir || undefined },
      );
    }
    const finalRows = await readMigrationRows(dataSource);
    validateMigrationRows(finalRows);
    const finalApplied = new Set(finalRows.map((row) => row.name));
    if (!ORDERED_MIGRATIONS.every((migration) => finalApplied.has(migration.name))) {
      throw new DatabaseUpgradeError(
        'DATABASE_MIGRATION_FAILED',
        'migration chain 未完整记录，拒绝启动。',
        { backupDir: backupDir || undefined },
      );
    }
    await assertNoLegacyCredentialStorage(dataSource);
    fs.unlinkSync(migrationStatePath(configDir));
    return {
      sourceSchemaId: supported.id,
      sourceFingerprint: inspected.fingerprint,
      finalFingerprint: finalSchema.fingerprint,
      executed,
      baselineAdopted,
      backupDir,
      recoveredInterruptedMarker,
    };
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError(
      'DATABASE_MIGRATION_FAILED',
      `database migration failed at ${ORDERED_MIGRATIONS[ORDERED_MIGRATIONS.length - 1].name}; backup: ${backupDir || 'fresh install (none)'}. Restore with npm run database:restore -w backend -- <backup-id>.`,
      { cause: error, backupDir: backupDir || undefined },
    );
  }
}

export async function runDatabaseUpgrade(
  dataSource: DataSource,
  options: RunDatabaseUpgradeOptions,
): Promise<DatabaseUpgradeResult> {
  const driverOptions = (dataSource.driver as typeof dataSource.driver & {
    options: { autoSave?: boolean };
  }).options;
  const originalAutoSave = driverOptions.autoSave;
  // sql.js/TypeORM classifies PRAGMA reads as dirty. Disable auto-save so
  // integrity checks, schema inventory, unknown-schema rejection, and backup
  // preparation cannot rewrite the live database file before the backup gate.
  driverOptions.autoSave = false;
  const enableAutoSaveForMutation = () => {
    driverOptions.autoSave = originalAutoSave;
  };
  try {
    return await runDatabaseUpgradeInternal(dataSource, options, enableAutoSaveForMutation);
  } finally {
    driverOptions.autoSave = originalAutoSave;
  }
}
