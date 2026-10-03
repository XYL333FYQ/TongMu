import { t } from '@/i18n'
import type { MusicCatalogTrack } from './catalog-types'
import { englishErrorMessage } from '@/lib/errorMessage'

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
  standard: 'Standard',
  higher: 'High',
  exhigh: 'Very high',
  lossless: 'Lossless',
  hires: 'Hi-Res',
  jyeffect: 'HD surround',
  sky: 'Immersive surround',
  dolby: 'Dolby Atmos',
}

export function qualityLabel(value: MusicQuality): string {
  return t(QUALITY_LABELS[value])
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
    NCM_NOT_LOGGED_IN: 'Connect your NetEase Music account to continue.',
    NCM_CREDENTIAL_INVALID:
      'Your NetEase Music session expired. Connect your account again.',
    NCM_RESOURCE_NOT_FOUND: 'This item is unavailable or has been removed.',
    NCM_QUALITY_UNAVAILABLE:
      'The requested quality is unavailable. Another quality has not been selected automatically.',
    NCM_PRIVATE_ACCOUNT_DATA:
      'Your private NetEase Music library is currently unavailable. Try again later.',
    NCM_RATE_LIMITED:
      'NetEase Music received too many requests. Wait a moment and try again.',
    NCM_PROVIDER_UNAVAILABLE:
      'NetEase Music is currently unavailable. Try again later.',
    NCM_UPSTREAM_ERROR:
      'NetEase Music is currently unavailable. Try again later.',
    NCM_INVALID_RESPONSE:
      'NetEase Music returned an invalid response. Try again later.',
  }
  return (
    (code && messages[code] && t(messages[code])) ||
    englishErrorMessage(
      message,
      t('Unable to complete this NetEase Music action. Try again.')
    )
  )
}

export function formatQualityFacts(
  requested: MusicQuality,
  actual: MusicQuality | null,
  available: MusicQuality[],
  maximum: MusicQuality | null = null
): string {
  const availableText =
    available.length > 0
      ? t('Available: {qualities}', {
          qualities: available.map(qualityLabel).join(', '),
        })
      : t('Available quality: unknown')
  const maximumText = maximum
    ? t(' · Maximum: {quality}', { quality: qualityLabel(maximum) })
    : ''
  return t('Requested: {requested} · Actual: {actual}{maximum} · {available}', {
    requested: qualityLabel(requested),
    actual: actual ? qualityLabel(actual) : t('unresolved'),
    maximum: maximumText,
    available: availableText,
  })
}
