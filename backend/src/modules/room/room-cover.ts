import { parseRoomPolicy } from './room-policy';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOM_COVERS_DIR } from '../../services/paths';

// Covers are server-owned presentation metadata in the existing room JSON.
// They do not change the database schema or expose a private media source.
const COVER_URL = /^\/uploads\/room-covers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export function getRoomCover(raw: string | null | undefined): string | null {
  try {
    const value: unknown = JSON.parse(raw || '{}').coverUrl;
    return typeof value === 'string' && COVER_URL.test(value) ? value : null;
  } catch { return null; }
}

export function withRoomCover(raw: string | null | undefined, coverUrl: string | null): string {
  return JSON.stringify({ ...parseRoomPolicy(raw), coverUrl });
}

export async function removeStoredRoomCover(url: string | null): Promise<void> {
  if (!url || !COVER_URL.test(url)) return;
  await fs.unlink(path.join(ROOM_COVERS_DIR, path.basename(url))).catch(() => undefined);
}

export function roomCoverExtension(buffer: Buffer, mime: string): 'png' | 'jpg' | 'webp' | null {
  if (mime === 'image/png' && buffer.length >= 33 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (mime === 'image/jpeg' && buffer.length >= 12 && buffer[0] === 255 &&
    buffer[1] === 216 && buffer[2] === 255 && buffer[buffer.length - 2] === 255 &&
    buffer[buffer.length - 1] === 217) return 'jpg';
  if (mime === 'image/webp' && buffer.length >= 20 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 === buffer.length) return 'webp';
  return null;
}
