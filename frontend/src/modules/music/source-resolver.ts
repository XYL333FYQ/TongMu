import { getApiUrl } from '@/lib/api'
import { apiPost } from '@/lib/api'
import {
  appendMusicPlaybackGrant,
  getRoomMediaGrant,
} from '@/modules/media/roomMediaGrant'

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

export interface MusicSourceResolveContext {
  roomId: string
  queueItemId: number
  musicGeneration: number
  requestedQuality?: MusicQuality
}

export interface MusicSourceResolution {
  url: string | null
  mimeType?: string
  code?: string
  message?: string
  requestedQuality?: MusicQuality
  actualQuality?: MusicQuality | null
  availableQualities?: MusicQuality[]
  availableMaximum?: MusicQuality | null
}

export interface MusicQualityFacts {
  requestedQuality: MusicQuality
  actualQuality: MusicQuality | null
  availableQualities: MusicQuality[]
  availableMaximum: MusicQuality | null
}

interface NcmResolveResponse {
  success?: boolean
  code?: string
  message?: string
  playbackUrl?: string
  details?: {
    requestedQuality?: unknown
    actualQuality?: unknown
    availableQualities?: unknown
    availableMaximum?: unknown
  }
  descriptor?: {
    mimeType?: string
    requestedQuality?: unknown
    actualQuality?: unknown
    availableQualities?: unknown
    availableMaximum?: unknown
  }
}

function qualityFactsFrom(
  value:
    NcmResolveResponse['descriptor'] | NcmResolveResponse['details'] | undefined
): Partial<MusicQualityFacts> {
  const availableQualities = Array.isArray(value?.availableQualities)
    ? value.availableQualities.filter(isMusicQuality)
    : []
  return {
    requestedQuality: isMusicQuality(value?.requestedQuality)
      ? value.requestedQuality
      : undefined,
    actualQuality:
      value?.actualQuality === null
        ? null
        : isMusicQuality(value?.actualQuality)
          ? value.actualQuality
          : undefined,
    availableQualities,
    availableMaximum:
      value?.availableMaximum === null
        ? null
        : isMusicQuality(value?.availableMaximum)
          ? value.availableMaximum
          : undefined,
  }
}

/** Resolve the existing fixture or the bounded NCM provider path. */
export function resolveMusicSource(sourceRef: string | null): string | null {
  if (!sourceRef) return null
  const match = /^music:\/\/fixture\/([a-zA-Z0-9_-]{1,64})$/.exec(sourceRef)
  if (!match) return null
  return `${getApiUrl()}/api/music/fixture/${encodeURIComponent(match[1])}`
}

export function isMusicQuality(value: unknown): value is MusicQuality {
  return (
    typeof value === 'string' &&
    (MUSIC_QUALITY_VALUES as readonly string[]).includes(value)
  )
}

/** Resolve an NCM source through the room-authorized opaque gateway. */
export async function resolveMusicSourceDetailed(
  sourceRef: string | null,
  context: MusicSourceResolveContext
): Promise<MusicSourceResolution> {
  const fixture = resolveMusicSource(sourceRef)
  if (fixture) return { url: fixture, mimeType: 'audio/wav' }
  if (
    !sourceRef ||
    !/^music:\/\/ncm\/track\/[1-9][0-9]{0,19}$/.test(sourceRef)
  ) {
    return {
      url: null,
      code: 'MUSIC_INVALID_REQUEST',
      message: '当前音乐来源无法解析',
    }
  }
  const roomGrant = getRoomMediaGrant(context.roomId)
  if (!roomGrant) {
    return {
      url: null,
      code: 'MUSIC_ROOM_FORBIDDEN',
      message: '当前房间授权已失效',
    }
  }
  const quality =
    context.requestedQuality && isMusicQuality(context.requestedQuality)
      ? context.requestedQuality
      : 'exhigh'
  try {
    const result = await apiPost<NcmResolveResponse>('/api/music/resolve', {
      roomId: context.roomId,
      roomGrant,
      queueItemId: context.queueItemId,
      sourceRef,
      musicGeneration: context.musicGeneration,
      requestedQuality: quality,
    })
    const data = result.data
    if (!result.ok || !data?.success || typeof data.playbackUrl !== 'string') {
      const facts = qualityFactsFrom(data?.details)
      return {
        url: null,
        code: data?.code || 'NCM_UPSTREAM_ERROR',
        message: data?.message || '网易云音乐解析失败',
        ...facts,
      }
    }
    const facts = qualityFactsFrom(data.descriptor)
    return {
      url: appendMusicPlaybackGrant(data.playbackUrl, context.roomId),
      mimeType:
        typeof data.descriptor?.mimeType === 'string'
          ? data.descriptor.mimeType
          : undefined,
      ...facts,
    }
  } catch {
    return {
      url: null,
      code: 'NCM_UPSTREAM_ERROR',
      message: '网易云音乐解析失败',
    }
  }
}
