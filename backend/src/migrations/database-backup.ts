import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DataSource } from 'typeorm';
import { SECRET_VAULT_KEY_FILENAME } from '../services/secret-vault';

export const DATABASE_BACKUP_FORMAT_VERSION = 1;
export const DEFAULT_BACKUP_RETENTION_COUNT = 20;

interface BackupFileRecord {
  logicalName: 'database' | 'secret-vault-key' | 'jwt-secrets';
  archivePath: string;
  restoreTarget: 'DATABASE_PATH' | 'CONFIG_DIR/secret-vault.json' | 'CONFIG_DIR/jwt-secrets.json';
  sha256: string;
  size: number;
}

export interface DatabaseBackupManifest {
  formatVersion: typeof DATABASE_BACKUP_FORMAT_VERSION;
  backupId: string;
  createdAt: string;
  reason: 'pre-migration';
  source: {
    configDir: string;
    databasePath: string;
    schemaId: string;
    schemaFingerprint: string;
    databaseFileExisted: boolean;
  };
  targetMigration: string;
  secretVaultKeyRequired: boolean;
  files: BackupFileRecord[];
}

export class DatabaseBackupError extends Error {
  cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DatabaseBackupError';
    this.cause = options?.cause;
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function writeFileDurably(filePath: string, data: Buffer | string): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function exportDatabase(dataSource: DataSource): Buffer {
  const driver = dataSource.driver as typeof dataSource.driver & {
    export?: () => Uint8Array;
    databaseConnection?: { exec(sql: string): unknown };
  };
  if (typeof driver.export !== 'function') {
    throw new DatabaseBackupError('当前数据库驱动不支持一致性导出，拒绝执行 migration。');
  }
  const exported = Buffer.from(driver.export());
  driver.databaseConnection?.exec('PRAGMA foreign_keys = ON');
  return exported;
}

function isVerifiedBackupDirectory(directory: string): boolean {
  try {
    const manifestPath = path.join(directory, 'manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<DatabaseBackupManifest>;
    return parsed.formatVersion === DATABASE_BACKUP_FORMAT_VERSION && parsed.backupId === path.basename(directory);
  } catch {
    return false;
  }
}

export function pruneDatabaseBackups(
  backupsDir: string,
  retentionCount = DEFAULT_BACKUP_RETENTION_COUNT,
): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  const verified = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(entry.name))
    .map((entry) => path.join(backupsDir, entry.name))
    .filter(isVerifiedBackupDirectory)
    .sort();
  const removeCount = Math.max(0, verified.length - Math.max(2, retentionCount));
  const removed: string[] = [];
  for (const directory of verified.slice(0, removeCount)) {
    fs.rmSync(directory, { recursive: true, force: false });
    removed.push(directory);
  }
  return removed;
}

export interface CreateDatabaseBackupOptions {
  dataSource: DataSource;
  configDir: string;
  databasePath: string;
  databaseFileExisted: boolean;
  schemaId: string;
  schemaFingerprint: string;
  targetMigration: string;
  secretVaultKeyRequired: boolean;
  retentionCount?: number;
  failureInjector?: (point: 'before-write' | 'after-database' | 'before-commit') => void;
}

export function createPreMigrationBackup(options: CreateDatabaseBackupOptions): {
  backupDir: string;
  manifest: DatabaseBackupManifest;
} {
  const backupsDir = path.join(options.configDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupId = `${timestamp}-${options.schemaFingerprint.slice(0, 12)}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingDir = path.join(backupsDir, `.staging-${backupId}`);
  const backupDir = path.join(backupsDir, backupId);
  fs.mkdirSync(stagingDir, { recursive: false });
  try {
    options.failureInjector?.('before-write');
    const files: BackupFileRecord[] = [];
    const database = exportDatabase(options.dataSource);
    writeFileDurably(path.join(stagingDir, 'database.sqlite'), database);
    files.push({
      logicalName: 'database',
      archivePath: 'database.sqlite',
      restoreTarget: 'DATABASE_PATH',
      sha256: sha256(database),
      size: database.length,
    });
    options.failureInjector?.('after-database');

    for (const item of [
      { filename: SECRET_VAULT_KEY_FILENAME, logicalName: 'secret-vault-key' as const, restoreTarget: 'CONFIG_DIR/secret-vault.json' as const },
      { filename: 'jwt-secrets.json', logicalName: 'jwt-secrets' as const, restoreTarget: 'CONFIG_DIR/jwt-secrets.json' as const },
    ]) {
      const source = path.join(options.configDir, item.filename);
      if (!fs.existsSync(source)) continue;
      const contents = fs.readFileSync(source);
      writeFileDurably(path.join(stagingDir, item.filename), contents);
      files.push({
        logicalName: item.logicalName,
        archivePath: item.filename,
        restoreTarget: item.restoreTarget,
        sha256: sha256(contents),
        size: contents.length,
      });
    }
    if (options.secretVaultKeyRequired && !files.some((file) => file.logicalName === 'secret-vault-key')) {
      throw new DatabaseBackupError('数据库包含 SecretVault envelope，但 secret-vault.json 缺失；拒绝升级。');
    }
    const manifest: DatabaseBackupManifest = {
      formatVersion: DATABASE_BACKUP_FORMAT_VERSION,
      backupId,
      createdAt: new Date().toISOString(),
      reason: 'pre-migration',
      source: {
        configDir: options.configDir,
        databasePath: options.databasePath,
        schemaId: options.schemaId,
        schemaFingerprint: options.schemaFingerprint,
        databaseFileExisted: options.databaseFileExisted,
      },
      targetMigration: options.targetMigration,
      secretVaultKeyRequired: options.secretVaultKeyRequired,
      files,
    };
    writeFileDurably(
      path.join(stagingDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    options.failureInjector?.('before-commit');
    fs.renameSync(stagingDir, backupDir);
    pruneDatabaseBackups(backupsDir, options.retentionCount);
    return { backupDir, manifest };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error instanceof DatabaseBackupError
      ? error
      : new DatabaseBackupError(
        `迁移前备份失败；数据库未进入 migration: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
  }
}

export function readAndValidateBackupManifest(backupDir: string): DatabaseBackupManifest {
  let manifest: DatabaseBackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as DatabaseBackupManifest;
  } catch (error) {
    throw new DatabaseBackupError('backup manifest 无法读取或不是有效 JSON', { cause: error });
  }
  if (
    manifest.formatVersion !== DATABASE_BACKUP_FORMAT_VERSION ||
    manifest.backupId !== path.basename(backupDir) ||
    !Array.isArray(manifest.files)
  ) {
    throw new DatabaseBackupError('backup manifest 格式或目录身份无效');
  }
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9._-]+$/.test(file.archivePath) || path.basename(file.archivePath) !== file.archivePath) {
      throw new DatabaseBackupError('backup manifest 包含不安全路径');
    }
    let contents: Buffer;
    try {
      contents = fs.readFileSync(path.join(backupDir, file.archivePath));
    } catch (error) {
      throw new DatabaseBackupError(`backup 文件缺失或无法读取: ${file.logicalName}`, { cause: error });
    }
    if (contents.length !== file.size || sha256(contents) !== file.sha256) {
      throw new DatabaseBackupError(`backup 文件 hash/size 校验失败: ${file.logicalName}`);
    }
  }
  return manifest;
}
