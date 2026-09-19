import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATABASE_MIGRATION_LOCK_FILENAME } from '../../migrations/database-lock';
import type { ReleaseManifest } from './release-format';
import { UpdateIntegrityError } from './release-format';

export const PROGRAM_UPDATE_LOCK_FILENAME = 'program-update.lock';
export const UPDATE_STATE_DIRECTORY = 'update-state';
export const UPDATE_MARKER_FILENAME = 'transaction.json';

export type UpdateTransactionStage =
  | 'downloading'
  | 'downloaded'
  | 'verified'
  | 'extracting'
  | 'ready-to-apply'
  | 'applying'
  | 'swapped'
  | 'healthy'
  | 'rollback-required'
  | 'rolled-back'
  | 'failed';

export interface UpdateTransactionMarker {
  formatVersion: 1;
  updateId: string;
  from: { version: string; commitSha: string };
  to: { version: string; commitSha: string };
  artifact: { filename: string; sha256: string; size: number };
  stage: UpdateTransactionStage;
  createdAt: string;
  updatedAt: string;
  packageDirectory: string;
  backupDirectory: string;
  newProgramEntries?: string[];
  previousProgramEntries?: string[];
  failure?: string;
  databaseRestoreRequired?: boolean;
}

interface LockRecord {
  formatVersion: 1;
  pid: number;
  hostname: string;
  createdAt: string;
  nonce: string;
}

export class UpdateLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateLockError';
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(file: string): LockRecord {
  let value: Partial<LockRecord>;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockRecord>; }
  catch { throw new UpdateLockError(`update lock is unreadable: ${file}`); }
  if (
    value.formatVersion !== 1 || !Number.isInteger(value.pid) ||
    typeof value.hostname !== 'string' || typeof value.createdAt !== 'string' ||
    typeof value.nonce !== 'string'
  ) throw new UpdateLockError(`update lock has an invalid format: ${file}`);
  return value as LockRecord;
}

export interface ProgramUpdateLock {
  path: string;
  release(): void;
}

export function updateStateRoot(configDir: string): string {
  return path.join(configDir, UPDATE_STATE_DIRECTORY);
}

export function acquireProgramUpdateLock(configDir: string): ProgramUpdateLock {
  const stateRoot = updateStateRoot(configDir);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateRoot, PROGRAM_UPDATE_LOCK_FILENAME);
  if (fs.existsSync(lockPath)) {
    const existing = parseLock(lockPath);
    if (existing.hostname !== os.hostname() || processIsAlive(existing.pid)) {
      throw new UpdateLockError(`another program update owns the lock (PID ${existing.pid} on ${existing.hostname})`);
    }
    const archived = `${lockPath}.stale-${existing.createdAt.replace(/[^0-9A-Za-z.-]/g, '-')}-${existing.nonce.slice(0, 12)}`;
    fs.renameSync(lockPath, archived);
  }
  const record: LockRecord = {
    formatVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      if (!fs.existsSync(lockPath)) return;
      const current = parseLock(lockPath);
      if (current.nonce !== record.nonce || current.pid !== record.pid) {
        throw new UpdateLockError('program update lock ownership changed');
      }
      fs.unlinkSync(lockPath);
    },
  };
}

function markerPath(configDir: string): string {
  return path.join(updateStateRoot(configDir), UPDATE_MARKER_FILENAME);
}

function atomicJsonWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function validateMarker(value: unknown): UpdateTransactionMarker {
  const marker = value as Partial<UpdateTransactionMarker>;
  const stages: UpdateTransactionStage[] = [
    'downloading', 'downloaded', 'verified', 'extracting', 'ready-to-apply',
    'applying', 'swapped', 'healthy', 'rollback-required', 'rolled-back', 'failed',
  ];
  const validEntries = (entries: unknown): entries is string[] => Array.isArray(entries) && entries.every((entry) => (
    typeof entry === 'string' && entry.length > 0 && entry.length <= 255 &&
    entry !== '.' && entry !== '..' && !entry.includes('/') && !entry.includes('\\') && !entry.includes('\0')
  ));
  if (
    marker.formatVersion !== 1 || typeof marker.updateId !== 'string' ||
    !marker.from || typeof marker.from.version !== 'string' || typeof marker.from.commitSha !== 'string' ||
    !marker.to || typeof marker.to.version !== 'string' || typeof marker.to.commitSha !== 'string' ||
    !marker.artifact || typeof marker.artifact.sha256 !== 'string' ||
    typeof marker.artifact.filename !== 'string' || !Number.isSafeInteger(marker.artifact.size) ||
    !stages.includes(marker.stage as UpdateTransactionStage) ||
    typeof marker.packageDirectory !== 'string' || typeof marker.backupDirectory !== 'string' ||
    (marker.newProgramEntries !== undefined && !validEntries(marker.newProgramEntries)) ||
    (marker.previousProgramEntries !== undefined && !validEntries(marker.previousProgramEntries))
  ) throw new UpdateIntegrityError('update transaction marker is invalid');
  return marker as UpdateTransactionMarker;
}

