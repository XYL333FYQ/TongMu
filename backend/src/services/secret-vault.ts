import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths';

const MASTER_KEY_FILE = 'secret-vault.json';
const MASTER_KEY_VERSION = 1;
const ENVELOPE_VERSION = 'v1';
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretVaultError';
  }
}

export interface SecretVaultOptions {
  configDir?: string;
  /** Test-only injection; production always loads the persisted key. */
  masterKey?: Buffer;
}

interface MasterKeyFile {
  version: typeof MASTER_KEY_VERSION;
  algorithm: 'aes-256-gcm';
  key: string;
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new SecretVaultError('SecretVault 数据格式无效');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw new SecretVaultError('SecretVault 数据格式无效');
  }
  // Base64URL decoders commonly ignore non-zero unused padding bits. Require
  // the canonical re-encoding so a one-character envelope mutation cannot
  // silently authenticate as the original bytes.
  if (decoded.toString('base64url') !== value) {
    throw new SecretVaultError('SecretVault 数据格式无效');
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new SecretVaultError('SecretVault 数据长度无效');
  }
  return decoded;
}

function readMasterKey(filePath: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new SecretVaultError('SecretVault master key 文件无法读取');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SecretVaultError('SecretVault master key 文件格式无效');
  }
  const record = parsed as Partial<MasterKeyFile>;
  if (record.version !== MASTER_KEY_VERSION || record.algorithm !== 'aes-256-gcm') {
    throw new SecretVaultError('SecretVault master key 版本不受支持');
  }
  return decode(record.key, MASTER_KEY_BYTES);
}

function writeMasterKeyAtomically(filePath: string, key: Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const payload: MasterKeyFile = {
    version: MASTER_KEY_VERSION,
    algorithm: 'aes-256-gcm',
    key: encode(key),
  };
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const contents = `${JSON.stringify(payload)}\n`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      // Install the fully-written inode without replacing a key another
      // process may have created concurrently. A hard-link create is atomic
      // and, unlike POSIX rename, fails with EEXIST instead of overwriting.
      fs.linkSync(tempPath, filePath);
      fs.rmSync(tempPath, { force: true });
    } catch (err) {
      // If another process won the first-install race, keep its key. Hard
      // links are supported by the normal NTFS/ext4 config filesystems; the
      // exclusive-create fallback handles filesystems that do not support it.
      if (fs.existsSync(filePath)) {
        fs.rmSync(tempPath, { force: true });
        return;
      }
      try {
        const targetFd = fs.openSync(filePath, 'wx', 0o600);
        try {
          fs.writeFileSync(targetFd, contents, 'utf8');
          fs.fsyncSync(targetFd);
        } finally {
          fs.closeSync(targetFd);
        }
        fs.rmSync(tempPath, { force: true });
      } catch (fallbackError) {
        if (fs.existsSync(filePath)) {
          fs.rmSync(tempPath, { force: true });
          return;
        }
        throw fallbackError instanceof Error ? fallbackError : err;
      }
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows does not expose POSIX permissions; normal NTFS ACLs apply.
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw new SecretVaultError(
      err instanceof Error ? `SecretVault master key 保存失败: ${err.message}` : 'SecretVault master key 保存失败',
    );
  }
}

function loadOrCreateMasterKey(configDir: string): Buffer {
  const filePath = path.join(configDir, MASTER_KEY_FILE);
  if (fs.existsSync(filePath)) return readMasterKey(filePath);
  writeMasterKeyAtomically(filePath, crypto.randomBytes(MASTER_KEY_BYTES));
  // If another process won a first-install race, read the key that won.
  return readMasterKey(filePath);
}

function decodeEnvelopePart(value: string, label: string): Buffer {
  try {
    return decode(value);
  } catch {
    throw new SecretVaultError(`SecretVault ${label} 格式无效`);
  }
}

/** True only for an explicitly versioned SecretVault envelope. */
export function isSecretVaultEnvelope(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ENVELOPE_VERSION}:`);
}

/**
 * TongMu's authenticated secret store.
 *
 * Envelope: v1:<random iv>:<authentication tag>:<ciphertext>
 * The master key is persisted below CONFIG_DIR, never in a database column.
 */
export class SecretVault {
  private readonly configDir: string;
  private readonly injectedMasterKey?: Buffer;
  private cachedMasterKey?: Buffer;

  constructor(options: SecretVaultOptions = {}) {
    this.configDir = options.configDir || CONFIG_DIR;
    if (options.masterKey !== undefined) {
      if (options.masterKey.length !== MASTER_KEY_BYTES) {
        throw new SecretVaultError('SecretVault master key 长度无效');
      }
      this.injectedMasterKey = Buffer.from(options.masterKey);
    }
  }

  private masterKey(): Buffer {
    if (!this.cachedMasterKey) {
      this.cachedMasterKey = this.injectedMasterKey
        ? Buffer.from(this.injectedMasterKey)
        : loadOrCreateMasterKey(this.configDir);
    }
    return this.cachedMasterKey;
  }

  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new SecretVaultError('SecretVault 仅支持字符串 secret');
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENVELOPE_VERSION}:${encode(iv)}:${encode(tag)}:${encode(ciphertext)}`;
  }

  decrypt(envelope: string): string {
    if (!isSecretVaultEnvelope(envelope)) {
      throw new SecretVaultError('SecretVault envelope 版本无效');
    }
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new SecretVaultError('SecretVault envelope 格式无效');
    }
    const iv = decodeEnvelopePart(parts[1], 'iv');
    const tag = decodeEnvelopePart(parts[2], 'tag');
    const ciphertext = decodeEnvelopePart(parts[3], 'ciphertext');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretVaultError('SecretVault envelope 长度无效');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Do not expose whether the key, IV, tag, or ciphertext was wrong.
      throw new SecretVaultError('SecretVault 解密失败');
    }
  }
}

export const secretVault = new SecretVault();
