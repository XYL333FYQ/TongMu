import { getApiUrl } from './api'

const defaultCovers = ['aurora', 'cinema', 'music', 'studio']
const uploadedCover = /^\/uploads\/room-covers\/[0-9a-f-]{36}\.(png|jpg|webp)$/

/** Keep a room's fallback stable across refreshes, names and activity changes. */
export function defaultRoomCover(roomId: string): string {
  let hash = 0
  for (const character of roomId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `/room-covers/${defaultCovers[hash % defaultCovers.length]}.webp`
}

export function roomCoverSource(
  roomId: string,
  coverUrl?: string | null
): string {
  return coverUrl && uploadedCover.test(coverUrl)
    ? `${getApiUrl()}${coverUrl}`
    : defaultRoomCover(roomId)
}
