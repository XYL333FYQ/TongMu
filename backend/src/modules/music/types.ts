import type { DomainMutationEnvelope } from '../realtime-sync-core';

export type MusicPlayMode = 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle';

export const MUSIC_DOMAIN = 'music' as const;
export const MAX_MUSIC_QUEUE_LENGTH = 200;
export const MAX_MUSIC_SOURCE_REF_LENGTH = 512;
export const MAX_MUSIC_TITLE_LENGTH = 200;
export const MAX_MUSIC_ARTIST_LENGTH = 200;
export const MAX_MUSIC_ALBUM_LENGTH = 200;
export const MAX_MUSIC_ARTWORK_URL_LENGTH = 2048;
export const MAX_MUSIC_METADATA_BYTES = 16 * 1024;
export const MAX_MUSIC_METADATA_DEPTH = 4;
export const MAX_MUSIC_DURATION_MS = 24 * 60 * 60 * 1000;
export const MUSIC_CONTROL_REQUEST_TTL_MS = 30_000;
export const MUSIC_TRACK_ACK_TTL_MS = 30_000;
export const MUSIC_HEARTBEAT_MAX_DELTA_MS = 30_000;
export const MUSIC_MAX_PENDING_CONTROL_REQUESTS = 256;
export const MUSIC_MAX_PENDING_TRACK_ACKS = 512;

export interface MusicQueueItemInput {
  sourceRef: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string | null;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MusicQueueItemPayload {
  queueItemId: number;
  roomId: string;
  sourceRef: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  durationMs: number;
  orderIndex: number;
  createdByUserId: number | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface MusicPlaybackState {
  currentQueueItemId: number | null;
  currentIndex: number;
  currentSourceRef: string | null;
  isPlaying: boolean;
  positionSec: number;
  playbackRate: number;
  playMode: MusicPlayMode;
  musicGeneration: number;
  version: number;
  serverTimestamp: number;
}

export interface MusicHostFacts {
  socketId: string | null;
  userId: number | null;
  online: boolean;
}

export interface MusicSessionFacts {
  roomId: string;
  sessionId: string;
  socketId: string;
  userId: number | null;
  role: 'root' | 'admin' | 'user' | 'guest';
}

export interface MusicSnapshot extends MusicPlaybackState {
  roomId: string;
  session: MusicSessionFacts;
  queue: MusicQueueItemPayload[];
  currentItem: MusicQueueItemPayload | null;
  host: MusicHostFacts;
  hostOffline: boolean;
  /** Explicit nested state makes the domain boundary obvious to clients. */
  state: MusicPlaybackState;
}

export type MusicMutationEnvelope = DomainMutationEnvelope;

export type MusicControlAction = 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'select';

export interface MusicControlRequestPayload {
  roomId: string;
  requestId?: string;
  action: MusicControlAction;
  positionSec?: number;
  queueItemId?: number;
  musicGeneration: number;
  version: number;
  clientTimestamp?: number;
}

export interface MusicControlRequestNotice extends MusicControlRequestPayload {
  requestId: string;
  actorSocketId: string;
  actorUserId: number | null;
  targetHostSocketId: string;
  expiresAt: number;
}

export interface MusicControlResponsePayload {
  roomId: string;
  requestId: string;
  accepted: boolean;
  reason?: string;
  musicGeneration: number;
  version: number;
}

export interface MusicTrackAckPayload {
  roomId: string;
  requestId?: string;
  queueItemId: number | null;
  musicGeneration: number;
  version: number;
  ready: boolean;
}

export interface MusicHeartbeatPayload {
  roomId: string;
  queueItemId: number | null;
  musicGeneration: number;
  positionSec: number;
  isPlaying: boolean;
  playbackRate?: number;
  baseVersion: number;
  clientTimestamp?: number;
}
