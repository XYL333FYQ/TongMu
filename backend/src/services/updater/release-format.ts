import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RELEASE_SIGNATURE_SCHEMA_VERSION = 1 as const;
export const RELEASE_PRODUCT = 'TongMu' as const;
export const MINIMUM_UPDATER_COMPATIBILITY_VERSION = '1.0.0';

export type ReleasePlatform = 'windows' | 'linux';
export type ReleaseArchitecture = 'x64';

export interface ReleaseManifest {
  schemaVersion: 1;
  product: 'TongMu';
  version: string;
  commitSha: string;
  buildTimestamp: string;
  platform: ReleasePlatform;
  architecture: ReleaseArchitecture;
  artifact: {
    filename: string;
    size: number;
    sha256: string;
  };
  inventory?: {
    filename: 'artifact-inventory.json';
    sha256: string;
  };
  signature: {
    algorithm: 'Ed25519';
    keyId: string;
  };
  minimumUpdaterCompatibilityVersion: string;
  buildEnvironment: {
    node: string;
    npm: string;
    lockfileSha256: string;
    reproducible: false;
  };
}

export interface ReleaseSignature {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  keyId: string;
  signature: string;
}

export interface TrustedUpdateKey {
  keyId: string;
  algorithm: 'Ed25519';
  publicKey: string;
  status: 'active' | 'retired' | 'revoked';
}

export class UpdateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateIntegrityError';
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(',')}}`;
  }
  throw new UpdateIntegrityError('manifest contains a non-JSON value');
}

/** UTF-8 canonical JSON: recursively sorted keys and exactly one trailing LF. */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${canonicalValue(value)}\n`, 'utf8');
}

export function releaseTarget(): {
  platform: ReleasePlatform;
  architecture: ReleaseArchitecture;
  extension: '.zip' | '.tar.gz';
} {
  const platform = os.platform();
  const architecture = os.arch();
  if (architecture !== 'x64') {
    throw new UpdateIntegrityError(`unsupported updater architecture: ${architecture}`);
  }
  if (platform === 'win32') return { platform: 'windows', architecture: 'x64', extension: '.zip' };
  if (platform === 'linux') return { platform: 'linux', architecture: 'x64', extension: '.tar.gz' };
  throw new UpdateIntegrityError(`unsupported updater platform: ${platform}`);
}

export function assertSafeArtifactFilename(filename: string): void {
  if (
    !filename ||
    filename.length > 180 ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename === '.' ||
    filename === '..' ||
    path.isAbsolute(filename) ||
    /^[A-Za-z]:/.test(filename)
  ) {
    throw new UpdateIntegrityError('unsafe artifact filename');
  }
}

export function canonicalArtifactFilename(
  version: string,
  platform: ReleasePlatform,
  architecture: ReleaseArchitecture,
  commitSha: string,
): string {
  const normalizedVersion = semver.valid(version);
  if (!normalizedVersion) throw new UpdateIntegrityError('release version must be valid SemVer');
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new UpdateIntegrityError('commit SHA must contain 40 hexadecimal characters');
  const extension = platform === 'windows' ? '.zip' : '.tar.gz';
  return `TongMu-${normalizedVersion}-${platform}-${architecture}-${commitSha.slice(0, 12).toLowerCase()}${extension}`;
}

export function legacyArtifactFilename(platform: ReleasePlatform): string {
  return platform === 'windows' ? 'zviewer-windows-x64.zip' : 'zviewer-linux-x64.tar.gz';
}

function stringField(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new UpdateIntegrityError(`invalid manifest field: ${name}`);
  }
  return value;
}

