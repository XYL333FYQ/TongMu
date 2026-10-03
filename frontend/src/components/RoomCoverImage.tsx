import { useState } from 'react'
import { defaultRoomCover, roomCoverSource } from '@/lib/roomCover'

export function RoomCoverImage({
  roomId,
  coverUrl,
}: {
  roomId: string
  coverUrl?: string | null
}) {
  const [failedSources, setFailedSources] = useState<string[]>([])
  const requested = roomCoverSource(roomId, coverUrl)
  const fallback = defaultRoomCover(roomId)
  const source = [requested, fallback].find(
    (value) => !failedSources.includes(value)
  )
  if (!source) return null
  return (
    <img
      className="tm-room-cover-image"
      src={source}
      alt=""
      width={960}
      height={540}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSources((failed) => [...failed, source])}
    />
  )
}
