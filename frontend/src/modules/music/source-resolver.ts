import { getApiUrl } from '@/lib/api'

/** Phase 5B-1 resolver: local fixture only, with no external fallback. */
export function resolveMusicSource(sourceRef: string | null): string | null {
  if (!sourceRef) return null
  const match = /^music:\/\/fixture\/([a-zA-Z0-9_-]{1,64})$/.exec(sourceRef)
  if (!match) return null
  return `${getApiUrl()}/api/music/fixture/${encodeURIComponent(match[1])}`
}
