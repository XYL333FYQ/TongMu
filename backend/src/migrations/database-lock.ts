import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATABASE_MIGRATION_LOCK_FILENAME = 'database-migration.lock';

interface LockRecord {
  formatVersion: 1;
  pid: number;
  hostname: string;
  createdAt: string;
  nonce: string;
  // Optional for compatibility with locks written by older releases.
  processIdentity?: string;
  processStartedAt?: number;
}

const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

function linuxProcessIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces or parentheses; starttime is field 22.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!boot || !/^\d+$/.test(start)) return undefined;
    return `${boot}:${start}`;
  } catch {
    return undefined;
  }
}

function lockOwnerIsAlive(record: LockRecord): boolean {
  if (!processIsAlive(record.pid)) return false;
  const identity = linuxProcessIdentity(record.pid);
  if (record.processIdentity && identity) return record.processIdentity === identity;

  // PID reuse also affects legacy Docker locks: the replacement process is
  // itself PID 1. A lock predating this process cannot belong to this process.
  // Keep a margin for startup timestamp rounding; ambiguous locks stay closed.
  if (record.pid === process.pid) {
    const started = record.processStartedAt ?? Date.parse(record.createdAt);
    if (Number.isFinite(started) && started < PROCESS_STARTED_AT - 1000) return false;
  }
  return true;
}

export class DatabaseMigrationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseMigrationLockError';
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function readLock(lockPath: string): LockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw new DatabaseMigrationLockError(
      `数据库迁移锁无法解析：${lockPath}。请确认没有运行中的 TongMu，再手动处理该锁文件。`,
    );
  }
  const record = parsed as Partial<LockRecord>;
  if (
    record.formatVersion !== 1 ||
    !Number.isInteger(record.pid) ||
    typeof record.hostname !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.nonce !== 'string' ||
    (record.processIdentity !== undefined && typeof record.processIdentity !== 'string') ||
    (record.processStartedAt !== undefined && !Number.isFinite(record.processStartedAt))
  ) {
    throw new DatabaseMigrationLockError(
      `数据库迁移锁格式无效：${lockPath}。为避免双迁移，启动已拒绝。`,
    );
  }
  return record as LockRecord;
}

function archiveStaleSameHostLock(lockPath: string, record: LockRecord): void {
  const safeTimestamp = record.createdAt.replace(/[^0-9A-Za-z.-]/g, '-');
  const archived = `${lockPath}.stale-${safeTimestamp}-${record.nonce.slice(0, 12)}`;
  fs.renameSync(lockPath, archived);
}

export interface DatabaseMigrationLock {
  path: string;
  nonce: string;
  release(): void;
}

export function acquireDatabaseMigrationLock(configDir: string): DatabaseMigrationLock {
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = path.join(configDir, DATABASE_MIGRATION_LOCK_FILENAME);
  if (fs.existsSync(lockPath)) {
    const existing = readLock(lockPath);
    if (existing.hostname !== os.hostname()) {
      throw new DatabaseMigrationLockError(
        `数据库迁移锁来自另一主机 ${existing.hostname}（PID ${existing.pid}）。无法安全判断是否仍在运行，启动已拒绝。`,
      );
    }
    if (lockOwnerIsAlive(existing)) {
      throw new DatabaseMigrationLockError(
        `另一个 TongMu 数据库初始化器仍在运行（PID ${existing.pid}），已阻止并发迁移。`,
      );
    }
    archiveStaleSameHostLock(lockPath, existing);
  }

  const record: LockRecord = {
    formatVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
    processIdentity: linuxProcessIdentity(process.pid),
    processStartedAt: PROCESS_STARTED_AT,
  };
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new DatabaseMigrationLockError(
      `无法取得数据库迁移锁 ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let released = false;
  return {
    path: lockPath,
    nonce: record.nonce,
    release() {
      if (released) return;
      released = true;
      if (!fs.existsSync(lockPath)) return;
      const current = readLock(lockPath);
      if (current.nonce !== record.nonce || current.pid !== process.pid) {
        throw new DatabaseMigrationLockError('数据库迁移锁所有权已变化；拒绝删除未知锁。');
      }
      fs.unlinkSync(lockPath);
    },
  };
}
