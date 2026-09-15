import type { MusicPlayMode, MusicQueueItem } from './types'

export const MUSIC_DRIFT_THRESHOLD_SEC = 1.5
export const MUSIC_MAX_POSITION_JUMP_SEC = 30

export function expectedMusicPosition(
  positionSec: number,
  isPlaying: boolean,
  playbackRate: number,
  serverTimestamp: number,
  now = Date.now(),
  networkDelayMs = 0
): number {
  if (!isPlaying) return Math.max(0, positionSec)
  const delay = Math.min(30_000, Math.max(0, networkDelayMs))
  const elapsed =
    Math.min(
      MUSIC_MAX_POSITION_JUMP_SEC * 1000,
      Math.max(0, now - serverTimestamp - delay)
    ) / 1000
  const rate =
    Number.isFinite(playbackRate) && playbackRate > 0 && playbackRate <= 4
      ? playbackRate
      : 1
  return Math.max(0, positionSec + elapsed * rate)
}

export function shouldCorrectMusicDrift(
  localPositionSec: number,
  expectedPositionSec: number,
  thresholdSec = MUSIC_DRIFT_THRESHOLD_SEC
): boolean {
  return (
    Number.isFinite(localPositionSec) &&
    Number.isFinite(expectedPositionSec) &&
    Math.abs(localPositionSec - expectedPositionSec) >
      Math.max(0.25, thresholdSec)
  )
}

export function durationSeconds(item: MusicQueueItem | null): number {
  return item && Number.isFinite(item.durationMs)
    ? Math.max(0, item.durationMs / 1000)
    : 0
}

export function modeLabel(mode: MusicPlayMode): string {
  if (mode === 'repeat-one') return '单曲循环'
  if (mode === 'repeat-all') return '列表循环'
  if (mode === 'shuffle') return '随机播放'
  return '顺序播放'
}

export function formatMusicTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}
