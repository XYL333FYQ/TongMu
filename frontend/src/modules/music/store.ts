import { create } from 'zustand'
import {
  shouldApplyMusicHeartbeat,
  shouldApplyMusicSnapshot,
} from './realtime-version'
import type {
  MusicControlRequestNotice,
  MusicHostFacts,
  MusicPlaybackState,
  MusicQueueItem,
  MusicSnapshot,
  MusicSyncStatus,
} from './types'

export interface MusicStoreState extends MusicPlaybackState {
  roomId: string | null
  sessionId: string | null
  queue: MusicQueueItem[]
  currentItem: MusicQueueItem | null
  host: MusicHostFacts
  hostOffline: boolean
  status: MusicSyncStatus
  connected: boolean
  error: string | null
  pendingControlRequests: string[]
  pendingHostRequests: MusicControlRequestNotice[]
  reset: (roomId?: string | null) => void
  setConnection: (connected: boolean) => void
  setStatus: (status: MusicSyncStatus) => void
  setError: (error: string | null) => void
  applySnapshot: (snapshot: MusicSnapshot, force?: boolean) => boolean
  applyHeartbeat: (snapshot: MusicSnapshot) => boolean
  setLocalPosition: (positionSec: number) => void
  addPendingRequest: (requestId: string) => void
  resolvePendingRequest: (requestId: string) => void
  addHostRequest: (request: MusicControlRequestNotice) => void
  removeHostRequest: (requestId: string) => void
}

const emptyHost: MusicHostFacts = {
  socketId: null,
  userId: null,
  online: false,
}

function snapshotValues(snapshot: MusicSnapshot): Partial<MusicStoreState> {
  return {
    roomId: snapshot.roomId,
    sessionId: snapshot.session.sessionId,
    queue: snapshot.queue,
    currentItem: snapshot.currentItem,
    currentQueueItemId: snapshot.currentQueueItemId,
    currentIndex: snapshot.currentIndex,
    currentSourceRef: snapshot.currentSourceRef,
    isPlaying: snapshot.isPlaying,
    positionSec: snapshot.positionSec,
    playbackRate: snapshot.playbackRate,
    playMode: snapshot.playMode,
    musicGeneration: snapshot.musicGeneration,
    version: snapshot.version,
    serverTimestamp: snapshot.serverTimestamp,
    host: snapshot.host,
    hostOffline: snapshot.hostOffline,
    status: 'ready',
    error: null,
  }
}

export const useMusicStore = create<MusicStoreState>()((set, get) => ({
  roomId: null,
  sessionId: null,
  queue: [],
  currentItem: null,
  currentQueueItemId: null,
  currentIndex: -1,
  currentSourceRef: null,
  isPlaying: false,
  positionSec: 0,
  playbackRate: 1,
  playMode: 'sequential',
  musicGeneration: 0,
  version: 0,
  serverTimestamp: 0,
  host: emptyHost,
  hostOffline: true,
  status: 'idle',
  connected: false,
  error: null,
  pendingControlRequests: [],
  pendingHostRequests: [],
  reset: (roomId = null) =>
    set({
      roomId,
      sessionId: null,
      queue: [],
      currentItem: null,
      currentQueueItemId: null,
      currentIndex: -1,
      currentSourceRef: null,
      isPlaying: false,
      positionSec: 0,
      playbackRate: 1,
      playMode: 'sequential',
      musicGeneration: 0,
      version: 0,
      serverTimestamp: 0,
      host: emptyHost,
      hostOffline: true,
      status: roomId ? 'loading' : 'idle',
      connected: get().connected,
      error: null,
      pendingControlRequests: [],
      pendingHostRequests: [],
    }),
  setConnection: (connected) => set({ connected }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: error ? 'error' : get().status }),
  applySnapshot: (snapshot, force = false) => {
    const current = get()
    if (
      !force &&
      current.roomId === snapshot.roomId &&
      !shouldApplyMusicSnapshot(current, snapshot)
    )
      return false
    set({
      ...snapshotValues(snapshot),
      pendingControlRequests: force ? [] : current.pendingControlRequests,
      pendingHostRequests: force ? [] : current.pendingHostRequests,
    })
    return true
  },
  applyHeartbeat: (snapshot) => {
    const current = get()
    if (
      current.roomId !== snapshot.roomId ||
      !shouldApplyMusicHeartbeat(current, snapshot)
    )
      return false
    set({
      ...snapshotValues(snapshot),
      pendingControlRequests: current.pendingControlRequests,
      pendingHostRequests: current.pendingHostRequests,
    })
    return true
  },
  setLocalPosition: (positionSec) => {
    if (!Number.isFinite(positionSec)) return
    set({ positionSec: Math.max(0, positionSec) })
  },
  addPendingRequest: (requestId) =>
    set((state) => ({
      pendingControlRequests: state.pendingControlRequests.includes(requestId)
        ? state.pendingControlRequests
        : [...state.pendingControlRequests, requestId].slice(-32),
    })),
  resolvePendingRequest: (requestId) =>
    set((state) => ({
      pendingControlRequests: state.pendingControlRequests.filter(
        (id) => id !== requestId
      ),
    })),
  addHostRequest: (request) =>
    set((state) => ({
      pendingHostRequests: state.pendingHostRequests.some(
        (entry) => entry.requestId === request.requestId
      )
        ? state.pendingHostRequests
        : [...state.pendingHostRequests, request].slice(-16),
    })),
  removeHostRequest: (requestId) =>
    set((state) => ({
      pendingHostRequests: state.pendingHostRequests.filter(
        (request) => request.requestId !== requestId
      ),
    })),
}))
