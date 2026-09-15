import type { MusicSnapshot } from './types'

export interface MusicAuthorityMetadata {
  musicGeneration?: number
  version?: number
}

export function compareMusicAuthority(
  current: MusicAuthorityMetadata,
  incoming: MusicAuthorityMetadata
): -1 | 0 | 1 {
  const currentGeneration = current.musicGeneration ?? 0
  const incomingGeneration = incoming.musicGeneration ?? 0
  if (incomingGeneration < currentGeneration) return -1
  if (incomingGeneration > currentGeneration) return 1
  const currentVersion = current.version ?? 0
  const incomingVersion = incoming.version ?? 0
  if (incomingVersion < currentVersion) return -1
  if (incomingVersion > currentVersion) return 1
  return 0
}

export function shouldApplyMusicSnapshot(
  current: MusicAuthorityMetadata | undefined,
  incoming: MusicAuthorityMetadata
): boolean {
  if (!current) return true
  return compareMusicAuthority(current, incoming) > 0
}

/** Discrete state changes require a strictly newer music authority. */
export function shouldApplyMusicEvent(
  current: MusicAuthorityMetadata | undefined,
  incoming: MusicAuthorityMetadata
): boolean {
  return shouldApplyMusicSnapshot(current, incoming)
}

/** Heartbeats may share the current version, but never move backwards. */
export function shouldApplyMusicHeartbeat(
  current: MusicAuthorityMetadata | undefined,
  incoming: MusicAuthorityMetadata
): boolean {
  if (!current) return true
  const comparison = compareMusicAuthority(current, incoming)
  return (
    comparison >= 0 &&
    (incoming.musicGeneration ?? 0) >= (current.musicGeneration ?? 0)
  )
}

export function isMusicSnapshot(value: unknown): value is MusicSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<MusicSnapshot>
  return (
    typeof snapshot.roomId === 'string' &&
    Array.isArray(snapshot.queue) &&
    typeof snapshot.version === 'number' &&
    typeof snapshot.musicGeneration === 'number' &&
    typeof snapshot.serverTimestamp === 'number'
  )
}
