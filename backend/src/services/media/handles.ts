import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../paths';
import { redactMediaError } from './redact';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const ROOM_GRANT_TTL_MS = process.env.NODE_ENV === 'test' ? Number(process.env.MEDIA_ROOM_GRANT_TTL_MS) || 12 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
const SECRETS_FILE = path.join(CONFIG_DIR, 'jwt-secrets.json');

export interface MediaHandleResource {
  url: string;
  scope: string;
  headers?: Record<string, string>;
  /** Origins allowed to receive Cookie/Authorization/token-like headers. */
  credentialOrigins?: string[];
  contentType?: string;
  rewriteManifest?: boolean;
  transportMode?: import('./protocol').TransportMode;
  expiresAt: number;
}

export interface RoomMediaGrant {
  kind: 'room-media-grant';
  roomId: string;
  socketId: string;
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
    console.warn('[media-handle] 无法持久化密钥，本次启动使用临时密钥:', redactMediaError(error));
    return randomBytes(32);
  }
}

const key = loadKey();

function seal(resource: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(resource), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  // Reject alternate encodings that differ only in unused padding bits; they
  // otherwise decode to the same bytes and can evade a naive tamper test.
  if (!value || decoded.toString('base64url') !== value) throw new Error('invalid capability encoding');
  return decoded;
}

function open(token: string): unknown {
  try {
    const [ivRaw, tagRaw, encryptedRaw, extra] = token.split('.');
    if (!ivRaw || !tagRaw || !encryptedRaw || extra) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, decodeCanonicalBase64Url(ivRaw));
    decipher.setAuthTag(decodeCanonicalBase64Url(tagRaw));
    const plain = Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(encryptedRaw)),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plain) as unknown;
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

export function resolveMediaHandle(
  token: string,
  viewerId: string,
  roomGrant?: RoomMediaGrant,
): MediaHandleResource | undefined {
  const resource = open(token) as Partial<MediaHandleResource> | undefined;
  if (!resource?.url || !resource.scope || !Number.isFinite(resource.expiresAt)) return undefined;
  if ((resource.expiresAt as number) <= Date.now()) return undefined;
  if (resource.scope.startsWith('user:')) {
    if (resource.scope !== `user:${viewerId}`) return undefined;
  } else if (resource.scope.startsWith('room:')) {
    const roomId = resource.scope.slice('room:'.length);
    if (!roomGrant || roomGrant.roomId !== roomId) return undefined;
  } else return undefined;
  return resource as MediaHandleResource;
}

/**
 * Signed bearer capability delivered only after a socket has joined a room.
 * The gateway additionally checks that socketId still has an active Session,
 * so disconnect/kick revokes access immediately instead of waiting for TTL.
 */
export function issueRoomMediaGrant(roomId: string, socketId: string): string {
  return seal({
    kind: 'room-media-grant',
    roomId,
    socketId,
    expiresAt: Date.now() + ROOM_GRANT_TTL_MS,
  } satisfies RoomMediaGrant);
}

export function resolveRoomMediaGrant(token: string, allowSessionRenewal = false): RoomMediaGrant | undefined {
  const grant = open(token) as Partial<RoomMediaGrant> | undefined;
  if (
    grant?.kind !== 'room-media-grant' ||
    typeof grant.roomId !== 'string' ||
    typeof grant.socketId !== 'string' ||
    !Number.isFinite(grant.expiresAt) ||
    (!allowSessionRenewal && grant.expiresAt! <= Date.now())
  ) return undefined;
  return grant as RoomMediaGrant;
}
