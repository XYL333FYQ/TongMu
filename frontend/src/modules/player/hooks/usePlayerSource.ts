import { message } from '@/components/ui/message'
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import {
  selectEngine,
  shouldUsePlaysVideo,
  resetVideoElement,
} from '@/modules/player'
import type {
  EngineAttachResult,
  PlayerController,
  PlayerSource,
} from '@/modules/player'
import { refreshAccessToken } from '@/lib/api'
import {
  createPlayerGeneration,
  disposePlayerGeneration,
  getPlayerResourceSnapshot,
  isCurrentPlayerGeneration,
  playerSourceKey,
  toPlayerLifecycleSnapshot,
  trackPlayerResource,
} from '@/modules/player/lifecycle'
import type {
  PlayerGeneration,
  PlayerLifecycleSnapshot,
} from '@/modules/player/lifecycle'
import {
  formatVideoLoadError,
  isPlayerAbortError,
} from '@/modules/player/utils'
import { redactMediaError } from '@/modules/player/services/media-redaction'
import {
  getUnsupportedFormatMessage,
  isBrowserPlayableFormat,
} from '@/lib/mediaFormat'

function isAuthExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b(401|403)\b/.test(msg)
}

function once(callback: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    try {
      callback()
    } catch {
      // A failed cleanup must not prevent the remaining generation resources.
    }
  }
}

function cleanupAttachResult(result: EngineAttachResult): void {
  try {
    result.cleanup?.()
  } catch {
    /* ignore */
  }
}

interface ActivePlayerGeneration {
  generation: PlayerGeneration
  video: HTMLVideoElement
  source: PlayerSource
  sourceKey: string
  cleanupAttempt: (() => void) | null
  removeMediaListeners: (() => void) | null
  releaseEngine: (() => void) | null
  fallbackStarted: boolean
}

interface AttachedAttempt {
  result: EngineAttachResult
  releaseEngine: () => void
}

const MEDIA_EVENTS = [
  'play',
  'pause',
  'seeking',
  'seeked',
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'canplay',
  'error',
  'ended',
] as const

export interface UsePlayerSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
}

export interface UsePlayerSourceReturn {
  attachSource: (video: HTMLVideoElement, source: PlayerSource) => Promise<void>
  cleanup: () => void
  appliedSourceUrlRef: MutableRefObject<string | null>
  playerRef: MutableRefObject<PlayerController | null>
  lifecycleSnapshotRef: MutableRefObject<PlayerLifecycleSnapshot>
  /** Test/debug readout; this is intentionally not a product metrics API. */
  getResourceSnapshot: typeof getPlayerResourceSnapshot
  seekTo: (
    video: HTMLVideoElement,
    targetTime: number
  ) => Promise<{
    success: boolean
    needReload?: boolean
    message?: string
  }>
  forceReload: (video: HTMLVideoElement, source: PlayerSource) => Promise<void>
}

