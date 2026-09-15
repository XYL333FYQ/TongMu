/**
 * Player source-generation lifecycle primitives.
 *
 * This module intentionally has no React or engine dependency.  A generation
 * owns its cancellation signal and cleanup callbacks; a late callback may
 * clean its own generation, but it can never become the current generation.
 */

export type PlayerLifecycleState =
  | 'idle'
  | 'resolving'
  | 'attaching'
  | 'ready'
  | 'replacing'
  | 'failed'
  | 'destroyed'

export interface PlayerGeneration {
  readonly id: number
  readonly sourceGeneration?: number
  readonly abortController: AbortController
  readonly releaseFetchController: () => void
  state: PlayerLifecycleState
  disposed: boolean
}

export interface PlayerLifecycleSnapshot {
  generation: number
  sourceGeneration?: number
  state: PlayerLifecycleState
}

export type PlayerResourceKind =
  | 'engines'
  | 'workers'
  | 'objectUrls'
  | 'mediaSources'
  | 'listeners'
  | 'fetchControllers'
  | 'timers'

export interface PlayerResourceSnapshot {
  activeEngines: number
  activeWorkers: number
  activeObjectUrls: number
  activeMediaSources: number
  registeredListeners: number
  activePlayerFetchControllers: number
  activeTimers: number
}

const resourceKeys: Record<PlayerResourceKind, keyof PlayerResourceSnapshot> = {
  engines: 'activeEngines',
  workers: 'activeWorkers',
  objectUrls: 'activeObjectUrls',
  mediaSources: 'activeMediaSources',
  listeners: 'registeredListeners',
  fetchControllers: 'activePlayerFetchControllers',
  timers: 'activeTimers',
}

const resourceCounts: PlayerResourceSnapshot = {
  activeEngines: 0,
  activeWorkers: 0,
  activeObjectUrls: 0,
  activeMediaSources: 0,
  registeredListeners: 0,
  activePlayerFetchControllers: 0,
  activeTimers: 0,
}

/** Register one owned resource and return an idempotent release function. */
export function trackPlayerResource(
  kind: PlayerResourceKind,
  onRelease?: () => void
): () => void {
  const key = resourceKeys[kind]
  resourceCounts[key] += 1
  let released = false
  return () => {
    if (released) return
    released = true
    resourceCounts[key] = Math.max(0, resourceCounts[key] - 1)
    try {
      onRelease?.()
    } catch {
      // Instrumentation must never make cleanup throw.
    }
  }
}

export function getPlayerResourceSnapshot(): PlayerResourceSnapshot {
  return { ...resourceCounts }
}

/** Test-only reset hook; production code should only release owned resources. */
export function resetPlayerResourceInstrumentation(): void {
  for (const key of Object.keys(resourceCounts) as Array<keyof PlayerResourceSnapshot>) {
    resourceCounts[key] = 0
  }
}

export function createPlayerGeneration(
  id: number,
  sourceGeneration?: number
): PlayerGeneration {
  const abortController = new AbortController()
  const releaseFetchController = trackPlayerResource('fetchControllers')
  return {
    id,
    sourceGeneration,
    abortController,
    releaseFetchController,
    state: 'idle',
    disposed: false,
  }
}

export function isCurrentPlayerGeneration(
  current: PlayerGeneration | null | undefined,
  generation: PlayerGeneration,
  mounted = true
): boolean {
  return (
    mounted &&
    current === generation &&
    !generation.disposed &&
    !generation.abortController.signal.aborted
  )
}

export function disposePlayerGeneration(
  generation: PlayerGeneration,
  releaseFetchController = generation.releaseFetchController
): void {
  if (generation.disposed) return
  generation.disposed = true
  generation.state = 'destroyed'
  if (!generation.abortController.signal.aborted) {
    generation.abortController.abort()
  }
  releaseFetchController?.()
}

export function toPlayerLifecycleSnapshot(
  generation: PlayerGeneration | null | undefined
): PlayerLifecycleSnapshot {
  if (!generation) return { generation: 0, state: 'idle' }
  return {
    generation: generation.id,
    sourceGeneration: generation.sourceGeneration,
    state: generation.state,
  }
}

/** Stable key for an attach boundary; URL alone is deliberately insufficient. */
export function playerSourceKey(source: {
  url: string
  audioUrl?: string
  format?: string
  sourceGeneration?: number
}): string {
  return [
    source.sourceGeneration ?? 'local',
    source.url,
    source.audioUrl ?? '',
    source.format ?? '',
  ].join('|')
}