export function readUpdateMarker(configDir: string): UpdateTransactionMarker | null {
  const file = markerPath(configDir);
  if (!fs.existsSync(file)) return null;
  try { return validateMarker(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error instanceof UpdateIntegrityError) throw error;
    throw new UpdateIntegrityError('update transaction marker cannot be parsed');
  }
}

export function writeUpdateMarker(configDir: string, marker: UpdateTransactionMarker): void {
  marker.updatedAt = new Date().toISOString();
  atomicJsonWrite(markerPath(configDir), marker);
}

export function createUpdateMarker(
  configDir: string,
  manifest: ReleaseManifest,
  from: { version: string; commitSha: string },
): UpdateTransactionMarker {
  const existing = readUpdateMarker(configDir);
  if (existing && !['healthy', 'rolled-back', 'failed'].includes(existing.stage)) {
    throw new UpdateLockError(`an unfinished update already exists at stage ${existing.stage}`);
  }
  const updateId = `${manifest.version}-${manifest.commitSha.slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`;
  const transactionRoot = path.join(updateStateRoot(configDir), 'staging', updateId);
  const now = new Date().toISOString();
  const marker: UpdateTransactionMarker = {
    formatVersion: 1,
    updateId,
    from,
    to: { version: manifest.version, commitSha: manifest.commitSha },
    artifact: {
      filename: manifest.artifact.filename,
      sha256: manifest.artifact.sha256,
      size: manifest.artifact.size,
    },
    stage: 'downloading',
    createdAt: now,
    updatedAt: now,
    packageDirectory: path.join(transactionRoot, 'extracted'),
    backupDirectory: path.join(transactionRoot, 'previous-program'),
  };
  writeUpdateMarker(configDir, marker);
  return marker;
}

export function setUpdateStage(
  configDir: string,
  marker: UpdateTransactionMarker,
  stage: UpdateTransactionStage,
  failure?: string,
): void {
  marker.stage = stage;
  if (failure) marker.failure = failure.slice(0, 1024);
  writeUpdateMarker(configDir, marker);
}

function assertDatabaseLifecycleIdle(configDir: string): void {
  const lockPath = path.join(configDir, DATABASE_MIGRATION_LOCK_FILENAME);
  if (!fs.existsSync(lockPath)) return;
  let record: LockRecord;
  try { record = parseLock(lockPath); }
  catch { throw new UpdateLockError('database lifecycle lock is unreadable; program replacement is blocked'); }
  if (record.hostname !== os.hostname() || processIsAlive(record.pid)) {
    throw new UpdateLockError(`database migration/restore is active (PID ${record.pid} on ${record.hostname})`);
  }
  // A dead same-host lock is deliberately left for the Phase 6A startup
  // recovery path to archive. Its owner is gone, so no lifecycle operation is active.
}

function topLevelPackageEntries(packageDirectory: string): string[] {
  return fs.readdirSync(packageDirectory).sort((a, b) => a.localeCompare(b, 'en'));
}

function preservedInstallEntries(configDir: string, installRoot: string): Set<string> {
  const preserved = new Set(['.env', '.prod.pids.json', 'log', 'logs', 'uploads', 'media', 'backups']);
  const relativeConfig = path.relative(installRoot, configDir);
  if (relativeConfig && !relativeConfig.startsWith('..') && !path.isAbsolute(relativeConfig)) {
    preserved.add(relativeConfig.split(path.sep)[0]);
  }
  return preserved;
}