export function usePlayerSource(
  options: UsePlayerSourceOptions
): UsePlayerSourceReturn {
  const appliedSourceUrlRef = useRef<string | null>(null)
  const playerRef = useRef<PlayerController | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const engineCleanupRef = useRef<(() => void) | null>(null)
  const activeRef = useRef<ActivePlayerGeneration | null>(null)
  const nextGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const lifecycleSnapshotRef = useRef<PlayerLifecycleSnapshot>({
    generation: 0,
    state: 'idle',
  })

  useEffect(() => {
    const video = options.videoRef.current
    if (!video) return
    const report = (event: Event) =>
      message.error((event as CustomEvent<string>).detail)
    video.addEventListener('media-transport-error', report)
    return () => video.removeEventListener('media-transport-error', report)
  }, [options.videoRef])

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task)
    queueRef.current = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }, [])

  const isCurrent = useCallback(
    (active: ActivePlayerGeneration): boolean =>
      isCurrentPlayerGeneration(
        activeRef.current?.generation,
        active.generation,
        mountedRef.current
      ),
    []
  )

  const setLifecycleState = useCallback(
    (
      active: ActivePlayerGeneration,
      state: PlayerGeneration['state']
    ): void => {
      active.generation.state = state
      if (!isCurrent(active)) return
      lifecycleSnapshotRef.current = toPlayerLifecycleSnapshot(
        active.generation
      )
      active.video.dataset.playerGeneration = String(active.generation.id)
      active.video.dataset.playerLifecycle = state
      if (active.generation.sourceGeneration !== undefined) {
        active.video.dataset.playerSourceGeneration = String(
          active.generation.sourceGeneration
        )
      } else {
        delete active.video.dataset.playerSourceGeneration
      }
    },
    [isCurrent]
  )

  const removeMediaListeners = useCallback(
    (active: ActivePlayerGeneration): void => {
      active.removeMediaListeners?.()
      active.removeMediaListeners = null
    },
    []
  )

  /** Clean only resources owned by this generation. */
  const cleanupAttempt = useCallback(
    (active: ActivePlayerGeneration): void => {
      removeMediaListeners(active)
      active.cleanupAttempt?.()
      active.cleanupAttempt = null
      active.releaseEngine?.()
      active.releaseEngine = null

      if (active === activeRef.current) {
        engineCleanupRef.current = null
        playerRef.current = null
        blobUrlRef.current = null
      }
    },
    [removeMediaListeners]
  )

  const disposeActive = useCallback(
    (active: ActivePlayerGeneration | null = activeRef.current): void => {
      if (!active) {
        engineCleanupRef.current = null
        playerRef.current = null
        blobUrlRef.current = null
        appliedSourceUrlRef.current = null
        return
      }

      disposePlayerGeneration(active.generation)
      cleanupAttempt(active)
      try {
        active.video.pause()
      } catch {
        /* ignore */
      }
      try {
        resetVideoElement(active.video)
      } catch {
        /* ignore */
      }

      if (active === activeRef.current) {
        activeRef.current = null
        appliedSourceUrlRef.current = null
        lifecycleSnapshotRef.current = toPlayerLifecycleSnapshot(
          active.generation
        )
        active.video.removeAttribute('data-player-generation')
        active.video.removeAttribute('data-player-lifecycle')
        active.video.removeAttribute('data-player-source-generation')
        active.video.removeAttribute('data-media-source')
      }
    },
    [cleanupAttempt]
  )

  const replaceWithPlaysVideoRef = useRef<(
    active: ActivePlayerGeneration,
    atTime: number,
    wasPlaying: boolean
  ) => Promise<void>>(async () => {})

  const bindMediaListeners = useCallback(
    (active: ActivePlayerGeneration, engineType: string): void => {
      const removers: Array<() => void> = []
      for (const eventName of MEDIA_EVENTS) {
        const listener = () => {
          if (!isCurrent(active)) return
          if (eventName === 'loadedmetadata' || eventName === 'canplay') {
            setLifecycleState(active, 'ready')
          }
        }
        active.video.addEventListener(eventName, listener)
        const release = trackPlayerResource('listeners')
        removers.push(
          once(() => {
            active.video.removeEventListener(eventName, listener)
            release()
          })
        )
      }

      active.removeMediaListeners = once(() => {
        for (const remove of removers) remove()
      })

      if (
        active.source.mkvFastPath &&
        engineType === 'direct' &&
        !active.source.forcePlaysVideo
      ) {
        const onNativeError = () => {
          if (!isCurrent(active) || active.fallbackStarted) return
          active.fallbackStarted = true
          const atTime = active.video.currentTime
          const wasPlaying = !active.video.paused
          void enqueue(() =>
            replaceWithPlaysVideoRef.current(active, atTime, wasPlaying)
          )
        }
        active.video.addEventListener('error', onNativeError)
        const release = trackPlayerResource('listeners')
        removers.push(
          once(() => {
            active.video.removeEventListener('error', onNativeError)
            release()
          })
        )
      }
    },
    [enqueue, isCurrent, setLifecycleState]
  )

  const attachWithEngine = useCallback(
    async (
      active: ActivePlayerGeneration,
      source: PlayerSource,
      authRetried = false
    ): Promise<AttachedAttempt | null> => {
      if (!isCurrent(active)) return null
      const engine = selectEngine(source)
      const releaseEngine = trackPlayerResource('engines')
      try {
        let retried = authRetried
        while (true) {
          try {
            const result = await engine.attach(active.video, {
              ...source,
              signal: active.generation.abortController.signal,
            })
            if (!isCurrent(active)) {
              cleanupAttachResult(result)
              releaseEngine()
              return null
            }
            return { result, releaseEngine }
          } catch (err) {
            if (
              isCurrent(active) &&
              !retried &&
              !isPlayerAbortError(err) &&
              isAuthExpiredError(err)
            ) {
              const refreshed = await refreshAccessToken()
              if (refreshed && isCurrent(active)) {
                retried = true
                console.warn(
                  '[usePlayerSource] 媒体请求鉴权失效，token 已刷新，重试 attach'
                )
                continue
              }
            }
            throw err
          }
        }
      } catch (err) {
        releaseEngine()
        throw err
      }
    },
    [isCurrent]
  )

  const commitAttempt = useCallback(
    (
      active: ActivePlayerGeneration,
      attempt: AttachedAttempt,
      engineType: string
    ): boolean => {
      if (!isCurrent(active)) {
        cleanupAttachResult(attempt.result)
        attempt.releaseEngine()
        return false
      }

      const result = attempt.result
      active.releaseEngine = attempt.releaseEngine
      active.cleanupAttempt = once(() => {
        cleanupAttachResult(result)
        if (result.blobUrl) {
          try {
            URL.revokeObjectURL(result.blobUrl)
          } catch {
            /* ignore */
          }
        }
        attempt.releaseEngine()
      })
      engineCleanupRef.current = active.cleanupAttempt
      playerRef.current = result.player ?? null
      blobUrlRef.current = result.blobUrl ?? null
      appliedSourceUrlRef.current = active.source.url
      active.video.dataset.mediaSource = active.source.url
      bindMediaListeners(active, engineType)
      setLifecycleState(active, 'ready')
      return true
    },
    [bindMediaListeners, isCurrent, setLifecycleState]
  )

  const replaceWithPlaysVideo = useCallback(
    async (
      active: ActivePlayerGeneration,
      atTime: number,
      wasPlaying: boolean
    ): Promise<void> => {
      if (!isCurrent(active)) return
      setLifecycleState(active, 'replacing')
      cleanupAttempt(active)
      resetVideoElement(active.video)

      const pipelineSource: PlayerSource = {
        ...active.source,
        forcePlaysVideo: true,
        signal: active.generation.abortController.signal,
      }
      const pipelineEngine = selectEngine(pipelineSource)
      if (pipelineEngine.type === 'direct') {
        setLifecycleState(active, 'failed')
        return
      }
      const attempt = await attachWithEngine(active, pipelineSource)
      if (!attempt || !isCurrent(active)) return
      if (!commitAttempt(active, attempt, pipelineEngine.type)) return

      if (atTime > 0) {
        try {
          active.video.currentTime = atTime
        } catch {
          /* ignore */
        }
      }
      if (wasPlaying && isCurrent(active)) {
        void active.video.play().catch(() => {})
      }
    },
    [
      attachWithEngine,
      cleanupAttempt,
      commitAttempt,
      isCurrent,
      setLifecycleState,
    ]
  )
  useEffect(() => {
    replaceWithPlaysVideoRef.current = replaceWithPlaysVideo
    return () => {
      replaceWithPlaysVideoRef.current = async () => {}
    }
  }, [replaceWithPlaysVideo])

  const attachGeneration = useCallback(
    async (active: ActivePlayerGeneration): Promise<void> => {
      if (!isCurrent(active)) return
      setLifecycleState(active, 'attaching')
      const source = {
        ...active.source,
        signal: active.generation.abortController.signal,
      }
      const engine = selectEngine(source)
      try {
        const attempt = await attachWithEngine(active, source)
        if (!attempt || !isCurrent(active)) return
        if (commitAttempt(active, attempt, engine.type)) return
      } catch (err) {
        if (!isCurrent(active) || isPlayerAbortError(err)) return
        if (
          source.mkvFastPath &&
          engine.type === 'direct' &&
          !source.forcePlaysVideo
        ) {
          console.warn(
            '[usePlayerSource] MKV 原生 attach 失败，回退 playsvideo 管线:',
            redactMediaError(err)
          )
          active.fallbackStarted = true
          const pipelineSource = {
            ...source,
            forcePlaysVideo: true,
            signal: active.generation.abortController.signal,
          }
          const pipelineEngine = selectEngine(pipelineSource)
          if (pipelineEngine.type === 'direct') {
            throw new Error(
              `原生播放失败：${formatVideoLoadError(active.video.error?.code)}。` +
                '可在「系统设置」或该影片的解析设置中开启「浏览器转码引擎」后重试',
              { cause: err }
            )
          }
          resetVideoElement(active.video)
          const fallbackAttempt = await attachWithEngine(
            active,
            pipelineSource
          )
          if (!fallbackAttempt || !isCurrent(active)) return
          commitAttempt(active, fallbackAttempt, pipelineEngine.type)
          return
        }
        if (engine.type === 'playsvideo') {
          throw new Error(
            `浏览器转码引擎（playsvideo）播放失败：${
              err instanceof Error ? err.message : String(err)
            }，可尝试重载影片`,
            { cause: err }
          )
        }
        throw err
      }
    },
    [attachWithEngine, commitAttempt, isCurrent, setLifecycleState]
  )

  const startGeneration = useCallback(
    (video: HTMLVideoElement, source: PlayerSource): Promise<void> => {
      disposeActive()
      const generation = createPlayerGeneration(
        ++nextGenerationRef.current,
        source.sourceGeneration
      )
      const active: ActivePlayerGeneration = {
        generation,
        video,
        source: { ...source },
        sourceKey: playerSourceKey(source),
        cleanupAttempt: null,
        removeMediaListeners: null,
        releaseEngine: null,
        fallbackStarted: false,
      }
      activeRef.current = active
      setLifecycleState(active, 'replacing')

      return enqueue(async () => {
        if (!isCurrent(active)) return
        try {
          await attachGeneration(active)
        } catch (err) {
          if (!isCurrent(active) || isPlayerAbortError(err)) return
          setLifecycleState(active, 'failed')
          disposeActive(active)
          throw err
        }
      })
    },
    [attachGeneration, disposeActive, enqueue, isCurrent, setLifecycleState]
  )

  const cleanup = useCallback(() => {
    disposeActive()
  }, [disposeActive])

  const attachSource = useCallback(
    async (video: HTMLVideoElement, source: PlayerSource): Promise<void> => {
      if (!source.url) return
      if (
        source.format &&
        !isBrowserPlayableFormat(source.format) &&
        !shouldUsePlaysVideo(source)
      ) {
        throw new Error(getUnsupportedFormatMessage(source.format))
      }

      const current = activeRef.current
      const nextKey = playerSourceKey(source)
      if (current && isCurrent(current) && current.sourceKey === nextKey) {
        return
      }
      await startGeneration(video, source)
    },
    [isCurrent, startGeneration]
  )

  const forceReload = useCallback(
    async (video: HTMLVideoElement, source: PlayerSource): Promise<void> => {
      if (!source.url) return
      await startGeneration(video, source)
    },
    [startGeneration]
  )

  const seekTo = useCallback(
    async (
      _video: HTMLVideoElement,
      targetTime: number
    ): Promise<{
      success: boolean
      needReload?: boolean
      message?: string
    }> => {
      const active = activeRef.current
      const player = playerRef.current
      if (!active || !player || !isCurrent(active) || !player.isAttached) {
        return { success: false }
      }
      return player.seekTo(targetTime)
    },
    [isCurrent]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      disposeActive()
      lifecycleSnapshotRef.current = { generation: 0, state: 'idle' }
    }
  }, [disposeActive])

  return {
    attachSource,
    cleanup,
    appliedSourceUrlRef,
    playerRef,
    lifecycleSnapshotRef,
    getResourceSnapshot: getPlayerResourceSnapshot,
    seekTo,
    forceReload,
  }
}
