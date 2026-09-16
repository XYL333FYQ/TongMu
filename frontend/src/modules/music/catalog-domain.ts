import type { MusicCatalogTrack } from './catalog-types'

export const MUSIC_QUALITY_VALUES = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'dolby',
] as const
export type MusicQuality = (typeof MUSIC_QUALITY_VALUES)[number]

const TRACK_ID_RE = /^[1-9][0-9]{0,19}$/

const QUALITY_LABELS: Record<MusicQuality, string> = {
  standard: '标准',
  higher: '较高',
  exhigh: '极高',
  lossless: '无损',
  hires: 'Hi-Res',
  jyeffect: '高清环绕',
  sky: '沉浸环绕',
  dolby: '杜比全景声',
}

export function qualityLabel(value: MusicQuality): string {
  return QUALITY_LABELS[value]
}

export function qualityOptions(track: MusicCatalogTrack): MusicQuality[] {
  return track.availableQualities.length > 0
    ? track.availableQualities
    : [...MUSIC_QUALITY_VALUES]
}

export function isQualityAvailable(
  track: MusicCatalogTrack,
  requested: MusicQuality
): boolean {
  return (
    track.availableQualities.length === 0 ||
    track.availableQualities.includes(requested)
  )
}

export function normalizeCatalogTrack(
  value: unknown
): MusicCatalogTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    row.provider !== 'ncm' ||
    typeof row.trackId !== 'string' ||
    !TRACK_ID_RE.test(row.trackId) ||
    typeof row.sourceRef !== 'string' ||
    row.sourceRef !== `music://ncm/track/${row.trackId}` ||
    typeof row.title !== 'string' ||
    row.title.length === 0 ||
    row.title.length > 200 ||
    typeof row.artist !== 'string' ||
    typeof row.album !== 'string'
  ) {
    return null
  }
  const qualities = Array.isArray(row.availableQualities)
    ? row.availableQualities.filter(
        (quality): quality is MusicQuality =>
          typeof quality === 'string' &&
          (MUSIC_QUALITY_VALUES as readonly string[]).includes(quality)
      )
    : []
  const artworkUrl = typeof row.artworkUrl === 'string' ? row.artworkUrl : null
  return {
    provider: 'ncm',
    trackId: row.trackId,
    sourceRef: row.sourceRef,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl,
    durationMs:
      typeof row.durationMs === 'number' &&
      Number.isSafeInteger(row.durationMs) &&
      row.durationMs >= 0
        ? row.durationMs
        : null,
    availability:
      row.availability === 'restricted' || row.availability === 'unknown'
        ? row.availability
        : 'available',
    availableQualities: qualities.filter(
      (quality, index) => qualities.indexOf(quality) === index
    ),
    availableMaximum:
      typeof row.availableMaximum === 'string' &&
      (MUSIC_QUALITY_VALUES as readonly string[]).includes(row.availableMaximum)
        ? (row.availableMaximum as MusicQuality)
        : null,
    liked: typeof row.liked === 'boolean' ? row.liked : null,
  }
}

export function catalogErrorMessage(code?: string, message?: string): string {
  const messages: Record<string, string> = {
    NCM_NOT_LOGGED_IN: '请先登录网易云音乐',
    NCM_CREDENTIAL_INVALID: '网易云登录已失效，请重新登录',
    NCM_RESOURCE_NOT_FOUND: '内容不存在或已被删除',
    NCM_QUALITY_UNAVAILABLE: '请求的音质不可用，未自动切换到其他音质',
    NCM_PRIVATE_ACCOUNT_DATA: '当前账号的私有音乐数据暂不可用',
    NCM_RATE_LIMITED: '网易云请求过于频繁，请稍后再试',
    NCM_PROVIDER_UNAVAILABLE: '网易云音乐服务暂不可用',
    NCM_UPSTREAM_ERROR: '网易云音乐服务暂不可用',
    NCM_INVALID_RESPONSE: '网易云返回的数据格式无效',
  }
  return (code && messages[code]) || message || '网易云音乐操作失败'
}

export function formatQualityFacts(
  requested: MusicQuality,
  actual: MusicQuality | null,
  available: MusicQuality[],
  maximum: MusicQuality | null = null
): string {
  const availableText =
    available.length > 0
      ? `可用：${available.map(qualityLabel).join('、')}`
      : '可用音质：未知'
  const maximumText = maximum ? ` · 上限：${qualityLabel(maximum)}` : ''
  return `请求：${qualityLabel(requested)} · 实际：${actual ? qualityLabel(actual) : '未解析'}${maximumText} · ${availableText}`
}
