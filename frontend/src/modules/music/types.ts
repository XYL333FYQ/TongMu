export type MusicPlayMode =
  'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle'

export type MusicSyncStatus =
  'idle' | 'loading' | 'ready' | 'reconnecting' | 'error'

export interface MusicQueueItem {
  queueItemId: number
  roomId: string
  sourceRef: string
  title: string
  artist: string
  album: string
  artworkUrl: string | null
  durationMs: number
  orderIndex: number
  createdByUserId: number | null
  createdAt: string
  metadata: Record<string, unknown>
}

export interface MusicPlaybackState {
  currentQueueItemId: number | null
  currentIndex: number
  currentSourceRef: string | null
  isPlaying: boolean
  positionSec: number
  playbackRate: number
  playMode: MusicPlayMode
  musicGeneration: number
  version: number
  serverTimestamp: number
}

export interface MusicHostFacts {
  socketId: string | null
  userId: number | null
  online: boolean
}

export interface MusicSessionFacts {
  roomId: string
  sessionId: string
  socketId: string
  userId: number | null
  role: 'root' | 'admin' | 'user' | 'guest'
}

export interface MusicSnapshot extends MusicPlaybackState {
  roomId: string
  session: MusicSessionFacts
  queue: MusicQueueItem[]
  currentItem: MusicQueueItem | null
  host: MusicHostFacts
  hostOffline: boolean
  state: MusicPlaybackState
}

export interface MusicControlResponse {
  roomId: string
  requestId: string
  accepted: boolean
  reason?: string
  musicGeneration: number
  version: number
  snapshot?: MusicSnapshot
}

export interface MusicControlRequestNotice {
  roomId: string
  requestId: string
  action: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'select'
  positionSec?: number
  queueItemId?: number
  musicGeneration: number
  version: number
  actorSocketId: string
  actorUserId: number | null
  targetHostSocketId: string
  expiresAt: number
}