export function parseReleaseManifest(raw: Buffer | string): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch {
    throw new UpdateIntegrityError('release manifest is not valid JSON');
  }
  const value = parsed as Partial<ReleaseManifest>;
  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || value.product !== RELEASE_PRODUCT) {
    throw new UpdateIntegrityError('unsupported release manifest product or schema');
  }
  const version = stringField(value.version, 'version', 64);
  if (!semver.valid(version)) throw new UpdateIntegrityError('manifest version is not valid SemVer');
  const commitSha = stringField(value.commitSha, 'commitSha', 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new UpdateIntegrityError('manifest commit SHA is invalid');
  const buildTimestamp = stringField(value.buildTimestamp, 'buildTimestamp', 64);
  if (!Number.isFinite(Date.parse(buildTimestamp))) throw new UpdateIntegrityError('manifest build timestamp is invalid');
  if (value.platform !== 'windows' && value.platform !== 'linux') throw new UpdateIntegrityError('manifest platform is invalid');
  if (value.architecture !== 'x64') throw new UpdateIntegrityError('manifest architecture is invalid');
  const artifact = value.artifact as ReleaseManifest['artifact'] | undefined;
  if (!artifact) throw new UpdateIntegrityError('manifest artifact is missing');
  const filename = stringField(artifact.filename, 'artifact.filename', 180);
  assertSafeArtifactFilename(filename);
  if (filename !== canonicalArtifactFilename(version, value.platform, value.architecture, commitSha)) {
    throw new UpdateIntegrityError('manifest artifact filename is not canonical');
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 2 * 1024 * 1024 * 1024) {
    throw new UpdateIntegrityError('manifest artifact size is invalid');
  }
  const sha256 = stringField(artifact.sha256, 'artifact.sha256', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UpdateIntegrityError('manifest artifact SHA-256 is invalid');
  let inventory: ReleaseManifest['inventory'];
  if (value.inventory !== undefined) {
    const candidate = value.inventory as ReleaseManifest['inventory'];
    if (!candidate || candidate.filename !== 'artifact-inventory.json') {
      throw new UpdateIntegrityError('manifest inventory filename is invalid');
    }
    const inventorySha256 = stringField(candidate.sha256, 'inventory.sha256', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(inventorySha256)) throw new UpdateIntegrityError('manifest inventory SHA-256 is invalid');
    inventory = { filename: 'artifact-inventory.json', sha256: inventorySha256 };
  }
  const signature = value.signature as ReleaseManifest['signature'] | undefined;
  if (!signature || signature.algorithm !== 'Ed25519') throw new UpdateIntegrityError('unsupported manifest signature algorithm');
  const keyId = stringField(signature.keyId, 'signature.keyId', 96);
  const minimum = stringField(value.minimumUpdaterCompatibilityVersion, 'minimumUpdaterCompatibilityVersion', 64);
  if (!semver.valid(minimum)) throw new UpdateIntegrityError('minimum updater version is invalid');
  const env = value.buildEnvironment as ReleaseManifest['buildEnvironment'] | undefined;
  if (!env || env.reproducible !== false) throw new UpdateIntegrityError('manifest build environment is invalid');
  const node = stringField(env.node, 'buildEnvironment.node', 64);
  const npm = stringField(env.npm, 'buildEnvironment.npm', 64);
  const lockfileSha256 = stringField(env.lockfileSha256, 'buildEnvironment.lockfileSha256', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(lockfileSha256)) throw new UpdateIntegrityError('lockfile SHA-256 is invalid');
  return {
    schemaVersion: 1,
    product: 'TongMu',
    version,
    commitSha,
    buildTimestamp,
    platform: value.platform,
    architecture: value.architecture,
    artifact: { filename, size: artifact.size, sha256 },
    ...(inventory ? { inventory } : {}),
    signature: { algorithm: 'Ed25519', keyId },
    minimumUpdaterCompatibilityVersion: minimum,
    buildEnvironment: { node, npm, lockfileSha256, reproducible: false },
  };
}

export function parseReleaseSignature(raw: Buffer | string): ReleaseSignature {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch {
    throw new UpdateIntegrityError('release signature is not valid JSON');
  }
  const value = parsed as Partial<ReleaseSignature>;
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new UpdateIntegrityError('unsupported release signature format');
  }
  const keyId = stringField(value.keyId, 'signature.keyId', 96);
  const signature = stringField(value.signature, 'signature.signature', 256);
  let decoded: Buffer;
  try { decoded = Buffer.from(signature, 'base64'); } catch { throw new UpdateIntegrityError('release signature is malformed'); }
  if (decoded.length !== 64 || decoded.toString('base64') !== signature) {
    throw new UpdateIntegrityError('release signature is malformed');
  }
  return { schemaVersion: 1, algorithm: 'Ed25519', keyId, signature };
}

export function loadTrustedUpdateKeys(): TrustedUpdateKey[] {
  const raw = process.env.TONGMU_UPDATE_TRUSTED_KEYS;
  if (!raw) throw new UpdateIntegrityError('no trusted TongMu update verification keys are configured');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new UpdateIntegrityError('trusted update key configuration is invalid'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    throw new UpdateIntegrityError('trusted update key set must contain 1-8 keys');
  }
  const seen = new Set<string>();
  return parsed.map((item) => {
    const value = item as Partial<TrustedUpdateKey>;
    const keyId = stringField(value.keyId, 'trustedKey.keyId', 96);
    if (seen.has(keyId)) throw new UpdateIntegrityError('trusted update key IDs must be unique');
    seen.add(keyId);
    if (value.algorithm !== 'Ed25519' || !['active', 'retired', 'revoked'].includes(String(value.status))) {
      throw new UpdateIntegrityError('trusted update key metadata is invalid');
    }
    const publicKey = stringField(value.publicKey, 'trustedKey.publicKey', 4096);
    try { crypto.createPublicKey(publicKey); } catch { throw new UpdateIntegrityError(`trusted update public key ${keyId} is invalid`); }
    return { keyId, algorithm: 'Ed25519', publicKey, status: value.status as TrustedUpdateKey['status'] };
  });
}

export function verifyReleaseSignature(
  manifestBytes: Buffer,
  manifest: ReleaseManifest,
  signature: ReleaseSignature,
  keys: TrustedUpdateKey[],
): void {
  if (!manifestBytes.equals(canonicalJson(manifest))) {
    throw new UpdateIntegrityError('manifest is not in canonical serialization');
  }
  if (signature.algorithm !== manifest.signature.algorithm || signature.keyId !== manifest.signature.keyId) {
    throw new UpdateIntegrityError('manifest and detached signature metadata do not match');
  }
  const key = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (!key) throw new UpdateIntegrityError('release signature uses an unknown key');
  if (key.status === 'revoked') throw new UpdateIntegrityError('release signature uses a revoked key');
  const ok = crypto.verify(null, manifestBytes, key.publicKey, Buffer.from(signature.signature, 'base64'));
  if (!ok) throw new UpdateIntegrityError('release signature verification failed');
}

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