function currentProgramEntries(configDir: string, installRoot: string): string[] {
  const preserved = preservedInstallEntries(configDir, installRoot);
  return fs.readdirSync(installRoot)
    .filter((name) => !preserved.has(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function moveIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(destination)) throw new UpdateIntegrityError(`update swap destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function rollbackFiles(installRoot: string, marker: UpdateTransactionMarker): void {
  const names = new Set<string>([...(marker.newProgramEntries || []), ...(marker.previousProgramEntries || [])]);
  if (fs.existsSync(marker.packageDirectory)) for (const name of fs.readdirSync(marker.packageDirectory)) names.add(name);
  if (fs.existsSync(marker.backupDirectory)) for (const name of fs.readdirSync(marker.backupDirectory)) names.add(name);
  for (const name of [...names].sort((a, b) => b.localeCompare(a, 'en'))) {
    const live = path.join(installRoot, name);
    const staged = path.join(marker.packageDirectory, name);
    const previous = path.join(marker.backupDirectory, name);
    if (fs.existsSync(previous)) {
      if (fs.existsSync(live)) moveIfPresent(live, staged);
      moveIfPresent(previous, live);
    } else if (fs.existsSync(live) && marker.newProgramEntries?.includes(name)) {
      moveIfPresent(live, staged);
    }
  }
}

export function applyPendingUpdate(configDir: string, installRoot: string): UpdateTransactionMarker {
  const lock = acquireProgramUpdateLock(configDir);
  try {
    assertDatabaseLifecycleIdle(configDir);
    const marker = readUpdateMarker(configDir);
    if (!marker) throw new UpdateIntegrityError('no pending update exists');
    if (!['ready-to-apply', 'applying'].includes(marker.stage)) {
      throw new UpdateIntegrityError(`update cannot be applied from stage ${marker.stage}`);
    }
    if (!fs.existsSync(marker.packageDirectory)) throw new UpdateIntegrityError('staged package directory is missing');
    fs.mkdirSync(marker.backupDirectory, { recursive: true, mode: 0o700 });
    marker.newProgramEntries ||= topLevelPackageEntries(marker.packageDirectory);
    marker.previousProgramEntries ||= currentProgramEntries(configDir, installRoot);
    setUpdateStage(configDir, marker, 'applying');
    for (const name of marker.previousProgramEntries) {
      const live = path.join(installRoot, name);
      const previous = path.join(marker.backupDirectory, name);
      // Idempotent interruption recovery: an existing backup means the old
      // entry already moved.
      if (fs.existsSync(live) && !fs.existsSync(previous)) moveIfPresent(live, previous);
    }
    for (const name of marker.newProgramEntries) {
      const live = path.join(installRoot, name);
      const staged = path.join(marker.packageDirectory, name);
      if (fs.existsSync(staged) && !fs.existsSync(live)) moveIfPresent(staged, live);
      if (!fs.existsSync(live)) throw new UpdateIntegrityError(`program swap did not install ${name}`);
    }
    setUpdateStage(configDir, marker, 'swapped');
    return marker;
  } catch (error) {
    const marker = readUpdateMarker(configDir);
    if (marker && marker.stage === 'applying') {
      try {
        rollbackFiles(installRoot, marker);
        marker.databaseRestoreRequired = true;
        setUpdateStage(configDir, marker, 'rolled-back', error instanceof Error ? error.message : String(error));
      } catch (rollbackError) {
        setUpdateStage(configDir, marker, 'rollback-required', rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

export function rollbackPendingUpdate(configDir: string, installRoot: string, reason: string): UpdateTransactionMarker {
  const lock = acquireProgramUpdateLock(configDir);
  try {
    assertDatabaseLifecycleIdle(configDir);
    const marker = readUpdateMarker(configDir);
    if (!marker || !['swapped', 'rollback-required'].includes(marker.stage)) {
      throw new UpdateIntegrityError('no swapped update is available for rollback');
    }
    rollbackFiles(installRoot, marker);
    marker.databaseRestoreRequired = true;
    setUpdateStage(configDir, marker, 'rolled-back', reason);
    return marker;
  } finally {
    lock.release();
  }
}

export function finalizeHealthyUpdate(configDir: string, version: string, commitSha: string): UpdateTransactionMarker {
  const lock = acquireProgramUpdateLock(configDir);
  try {
    const marker = readUpdateMarker(configDir);
    if (!marker || marker.stage !== 'swapped') throw new UpdateIntegrityError('no swapped update is awaiting health confirmation');
    if (marker.to.version !== version || marker.to.commitSha !== commitSha) {
      throw new UpdateIntegrityError('health identity does not match the pending update');
    }
    fs.rmSync(marker.backupDirectory, { recursive: true, force: true });
    const transactionRoot = path.dirname(marker.packageDirectory);
    for (const name of ['download', 'extracted']) fs.rmSync(path.join(transactionRoot, name), { recursive: true, force: true });
    setUpdateStage(configDir, marker, 'healthy');
    return marker;
  } finally {
    lock.release();
  }
}

export function recoverInterruptedUpdate(configDir: string, installRoot: string): UpdateTransactionMarker | null {
  const marker = readUpdateMarker(configDir);
  if (!marker) return null;
  if (marker.stage === 'applying') return applyPendingUpdate(configDir, installRoot);
  if (['downloading', 'downloaded', 'verified', 'extracting'].includes(marker.stage)) {
    const lock = acquireProgramUpdateLock(configDir);
    try {
      fs.rmSync(path.dirname(marker.packageDirectory), { recursive: true, force: true });
      setUpdateStage(configDir, marker, 'failed', `interrupted at stage ${marker.stage}`);
    } finally { lock.release(); }
  }
  return marker;
}

export const transactionInternalsForTests = {
  assertDatabaseLifecycleIdle,
  rollbackFiles,
  markerPath,
};
