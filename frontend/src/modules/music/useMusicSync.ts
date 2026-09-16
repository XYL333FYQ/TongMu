import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { MusicAudioLifecycle } from './audio-lifecycle'
import { expectedMusicPosition, shouldCorrectMusicDrift } from './domain'
import { isMusicSnapshot, shouldApplyMusicEvent } from './realtime-version'
import { useMusicStore } from './store'
import { isMusicQuality, resolveMusicSourceDetailed } from './source-resolver'
import type {
  MusicControlRequestNotice,
  MusicControlResponse,
  MusicPlayMode,
  MusicSnapshot,
} from './types'

interface SocketAck {
  success?: boolean
  code?: string
  message?: string
  data?: unknown
}

export interface UseMusicSyncOptions {
  roomId: string
  isHost: boolean
  audioRef: RefObject<HTMLAudioElement>
}

function clientId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `music-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function errorMessage(ack: SocketAck): string {
  return ack.message || ack.code || '音乐操作失败'
}

function snapshotFromAck(ack: SocketAck): MusicSnapshot | null {
  return ack.success && isMusicSnapshot(ack.data) ? ack.data : null
}

export function useMusicSync({
  roomId,
  isHost,
  audioRef,
}: UseMusicSyncOptions) {
  const { socket, connected } = useSocket()
  const store = useMusicStore()
  const lifecycleRef = useRef<MusicAudioLifecycle | null>(null)
  const attachedSourceRef = useRef<string | null>(null)
  const attachedGenerationRef = useRef<number | null>(null)
  const resolveEpochRef = useRef(0)
  const snapshotInitializedRef = useRef(false)
  const ackedTrackRef = useRef<string | null>(null)

  const setError = useCallback((message: string | null) => {
    useMusicStore.getState().setError(message)
  }, [])

  const applySnapshot = useCallback(
    (value: unknown, force = false) => {
      if (!isMusicSnapshot(value) || value.roomId !== roomId) return false
      const current = useMusicStore.getState()
      const acceptAsFirst =
        force || !snapshotInitializedRef.current || current.roomId !== roomId
      const applied = useMusicStore
        .getState()
        .applySnapshot(value, acceptAsFirst)
      if (applied) snapshotInitializedRef.current = true
      return applied
    },
    [roomId]
  )

  const requestSnapshot = useCallback(() => {
    if (!socket || !roomId) return
    snapshotInitializedRef.current = false
    useMusicStore.getState().setStatus('loading')
    socket.emit('music:get-state', { roomId }, (ack: SocketAck) => {
      const snapshot = snapshotFromAck(ack)
      if (snapshot) {
        applySnapshot(snapshot, true)
      } else if (!ack.success) {
        setError(errorMessage(ack))
      }
    })
  }, [applySnapshot, roomId, setError, socket])

  useEffect(() => {
    useMusicStore.getState().reset(roomId)
    lifecycleRef.current?.unload()
    lifecycleRef.current = null
    attachedSourceRef.current = null
    attachedGenerationRef.current = null
    resolveEpochRef.current += 1
    snapshotInitializedRef.current = false
  }, [roomId])

  useEffect(() => {
    useMusicStore.getState().setConnection(connected)
    if (connected) requestSnapshot()
    else useMusicStore.getState().setStatus('reconnecting')
  }, [connected, requestSnapshot])

  useEffect(() => {
    if (!socket || !roomId) return

    const onSnapshot = (value: unknown) => applySnapshot(value)
    const onState = (value: unknown) => applySnapshot(value)
    const onHeartbeat = (value: unknown) => {
      if (!isMusicSnapshot(value) || value.roomId !== roomId) return
      const current = useMusicStore.getState()
      if (
        !shouldApplyMusicEvent(current, value) &&
        current.musicGeneration !== value.musicGeneration
      )
        return
      const applied = useMusicStore.getState().applyHeartbeat(value)
      const audio = audioRef.current
      if (
        !applied ||
        !audio ||
        current.musicGeneration !== value.musicGeneration
      )
        return
      const expected = expectedMusicPosition(
        value.positionSec,
        value.isPlaying,
        value.playbackRate,
        value.serverTimestamp,
        Date.now()
      )
      if (shouldCorrectMusicDrift(audio.currentTime, expected))
        audio.currentTime = expected
    }
    const onControlResponse = (value: unknown) => {
      const response = value as Partial<MusicControlResponse>
      if (typeof response.requestId !== 'string') return
      useMusicStore.getState().resolvePendingRequest(response.requestId)
      if (response.accepted && response.snapshot)
        applySnapshot(response.snapshot)
      if (response.accepted === false && response.reason)
        setError(response.reason)
    }
    const onControlRequest = (value: unknown) => {
      const request = value as Partial<MusicControlRequestNotice>
      if (
        !isHost ||
        request.roomId !== roomId ||
        typeof request.requestId !== 'string' ||
        typeof request.action !== 'string' ||
        typeof request.musicGeneration !== 'number' ||
        typeof request.version !== 'number' ||
        typeof request.expiresAt !== 'number'
      )
        return
      useMusicStore
        .getState()
        .addHostRequest(request as MusicControlRequestNotice)
    }
    const onConnect = () => requestSnapshot()
    const onDisconnect = () =>
      useMusicStore.getState().setStatus('reconnecting')

    socket.on('music:snapshot', onSnapshot)
    socket.on('music:state', onState)
    socket.on('music:sync-state', onState)
    socket.on('music:track-switch', onState)
    socket.on('music:heartbeat', onHeartbeat)
    socket.on('music:control-response', onControlResponse)
    socket.on('music:control-request', onControlRequest)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    if (socket.connected) requestSnapshot()
    return () => {
      socket.off('music:snapshot', onSnapshot)
      socket.off('music:state', onState)
      socket.off('music:sync-state', onState)
      socket.off('music:track-switch', onState)
      socket.off('music:heartbeat', onHeartbeat)
      socket.off('music:control-response', onControlResponse)
      socket.off('music:control-request', onControlRequest)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [
    applySnapshot,
    audioRef,
    isHost,
    requestSnapshot,
    roomId,
    setError,
    socket,
  ])

  const sendTrackAck = useCallback(
    (ready: boolean) => {
      if (!socket || !roomId) return
      const current = useMusicStore.getState()
      const key = `${current.musicGeneration}:${current.currentQueueItemId}:${ready}`
      if (ready && ackedTrackRef.current === key) return
      if (ready) ackedTrackRef.current = key
      socket.emit(
        'music:track-ack',
        {
          roomId,
          queueItemId: current.currentQueueItemId,
          musicGeneration: current.musicGeneration,
          version: current.version,
          ready,
        },
        (ack: SocketAck) => {
          if (!ack.success && ready) setError(errorMessage(ack))
        }
      )
    },
    [roomId, setError, socket]
  )

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!lifecycleRef.current)
      lifecycleRef.current = new MusicAudioLifecycle(audio)
    const lifecycle = lifecycleRef.current
    const state = useMusicStore.getState()
    const sourceRef = state.currentSourceRef
    const generation = state.musicGeneration
    const resolveEpoch = ++resolveEpochRef.current
    let cancelled = false
    if (!sourceRef) {
      lifecycle.unload()
      attachedSourceRef.current = null
      attachedGenerationRef.current = null
      return () => {
        cancelled = true
      }
    }
    if (
      attachedSourceRef.current === sourceRef &&
      attachedGenerationRef.current === generation
    )
      return
    lifecycle.unload()
    attachedSourceRef.current = null
    attachedGenerationRef.current = null
    const requestedQuality = isMusicQuality(
      state.currentItem?.metadata?.requestedQuality
    )
      ? state.currentItem?.metadata?.requestedQuality
      : undefined
    void resolveMusicSourceDetailed(sourceRef, {
      roomId,
      queueItemId: state.currentQueueItemId || 0,
      musicGeneration: generation,
      requestedQuality,
    }).then((resolution) => {
      if (cancelled || resolveEpochRef.current !== resolveEpoch) return
      const sourceUrl = resolution.url
      if (!sourceUrl) {
        setError(resolution.message || '当前音乐来源无法解析')
        return
      }
      if (
        /^music:\/\/ncm\//.test(sourceRef) &&
        resolution.mimeType &&
        audio.canPlayType(resolution.mimeType) === ''
      ) {
        setError(
          `浏览器不支持当前音频编码（${resolution.mimeType}），未自动降低音质`
        )
        return
      }
      attachedSourceRef.current = sourceRef
      attachedGenerationRef.current = generation
      ackedTrackRef.current = null
      lifecycle.attach(sourceUrl, generation, {
        onReady: () => {
          const current = useMusicStore.getState()
          if (
            current.musicGeneration !== generation ||
            current.currentSourceRef !== sourceRef
          )
            return
          audio.currentTime = Math.max(0, current.positionSec)
          sendTrackAck(true)
        },
        onError: () => setError('音乐加载失败，请检查当前 gateway 或音频编码'),
        onEnded: () => {
          if (!isHost || !socket) return
          const current = useMusicStore.getState()
          if (
            current.musicGeneration !== generation ||
            current.currentSourceRef !== sourceRef
          )
            return
          socket.emit('music:ended', {
            roomId,
            queueItemId: current.currentQueueItemId,
            musicGeneration: current.musicGeneration,
            baseVersion: current.version,
            mutationId: clientId(),
          })
        },
      })
    })
    return () => {
      cancelled = true
    }
  }, [
    audioRef,
    isHost,
    roomId,
    sendTrackAck,
    setError,
    socket,
    store.currentSourceRef,
    store.musicGeneration,
  ])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const lifecycle = lifecycleRef.current
    if (!lifecycle || lifecycle.generation !== store.musicGeneration) return
    audio.playbackRate = store.playbackRate
    if (!store.isPlaying) {
      audio.pause()
      return
    }
    void audio
      .play()
      .catch(() => setError('浏览器阻止了自动播放，请点击播放按钮'))
  }, [
    audioRef,
    setError,
    store.isPlaying,
    store.musicGeneration,
    store.playbackRate,
  ])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTimeUpdate = () =>
      useMusicStore.getState().setLocalPosition(audio.currentTime)
    audio.addEventListener('timeupdate', onTimeUpdate)
    return () => audio.removeEventListener('timeupdate', onTimeUpdate)
  }, [audioRef, roomId])

  useEffect(() => {
    if (!isHost || !socket || !roomId) return
    const timer = window.setInterval(() => {
      if (!socket.connected) return
      const current = useMusicStore.getState()
      const audio = audioRef.current
      socket.emit('music:heartbeat', {
        roomId,
        queueItemId: current.currentQueueItemId,
        musicGeneration: current.musicGeneration,
        positionSec:
          audio && Number.isFinite(audio.currentTime)
            ? audio.currentTime
            : current.positionSec,
        isPlaying: Boolean(
          audio && !audio.paused && current.currentQueueItemId !== null
        ),
        playbackRate: audio?.playbackRate ?? current.playbackRate,
        baseVersion: current.version,
        clientTimestamp: Date.now(),
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [audioRef, isHost, roomId, socket])

  useEffect(
    () => () => {
      lifecycleRef.current?.unload()
      lifecycleRef.current = null
    },
    []
  )

  const emitHostMutation = useCallback(
    (event: string, payload: Record<string, unknown> = {}) => {
      if (!socket || !roomId || !isHost) return false
      const current = useMusicStore.getState()
      socket.emit(
        event,
        {
          roomId,
          ...payload,
          baseVersion: current.version,
          musicGeneration: current.musicGeneration,
          mutationId: clientId(),
          clientTimestamp: Date.now(),
        },
        (ack: SocketAck) => {
          if (!ack.success) setError(errorMessage(ack))
          else if (ack.data) applySnapshot(ack.data)
        }
      )
      return true
    },
    [applySnapshot, isHost, roomId, setError, socket]
  )

  const requestControl = useCallback(
    (
      action: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'select',
      payload: Record<string, unknown> = {}
    ) => {
      if (!socket || !roomId || isHost) return false
      const current = useMusicStore.getState()
      const requestId = clientId()
      useMusicStore.getState().addPendingRequest(requestId)
      socket.emit(
        'music:control-request',
        {
          roomId,
          ...payload,
          action,
          requestId,
          baseVersion: current.version,
          musicGeneration: current.musicGeneration,
          mutationId: requestId,
          clientTimestamp: Date.now(),
        },
        (ack: SocketAck) => {
          if (!ack.success) {
            useMusicStore.getState().resolvePendingRequest(requestId)
            setError(errorMessage(ack))
            return
          }
          const data = ack.data as { requestId?: unknown } | undefined
          if (typeof data?.requestId === 'string') {
            useMusicStore.getState().resolvePendingRequest(requestId)
            useMusicStore.getState().addPendingRequest(data.requestId)
          }
        }
      )
      return true
    },
    [isHost, roomId, setError, socket]
  )

  const respondControl = useCallback(
    (requestId: string, accepted: boolean) => {
      if (!socket || !roomId || !isHost) return false
      const current = useMusicStore.getState()
      useMusicStore.getState().removeHostRequest(requestId)
      socket.emit(
        'music:control-response',
        {
          roomId,
          requestId,
          accepted,
          musicGeneration: current.musicGeneration,
          version: current.version,
          reason: accepted ? undefined : '房主拒绝了控制申请',
        },
        (ack: SocketAck) => {
          if (!ack.success) setError(errorMessage(ack))
        }
      )
      return true
    },
    [isHost, roomId, setError, socket]
  )

  const play = useCallback(() => {
    const audio = audioRef.current
    if (isHost) {
      if (audio)
        void audio.play().catch(() => setError('浏览器阻止了播放，请再次点击'))
      return emitHostMutation(store.isPlaying ? 'music:pause' : 'music:play')
    }
    return requestControl(store.isPlaying ? 'pause' : 'play')
  }, [
    audioRef,
    emitHostMutation,
    isHost,
    requestControl,
    setError,
    store.isPlaying,
  ])

  const seek = useCallback(
    (positionSec: number) => {
      if (!Number.isFinite(positionSec)) return false
      if (isHost) {
        if (audioRef.current)
          audioRef.current.currentTime = Math.max(0, positionSec)
        return emitHostMutation('music:seek', { positionSec })
      }
      return requestControl('seek', { positionSec })
    },
    [audioRef, emitHostMutation, isHost, requestControl]
  )

  const next = useCallback(
    () => (isHost ? emitHostMutation('music:next') : requestControl('next')),
    [emitHostMutation, isHost, requestControl]
  )
  const previous = useCallback(
    () =>
      isHost ? emitHostMutation('music:previous') : requestControl('previous'),
    [emitHostMutation, isHost, requestControl]
  )
  const select = useCallback(
    (queueItemId: number) =>
      isHost
        ? emitHostMutation('music:queue-select', { queueItemId })
        : requestControl('select', { queueItemId }),
    [emitHostMutation, isHost, requestControl]
  )
  const setMode = useCallback(
    (playMode: MusicPlayMode) =>
      isHost ? emitHostMutation('music:mode-change', { playMode }) : false,
    [emitHostMutation, isHost]
  )
  const addFixture = useCallback(
    (item: {
      sourceRef: string
      title: string
      artist?: string
      durationMs?: number
    }) => (isHost ? emitHostMutation('music:queue-add', { item }) : false),
    [emitHostMutation, isHost]
  )
  const remove = useCallback(
    (queueItemId: number) =>
      isHost ? emitHostMutation('music:queue-remove', { queueItemId }) : false,
    [emitHostMutation, isHost]
  )
  const reorder = useCallback(
    (queueItemIds: number[]) =>
      isHost
        ? emitHostMutation('music:queue-reorder', { queueItemIds })
        : false,
    [emitHostMutation, isHost]
  )

  return {
    state: store,
    play,
    seek,
    next,
    previous,
    select,
    setMode,
    addFixture,
    remove,
    reorder,
    requestControl,
    respondControl,
  }
}
