import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { CONFIG_DIR, DATABASE_PATH } from '../services/paths';
import { isSecretVaultEnvelope, SecretVault } from '../services/secret-vault';
import { acquireDatabaseMigrationLock } from './database-lock';
import { DatabaseBackupError, readAndValidateBackupManifest } from './database-backup';
import { inspectSchemaFingerprint } from './schema-inventory';

export class DatabaseRestoreError extends Error {
  cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DatabaseRestoreError';
    this.cause = options?.cause;
  }
}

function resolveBackupDirectory(configDir: string, backupId: string): string {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(backupId)) {
    throw new DatabaseRestoreError('backup ID 格式无效');
  }
  const backupsRoot = path.resolve(configDir, 'backups');
  const candidate = path.resolve(backupsRoot, backupId);
  if (path.dirname(candidate) !== backupsRoot) {
    throw new DatabaseRestoreError('backup 路径越界');
  }
  return candidate;
}

async function openValidationDatabase(databaseFile: string): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'sqljs',
    location: databaseFile,
    autoSave: false,
    useLocalForage: false,
    synchronize: false,
    migrationsRun: false,
    entities: [],
  });
  try {
    await dataSource.initialize();
    const integrity = await dataSource.query('PRAGMA integrity_check');
    if (
      !Array.isArray(integrity) ||
      integrity.length !== 1 ||
      String(integrity[0]?.integrity_check || '').toLowerCase() !== 'ok'
    ) {
      throw new DatabaseRestoreError('backup database integrity_check 失败');
    }
    const foreignKeys = await dataSource.query('PRAGMA foreign_key_check');
    if (Array.isArray(foreignKeys) && foreignKeys.length > 0) {
      throw new DatabaseRestoreError('backup database foreign_key_check 发现 orphan');
    }
    return dataSource;
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy();
    throw error;
  }
}

async function validateSecretCoupling(dataSource: DataSource, backupDir: string): Promise<void> {
  const tables = await dataSource.query("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set((tables as Array<{ name: string }>).map((row) => row.name));
  const envelopes: string[] = [];
  if (names.has('bilibili_credential')) {
    const rows = await dataSource.query('SELECT "cookie", "refreshToken" FROM "bilibili_credential"');
    for (const row of rows as Array<Record<string, unknown>>) {
      if (isSecretVaultEnvelope(row.cookie)) envelopes.push(String(row.cookie));
      if (isSecretVaultEnvelope(row.refreshToken)) envelopes.push(String(row.refreshToken));
    }
  }
  if (names.has('user_mount')) {
    const rows = await dataSource.query('SELECT "password", "apiKey" FROM "user_mount"');
    for (const row of rows as Array<Record<string, unknown>>) {
      if (isSecretVaultEnvelope(row.password)) envelopes.push(String(row.password));
      if (isSecretVaultEnvelope(row.apiKey)) envelopes.push(String(row.apiKey));
    }
  }
  if (names.has('ncm_credentials')) {
    const rows = await dataSource.query('SELECT "credentialEnvelope" FROM "ncm_credentials"');
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!isSecretVaultEnvelope(row.credentialEnvelope)) {
        throw new DatabaseRestoreError('backup 中的 NCM credential 不是 SecretVault envelope');
      }
      envelopes.push(String(row.credentialEnvelope));
    }
  }
  if (envelopes.length === 0) return;
  const keyFile = path.join(backupDir, 'secret-vault.json');
  if (!fs.existsSync(keyFile)) {
    throw new DatabaseRestoreError('backup database 需要 SecretVault key，但 backup 中缺失该文件');
  }
  const vault = new SecretVault({ configDir: backupDir, createIfMissing: false });
  for (const envelope of envelopes) vault.decrypt(envelope);
}

interface RestoreOperation {
  target: string;
  staged: string | null;
  previous: string;
  hadPrevious: boolean;
  committed: boolean;
}

