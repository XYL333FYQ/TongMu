import {
  MAX_MUSIC_ALBUM_LENGTH,
  MAX_MUSIC_ARTIST_LENGTH,
  MAX_MUSIC_ARTWORK_URL_LENGTH,
  MAX_MUSIC_DURATION_MS,
  MAX_MUSIC_METADATA_BYTES,
  MAX_MUSIC_METADATA_DEPTH,
  MAX_MUSIC_QUEUE_LENGTH,
  MAX_MUSIC_SOURCE_REF_LENGTH,
  MAX_MUSIC_TITLE_LENGTH,
  MUSIC_HEARTBEAT_MAX_DELTA_MS,
  type MusicPlayMode,
  type MusicQueueItemInput,
} from './types';

export type QueueValidationResult = {
  ok: true;
  value: {
    sourceRef: string;
    title: string;
    artist: string;
    album: string;
    artworkUrl: string | null;
    durationMs: number;
    metadata: Record<string, unknown>;
  };
} | { ok: false; message: string };

function boundedText(value: unknown, maxLength: number, required: boolean): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return null;
  return trimmed.length <= maxLength ? trimmed : null;
}

function hasSecretLikeText(value: string): boolean {
  return /(?:authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|signature|[?&]token=)/i.test(value);
}

function validateMetadata(value: unknown, depth = 0): boolean {
  if (depth > MAX_MUSIC_METADATA_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return !hasSecretLikeText(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => validateMetadata(item, depth + 1));
  if (typeof value !== 'object') return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return false;
  return entries.every(([key, item]) =>
    key.length > 0 && key.length <= 100 && !hasSecretLikeText(key) && validateMetadata(item, depth + 1));
}

export function validateMusicQueueItemInput(input: unknown): QueueValidationResult {
  if (!input || typeof input !== 'object') return { ok: false, message: '歌曲条目格式无效' };
  const candidate = input as MusicQueueItemInput;
  const sourceRef = boundedText(candidate.sourceRef, MAX_MUSIC_SOURCE_REF_LENGTH, true);
  const title = boundedText(candidate.title, MAX_MUSIC_TITLE_LENGTH, true);
  const artist = boundedText(candidate.artist ?? '', MAX_MUSIC_ARTIST_LENGTH, false);
  const album = boundedText(candidate.album ?? '', MAX_MUSIC_ALBUM_LENGTH, false);
  if (!sourceRef || !title || artist === null || album === null) {
    return { ok: false, message: '歌曲引用或文字字段超出限制' };
  }
  if (!/^music:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/[a-zA-Z0-9._~!$'()*+,;=:@%/-]{1,384}$/.test(sourceRef)) {
    return { ok: false, message: '歌曲必须使用受约束的 provider-neutral sourceRef' };
  }
  if (hasSecretLikeText(sourceRef)) return { ok: false, message: 'sourceRef 不能包含凭据或签名' };

  let artworkUrl: string | null = null;
  if (candidate.artworkUrl != null && candidate.artworkUrl !== '') {
    const artwork = boundedText(candidate.artworkUrl, MAX_MUSIC_ARTWORK_URL_LENGTH, true);
    if (!artwork) return { ok: false, message: '封面地址超出限制' };
    try {
      const parsed = new URL(artwork);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || hasSecretLikeText(artwork)) {
        return { ok: false, message: '封面地址不安全' };
      }
      artworkUrl = artwork;
    } catch {
      return { ok: false, message: '封面地址格式无效' };
    }
  }

  const durationMs = candidate.durationMs ?? 0;
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_MUSIC_DURATION_MS) {
    return { ok: false, message: '歌曲时长超出限制' };
  }
  const metadata = candidate.metadata ?? {};
  if (!validateMetadata(metadata)) return { ok: false, message: '歌曲元数据层级或字段过大' };
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return { ok: false, message: '歌曲元数据无法序列化' };
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_MUSIC_METADATA_BYTES) {
    return { ok: false, message: '歌曲元数据过大' };
  }
  return { ok: true, value: { sourceRef, title, artist, album, artworkUrl, durationMs, metadata } };
}

export function isMusicPlayMode(value: unknown): value is MusicPlayMode {
  return value === 'sequential' || value === 'repeat-one' || value === 'repeat-all' || value === 'shuffle';
}

function seedHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable shuffle plan. The seed and item IDs, not array position, define it. */
export function createStableShuffleOrder(queueItemIds: number[], seed: string): number[] {
  const result = [...queueItemIds];
  let state = seedHash(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 16), 2246822519) + 3266489917) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function normalizeShuffleOrder(order: number[], queueItemIds: number[]): number[] {
  const allowed = new Set(queueItemIds);
  const normalized = order.filter((id, index) => allowed.has(id) && order.indexOf(id) === index);
  for (const id of queueItemIds) if (!normalized.includes(id)) normalized.push(id);
  return normalized;
}

export function selectAdjacentQueueItemId(
  queueItemIds: number[],
  currentQueueItemId: number | null,
  mode: MusicPlayMode,
  direction: 1 | -1,
  reason: 'manual' | 'ended',
  shuffleOrder: number[] = queueItemIds,
): number | null {
  if (queueItemIds.length === 0) return null;
  if (mode === 'repeat-one' && reason === 'ended') return currentQueueItemId ?? queueItemIds[0];
  const order = mode === 'shuffle' ? normalizeShuffleOrder(shuffleOrder, queueItemIds) : queueItemIds;
  const currentIndex = currentQueueItemId === null ? -1 : order.indexOf(currentQueueItemId);
  const nextIndex = currentIndex < 0 ? (direction === 1 ? 0 : order.length - 1) : currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < order.length) return order[nextIndex];
  if (mode === 'repeat-all' || mode === 'shuffle') return order[(nextIndex + order.length) % order.length];
  return null;
}

export function advanceMusicPosition(
  positionSec: number,
  isPlaying: boolean,
  playbackRate: number,
  serverTimestamp: number,
  now: number,
): number {
  if (!isPlaying) return Math.max(0, positionSec);
  const deltaMs = Math.min(MUSIC_HEARTBEAT_MAX_DELTA_MS, Math.max(0, now - serverTimestamp));
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 && playbackRate <= 4 ? playbackRate : 1;
  return Math.max(0, positionSec + (deltaMs / 1000) * rate);
}

export function clampMusicPosition(positionSec: number, durationMs: number): number {
  const finite = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  if (!durationMs) return finite;
  return Math.min(finite, durationMs / 1000);
}

export function expectedViewerPosition(
  positionSec: number,
  isPlaying: boolean,
  playbackRate: number,
  serverTimestamp: number,
  now: number,
  networkDelayMs = 0,
): number {
  const boundedDelay = Math.min(MUSIC_HEARTBEAT_MAX_DELTA_MS, Math.max(0, networkDelayMs));
  return advanceMusicPosition(positionSec, isPlaying, playbackRate, serverTimestamp + boundedDelay, now);
}

export function shouldCorrectMusicDrift(localPositionSec: number, expectedPositionSec: number, thresholdSec = 1.5): boolean {
  return Number.isFinite(localPositionSec) && Number.isFinite(expectedPositionSec) &&
    Math.abs(localPositionSec - expectedPositionSec) > Math.max(0.25, thresholdSec);
}

export function isQueueWithinLimit(length: number): boolean {
  return Number.isSafeInteger(length) && length >= 0 && length <= MAX_MUSIC_QUEUE_LENGTH;
}
