import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../paths';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const SECRETS_FILE = path.join(CONFIG_DIR, 'jwt-secrets.json');

export interface MediaHandleResource {
  url: string;
  scope: string;
  headers?: Record<string, string>;
  contentType?: string;
  rewriteManifest?: boolean;
  expiresAt: number;
}

function loadKey(): Buffer {
  const envValue = process.env.MEDIA_HANDLE_SECRET?.trim();
  if (envValue) return createHash('sha256').update(envValue).digest();
  try {
    const existing = fs.existsSync(SECRETS_FILE)
      ? JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Record<string, unknown>
      : {};
    if (typeof existing.mediaHandle === 'string' && existing.mediaHandle.length >= 64) {
      return Buffer.from(existing.mediaHandle, 'hex');
    }
    const generated = randomBytes(32);
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    existing.mediaHandle = generated.toString('hex');
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(existing, null, 2));
    return generated;
  } catch (error) {
    console.warn('[media-handle] 无法持久化密钥，本次启动使用临时密钥:', error);
    return randomBytes(32);
  }
}

const key = loadKey();

function seal(resource: MediaHandleResource): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(resource), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function open(token: string): MediaHandleResource | undefined {
  try {
    const [ivRaw, tagRaw, encryptedRaw, extra] = token.split('.');
    if (!ivRaw || !tagRaw || !encryptedRaw || extra) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const value = JSON.parse(plain) as MediaHandleResource;
    if (!value.url || !value.scope || !Number.isFinite(value.expiresAt)) return undefined;
    return value;
  } catch { return undefined; }
}

/** Authenticated encryption hides upstream URL/credentials and detects token tampering. */
export function issueMediaHandle(
  resource: Omit<MediaHandleResource, 'expiresAt'> & { expiresAt?: number },
): { id: string; expiresAt: number; url: string } {
  const value: MediaHandleResource = {
    ...resource,
    expiresAt: resource.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
  };
  const id = seal(value);
  return { id, expiresAt: value.expiresAt, url: `/api/stream/media/${id}` };
}

export function resolveMediaHandle(token: string, viewerId: string): MediaHandleResource | undefined {
  const resource = open(token);
  if (!resource || resource.expiresAt <= Date.now()) return undefined;
  if (resource.scope.startsWith('user:') && resource.scope !== `user:${viewerId}`) return undefined;
  return resource;
}
