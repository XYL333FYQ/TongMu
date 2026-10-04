import { t, useTranslation } from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { englishErrorMessage } from '@/lib/errorMessage'
import {
  MusicAudioLifecycle,
  classifyMusicPlaybackError,
} from './audio-lifecycle'
import {
  ROOM_MEDIA_TEARDOWN_EVENT,
  type RoomMediaTeardownDetail,
} from '@/lib/mediaTeardown'
import { expectedMusicPosition, shouldCorrectMusicDrift } from './domain'
import { isMusicSnapshot, shouldApplyMusicEvent } from './realtime-version'
import { useMusicStore } from './store'
import {
  isMusicQuality,
  resolveMusicSourceDetailed,
  type MusicQualityFacts,
} from './source-resolver'
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
  const codes: Record<string, string> = {
    MUSIC_HOST_ONLY: 'Ask the host to control music playback.',
    MUSIC_ROOM_FORBIDDEN:
      'Return to the room to reconnect before controlling music.',
    MUSIC_STALE_STATE:
      'Music has changed. Wait for the latest state and try again.',
    MUSIC_INVALID_REQUEST:
      'This music action is unavailable. Check the selected track and try again.',
    MUSIC_NOT_FOUND: 'This track is no longer in the queue.',
  }
  return (
    (ack.code && codes[ack.code]) ||
    englishErrorMessage(
      ack.message,
      t(
        'Unable to complete this music action. Check your room permissions and try again.'
      )
    )
  )
}

function snapshotFromAck(ack: SocketAck): MusicSnapshot | null {
  return ack.success && isMusicSnapshot(ack.data) ? ack.data : null
}

