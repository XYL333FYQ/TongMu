export type AnimeProviderFamily = 'anisubs' | 'kazumi' | 'anime'

const VOLATILE_KEY = /(?:url|token|cookie|auth|secret|sign|signature|expires|exp|key)/i

function stableSelector(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {}
  const result: Record<string, unknown> = {}
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    if (index >= 64) break
    if (key !== 'episodeUrl' && VOLATILE_KEY.test(key)) continue
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (String(item).length <= 512) result[key] = item
    } else if (item && typeof item === 'object') {
      const nested = stableSelector(item, depth + 1)
      if (Object.keys(nested).length) result[key] = nested
    }
  }
  return result
}

export function buildAnimeProviderReference(
  family: AnimeProviderFamily,
  source: string,
  episode: { id: string; title?: string; episodeNumber?: number; playbackParams?: Record<string, unknown> },
): string {
  const query = new URLSearchParams({
    source: source.slice(0, 512),
    episode: episode.id.slice(0, 512),
  })
  const selector = stableSelector(episode.playbackParams)
  if (Object.keys(selector).length) query.set('selector', JSON.stringify(selector))
  if (episode.title) query.set('title', episode.title.slice(0, 256))
  if (Number.isFinite(episode.episodeNumber)) query.set('number', String(episode.episodeNumber))
  let reference = `provider://${family}?${query.toString()}`
  if (reference.length > 4096 && episode.title) {
    query.delete('title')
    reference = `provider://${family}?${query.toString()}`
  }
  if (reference.length > 4096 && Number.isFinite(episode.episodeNumber)) {
    query.delete('number')
    reference = `provider://${family}?${query.toString()}`
  }
  if (reference.length > 4096) throw new Error('番剧 Provider 引用过长')
  return reference
}

export function stripTransientAnimeDescriptor<T extends { input: string; originalUrl: string; finalUrl: string; audioUrl?: string; expiresAt?: number; transportPlan?: unknown }>(descriptor: T): Record<string, unknown> {
  const persisted = { ...descriptor } as Record<string, unknown>
  persisted.input = ''
  persisted.originalUrl = ''
  persisted.finalUrl = ''
  delete persisted.audioUrl
  delete persisted.transportPlan
  delete persisted.headers
  delete persisted.credentialOrigins
  return persisted
}