function stageFile(source: string, target: string, nonce: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.restore-new-${nonce}`;
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  return staged;
}

export async function restoreDatabaseBackup(options: {
  backupId: string;
  configDir?: string;
  databasePath?: string;
  failureInjector?: (point: 'after-stage' | 'after-first-replace') => void;
}): Promise<{ backupDir: string; schemaFingerprint: string }> {
  const configDir = options.configDir || CONFIG_DIR;
  const databasePath = options.databasePath || DATABASE_PATH;
  const backupDir = resolveBackupDirectory(configDir, options.backupId);
  const lock = acquireDatabaseMigrationLock(configDir);
  const nonce = crypto.randomBytes(8).toString('hex');
  const operations: RestoreOperation[] = [];
  try {
    const manifest = readAndValidateBackupManifest(backupDir);
    const databaseRecord = manifest.files.find((file) => file.logicalName === 'database');
    if (!databaseRecord) throw new DatabaseRestoreError('backup 缺少 database 文件记录');
    const backupDatabase = path.join(backupDir, databaseRecord.archivePath);
    const validation = await openValidationDatabase(backupDatabase);
    try {
      const schema = await inspectSchemaFingerprint(validation);
      if (schema.fingerprint !== manifest.source.schemaFingerprint) {
        throw new DatabaseRestoreError('backup database schema fingerprint 与 manifest 不一致');
      }
      await validateSecretCoupling(validation, backupDir);
    } finally {
      await validation.destroy();
    }

    const targetMap = new Map([
      ['database', databasePath],
      ['secret-vault-key', path.join(configDir, 'secret-vault.json')],
      ['jwt-secrets', path.join(configDir, 'jwt-secrets.json')],
    ]);
    for (const logicalName of ['database', 'secret-vault-key', 'jwt-secrets'] as const) {
      const target = targetMap.get(logicalName)!;
      const record = manifest.files.find((file) => file.logicalName === logicalName);
      const staged = record ? stageFile(path.join(backupDir, record.archivePath), target, nonce) : null;
      operations.push({
        target,
        staged,
        previous: `${target}.restore-old-${nonce}`,
        hadPrevious: fs.existsSync(target),
        committed: false,
      });
    }
    options.failureInjector?.('after-stage');

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation.hadPrevious) fs.renameSync(operation.target, operation.previous);
      if (operation.staged) fs.renameSync(operation.staged, operation.target);
      operation.committed = true;
      if (index === 0) options.failureInjector?.('after-first-replace');
    }

    const restored = await openValidationDatabase(databasePath);
    let fingerprint: string;
    try {
      const schema = await inspectSchemaFingerprint(restored);
      fingerprint = schema.fingerprint;
      if (fingerprint !== manifest.source.schemaFingerprint) {
        throw new DatabaseRestoreError('restore 后 schema fingerprint 验证失败');
      }
      await validateSecretCoupling(restored, configDir);
    } finally {
      await restored.destroy();
    }
    for (const operation of operations) {
      if (operation.hadPrevious && fs.existsSync(operation.previous)) fs.unlinkSync(operation.previous);
    }
    return { backupDir, schemaFingerprint: fingerprint };
  } catch (error) {
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.committed && fs.existsSync(operation.target)) fs.unlinkSync(operation.target);
        if (operation.hadPrevious && fs.existsSync(operation.previous)) {
          fs.renameSync(operation.previous, operation.target);
        }
        if (operation.staged && fs.existsSync(operation.staged)) fs.unlinkSync(operation.staged);
      } catch {
        // Leave the original exception visible. A remaining restore-old file is
        // deliberately not deleted and can be used for manual recovery.
      }
    }
    if (error instanceof DatabaseBackupError || error instanceof DatabaseRestoreError) throw error;
    throw new DatabaseRestoreError(
      `restore 失败，已尝试恢复原 live config: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    lock.release();
  }
}