export function useMusicSync({
  roomId,
  isHost: hostFallback,
  audioRef,
}: UseMusicSyncOptions) {
  useTranslation()

  const { socket, connected } = useSocket()
  const snapshot = useRoomExperienceStore((s) => s.snapshot)
  const experience = snapshot?.roomId === roomId ? snapshot : null
  const isHost = experience
    ? experience.host.socketId === socket?.id
    : hostFallback
  const canControl = experience?.permissions.playback ?? isHost
  const canSelect = experience?.permissions.selectContent ?? isHost
  const active = !experience || experience.activity === 'listen'
  const store = useMusicStore()
  const lifecycleRef = useRef<MusicAudioLifecycle | null>(null)
  const attachedSourceRef = useRef<string | null>(null)
  const attachedGenerationRef = useRef<number | null>(null)
  const resumeAfterSocketReconnectRef = useRef(false)
  const resolveEpochRef = useRef(0)
  const pendingResolveEpochRef = useRef<number | null>(null)
  const snapshotInitializedRef = useRef(false)
  const ackedTrackRef = useRef<string | null>(null)
  const [resolutionAttempt, setResolutionAttempt] = useState(0)
  const [qualityFactsState, setQualityFacts] = useState<{
    sourceRef: string
    generation: number
    facts: MusicQualityFacts
  } | null>(null)
  const qualityFacts =
    qualityFactsState?.sourceRef === store.currentSourceRef &&
    qualityFactsState.generation === store.musicGeneration
      ? qualityFactsState.facts
      : null

  const setError = useCallback((message: string | null) => {
    useMusicStore.getState().setError(message)
  }, [])

  const setPlaybackError = useCallback(
    (error: unknown) => {
      const kind = classifyMusicPlaybackError(error)
      if (kind === 'aborted') return
      if (kind === 'blocked') {
        setError(t('Your browser blocked autoplay. Press Play to continue.'))
      } else if (!useMusicStore.getState().error) {
        setError(
          t(
            'Unable to load this track. Check the media connection or choose a supported audio format.'
          )
        )
      }
    },
    [setError]
  )

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
      if (response.accepted && response.snapshot) {
        setError(null)
        applySnapshot(response.snapshot)
      }
      if (response.accepted === false && response.reason)
        setError(
          englishErrorMessage(
            response.reason,
            t('The host declined your control request.')
          )
        )
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
    setError(null)
    const requestedQuality = isMusicQuality(
      state.currentItem?.metadata?.requestedQuality
    )
      ? state.currentItem?.metadata?.requestedQuality
      : undefined
    pendingResolveEpochRef.current = resolveEpoch
    void resolveMusicSourceDetailed(sourceRef, {
      roomId,
      queueItemId: state.currentQueueItemId || 0,
      musicGeneration: generation,
      requestedQuality,
    })
      .then((resolution) => {
        if (cancelled || resolveEpochRef.current !== resolveEpoch) return
        const sourceUrl = resolution.url
        if (!sourceUrl) {
          const available = resolution.availableQualities?.length
            ? t(' Available qualities: {qualities}.', {
                qualities: resolution.availableQualities.join(', '),
              })
            : ''
          setError(
            `${englishErrorMessage(resolution.message, t('This music source could not be opened.'))}${available}`
          )
          return
        }
        if (/^music:\/\/ncm\//.test(sourceRef)) {
          setQualityFacts({
            sourceRef,
            generation,
            facts: {
              requestedQuality:
                resolution.requestedQuality || requestedQuality || 'exhigh',
              actualQuality: resolution.actualQuality ?? null,
              availableQualities: resolution.availableQualities || [],
              availableMaximum: resolution.availableMaximum ?? null,
            },
          })
        }
        if (
          /^music:\/\/ncm\//.test(sourceRef) &&
          resolution.mimeType &&
          audio.canPlayType(resolution.mimeType) === ''
        ) {
          setError(
            t(
              'Your browser does not support this audio format ({value1}). Choose another supported quality; the quality has not been reduced automatically.',
              { value1: resolution.mimeType }
            )
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
            if (active && current.isPlaying)
              void audio.play().catch(setPlaybackError)
          },
          onError: () =>
            setError(
              t(
                'Unable to load this track. Check the media connection or choose a supported audio format.'
              )
            ),
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
      .finally(() => {
        if (pendingResolveEpochRef.current === resolveEpoch)
          pendingResolveEpochRef.current = null
      })
    return () => {
      cancelled = true
      if (pendingResolveEpochRef.current === resolveEpoch)
        pendingResolveEpochRef.current = null
    }
  }, [
    active,
    audioRef,
    isHost,
    roomId,
    resolutionAttempt,
    sendTrackAck,
    setError,
    setPlaybackError,
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
    if (!active || !store.isPlaying) {
      audio.pause()
      return
    }
    void audio.play().catch(setPlaybackError)
  }, [
    active,
    audioRef,
    setPlaybackError,
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
    if (!active || !isHost || !socket || !roomId) return
    const timer = window.setInterval(() => {
      if (!socket.connected) return
      const current = useMusicStore.getState()
      const audio = audioRef.current
      const hasCurrentAudio = Boolean(
        audio &&
        lifecycleRef.current?.generation === current.musicGeneration &&
        audio.readyState >= 2
      )
      socket.emit('music:heartbeat', {
        roomId,
        queueItemId: current.currentQueueItemId,
        musicGeneration: current.musicGeneration,
        positionSec:
          hasCurrentAudio && audio && Number.isFinite(audio.currentTime)
            ? audio.currentTime
            : current.positionSec,
        // A pending source is paused by default. It must not overwrite the
        // host's Play command before the first audio data arrives.
        isPlaying: hasCurrentAudio
          ? Boolean(
              audio && !audio.paused && current.currentQueueItemId !== null
            )
          : current.isPlaying,
        playbackRate: audio?.playbackRate ?? current.playbackRate,
        baseVersion: current.version,
        clientTimestamp: Date.now(),
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [active, audioRef, isHost, roomId, socket])

  useEffect(
    () => () => {
      lifecycleRef.current?.unload()
      lifecycleRef.current = null
    },
    []
  )

  useEffect(() => {
    const handleTeardown = (event: Event) => {
      const detail = (event as CustomEvent<RoomMediaTeardownDetail>).detail
      const full = detail?.full ?? true
      if (full) {
        resumeAfterSocketReconnectRef.current = false
        lifecycleRef.current?.unload()
        attachedSourceRef.current = null
        attachedGenerationRef.current = null
      } else {
        const audio = audioRef.current
        resumeAfterSocketReconnectRef.current = Boolean(
          audio && (!audio.paused || useMusicStore.getState().isPlaying)
        )
        audio?.pause()
      }
    }
    window.addEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
    return () =>
      window.removeEventListener(ROOM_MEDIA_TEARDOWN_EVENT, handleTeardown)
  }, [audioRef])

  useEffect(() => {
    if (!socket) return
    const handleReconnect = () => {
      if (!resumeAfterSocketReconnectRef.current) return
      resumeAfterSocketReconnectRef.current = false
      const audio = audioRef.current
      if (!audio || !useMusicStore.getState().isPlaying) return
      void audio.play().catch(setPlaybackError)
    }
    socket.on('connect', handleReconnect)
    return () => {
      socket.off('connect', handleReconnect)
    }
  }, [audioRef, setPlaybackError, socket])

  const emitHostMutation = useCallback(
    (event: string, payload: Record<string, unknown> = {}) => {
      const permitted =
        event.includes('queue') || event === 'music:track-select'
          ? canSelect
          : canControl
      if (!socket || !roomId || !permitted || !active) return false
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
    [active, applySnapshot, canControl, canSelect, roomId, setError, socket]
  )

  const requestControl = useCallback(
    (
      action: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'select',
      payload: Record<string, unknown> = {}
    ) => {
      if (!socket || !roomId || isHost) return false
      setError(null)
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
          reason: accepted
            ? undefined
            : 'The host declined your control request.',
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
    if (canControl) {
      if (store.isPlaying) return emitHostMutation('music:pause')
      if (audio?.getAttribute('src') && !audio.error)
        void audio.play().catch(setPlaybackError)
      else if (pendingResolveEpochRef.current === null) {
        attachedSourceRef.current = null
        attachedGenerationRef.current = null
        setResolutionAttempt((attempt) => attempt + 1)
      }
      return emitHostMutation('music:play')
    }
    return requestControl(store.isPlaying ? 'pause' : 'play')
  }, [
    audioRef,
    emitHostMutation,
    canControl,
    requestControl,
    setPlaybackError,
    store.isPlaying,
  ])

  const seek = useCallback(
    (positionSec: number) => {
      if (!Number.isFinite(positionSec)) return false
      if (canControl) {
        if (audioRef.current)
          audioRef.current.currentTime = Math.max(0, positionSec)
        return emitHostMutation('music:seek', { positionSec })
      }
      return requestControl('seek', { positionSec })
    },
    [audioRef, emitHostMutation, canControl, requestControl]
  )

  const next = useCallback(
    () =>
      canControl ? emitHostMutation('music:next') : requestControl('next'),
    [emitHostMutation, canControl, requestControl]
  )
  const previous = useCallback(
    () =>
      canControl
        ? emitHostMutation('music:previous')
        : requestControl('previous'),
    [emitHostMutation, canControl, requestControl]
  )
  const select = useCallback(
    (queueItemId: number) =>
      canSelect
        ? emitHostMutation('music:queue-select', { queueItemId })
        : requestControl('select', { queueItemId }),
    [emitHostMutation, canSelect, requestControl]
  )
  const setMode = useCallback(
    (playMode: MusicPlayMode) =>
      canControl ? emitHostMutation('music:mode-change', { playMode }) : false,
    [emitHostMutation, canControl]
  )
  const addFixture = useCallback(
    (item: {
      sourceRef: string
      title: string
      artist?: string
      durationMs?: number
    }) => (canSelect ? emitHostMutation('music:queue-add', { item }) : false),
    [emitHostMutation, canSelect]
  )
  const addMusic = useCallback(
    (item: {
      sourceRef: string
      title: string
      artist?: string
      album?: string
      artworkUrl?: string | null
      durationMs?: number
      metadata?: Record<string, unknown>
    }) => (canSelect ? emitHostMutation('music:queue-add', { item }) : false),
    [emitHostMutation, canSelect]
  )
  const remove = useCallback(
    (queueItemId: number) =>
      canSelect
        ? emitHostMutation('music:queue-remove', { queueItemId })
        : false,
    [emitHostMutation, canSelect]
  )
  const reorder = useCallback(
    (queueItemIds: number[]) =>
      canSelect
        ? emitHostMutation('music:queue-reorder', { queueItemIds })
        : false,
    [emitHostMutation, canSelect]
  )

  return {
    state: store,
    qualityFacts,
    play,
    seek,
    next,
    previous,
    select,
    setMode,
    addFixture,
    addMusic,
    remove,
    reorder,
    requestControl,
    respondControl,
  }
}
