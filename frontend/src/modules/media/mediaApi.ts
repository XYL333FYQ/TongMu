import { registerMediaTransport } from './transport';
import { planPlayback } from './localPlanner';
import {
  collectPlaybackClientProfile,
  collectPlaybackClientProfileSync,
  toLegacyClientCapabilities,
  type PlaybackClientProfileV1,
} from './playbackProfile'
import { apiFetch, getApiUrl, safeJson } from '@/lib/api'
import type { MediaFormat } from '@/lib/mediaFormat'
import { getRoomMediaGrant } from './roomMediaGrant'
import type { ResolvedSource } from '@/modules/bilibili/types'

export interface PlaybackTransportCandidate {
  mode: 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY'
  url: string
  audioUrl?: string
  transport?: PlaybackTransport
  container?: MediaFormat
  videoCodec?: PlaybackClientProfileV1['mediaCapabilities'][number]['videoCodec']
  audioCodec?: PlaybackClientProfileV1['mediaCapabilities'][number]['audioCodec']
  exactCodecStrings?: string[]
  requiredPipelines?: PlaybackClientProfileV1['mediaCapabilities'][number]['pipeline'][]
  representationId?: string
  upstreamMode?: 'direct-play' | 'direct-stream' | 'transcode'
  qualityPreserved?: boolean
  qualityChanged?: boolean
  audioTranscoded?: boolean
  /** Opaque capability for server-side provider session lifecycle calls. */
  playbackSessionUrl?: string
}

type PlaybackTransport = 'progressive' | 'hls' | 'dash' | 'flv' | 'mpeg-ts' | 'webrtc'

export interface MediaServerSourceMetadata {
  providerReference: string
  provider: 'emby' | 'jellyfin'
  itemId: string
  mediaSourceId: string
  representationId: string
  upstreamMode: 'direct-play' | 'direct-stream' | 'transcode'
  qualityPreserved: boolean
  qualityChanged: boolean
  subtitles?: Array<{
    index: number
    language?: string
    label?: string
    codec?: string
    embedded: boolean
    external: boolean
    forced: boolean
    default: boolean
    sourceReference: string
  }>
}

export interface MediaDescriptor {
  transportPlan?: { candidates: PlaybackTransportCandidate[]; reason: string }
  sourceMaximumQuality?: number
  availableMaximumQuality?: number
  actualCodec?: string
  actualBandwidth?: number
  title?: string
  sourceType: string
  resolver: string
  input: string
  originalUrl: string
  finalUrl: string
  audioUrl?: string
  transport: 'direct' | 'hls' | 'dash' | 'flv'
  container: MediaFormat
  contentType?: string
  contentLength?: number
  rangeSupported?: boolean
  contentDisposition?: string
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  channels?: number
  audioBitrate?: number
  duration?: number
  subtitles?: Array<{ url: string; language?: string; label?: string }>
  requestedQuality?: number
  actualQuality?: number
  qualityLabel?: string
  loggedIn?: boolean
  vip?: boolean
  fallbackReason?: string
  sourceMetadata?: {
    bilibili?: {
      cid: number
      requestedQn?: number
      actualQn?: number
      preferMp4: boolean
      availableQualities: Array<{ id: number; label: string; resolution?: string }>
      qualityLabel?: string
      videoCodec?: string
      audioCodec?: string
      videoBandwidth?: number
      fallbackReason?: string
      pages?: Array<{ page: number; cid: number; part: string; duration: number }>
      currentPage?: number
    }
    emby?: MediaServerSourceMetadata
    jellyfin?: MediaServerSourceMetadata
  }
  drm: { protected: boolean; systems?: string[]; reason?: string }
  expiresAt?: number
  probe: {
    method: string
    bytesRead: number
    magic?: string
    warnings: string[]
  }
}

export interface PlaybackPlan {
  engine: 'direct' | 'hls' | 'dash' | 'flv' | 'playsvideo' | 'blocked'
  mode: 'direct' | 'manifest' | 'remux' | 'audio-transcode' | 'unsupported'
  proxy: boolean
  videoAction: string
  audioAction: string
  reasons: string[]
  candidateUrl?: string
  candidateMode?: 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY'
  playbackSessionUrl?: string
  upstreamMode?: 'direct-play' | 'direct-stream' | 'transcode'
  representationId?: string
  qualityChanged?: boolean
}

/**
 * Provider session capabilities belong to the active host playback only.
 * Persisting them in a Movie descriptor would create a stale room-visible
 * control token, so stored descriptors keep media facts and transport handles
 * but omit session operations.
 */
export function stripPlaybackSessionCapabilities(descriptor: MediaDescriptor): MediaDescriptor {
  if (!descriptor.transportPlan) return descriptor
  return {
    ...descriptor,
    transportPlan: {
      ...descriptor.transportPlan,
      candidates: descriptor.transportPlan.candidates.map((candidate) => {
        const persisted = { ...candidate }
        delete persisted.playbackSessionUrl
        return persisted
      }),
    },
  }
}

export interface ResolvedMedia {
  descriptor: MediaDescriptor
  plan: PlaybackPlan
  profile?: PlaybackClientProfileV1
  sourceReference?: string
}

export function normalizeMediaGatewayUrl(url?: string): string | undefined {
  if (!url || !url.startsWith('/') || url.startsWith('//')) return url
  return new URL(url, `${getApiUrl()}/`).toString()
}

export function toBilibiliResolvedSource(resolved: ResolvedMedia): ResolvedSource {
  const descriptor = resolved.descriptor
  const metadata = descriptor.sourceMetadata?.bilibili
  return {
    title: descriptor.title,
    videoUrl: descriptor.finalUrl,
    audioUrl: descriptor.audioUrl,
    videoCodec: descriptor.videoCodec,
    audioCodec: descriptor.audioCodec,
    duration: descriptor.duration,
    format: descriptor.container,
    loggedIn: descriptor.loggedIn,
    vipStatus: descriptor.vip ? 1 : 0,
    cid: metadata?.cid,
    currentQn: metadata?.actualQn ?? descriptor.actualQuality,
    requestedQn: metadata?.requestedQn ?? descriptor.requestedQuality,
    qualityLabel: metadata?.qualityLabel ?? descriptor.qualityLabel,
    videoBandwidth: metadata?.videoBandwidth ?? descriptor.bitrate,
    fallbackReason: metadata?.fallbackReason ?? descriptor.fallbackReason,
    acceptQuality: metadata?.availableQualities,
    pages: metadata?.pages,
    currentPage: metadata?.currentPage,
    resolvedUrl: descriptor.originalUrl,
  }
}

export interface ResolveMediaInputOptions {
  browserSniff?: boolean
  roomId?: string
  requestedQn?: number
  preferMp4?: boolean
  page?: number
  cid?: number
  /** Room media record being refreshed; kept out of public provider context. */
  movieId?: number
  sourceGeneration?: number
  /** Provider quality-changing transcode is opt-in and remains off by default. */
  allowQualityChangingTranscode?: boolean
}

export async function resolveMediaInput(
  input: string,
  options: ResolveMediaInputOptions = {}
): Promise<ResolvedMedia> {
  const {
    browserSniff = false,
    roomId,
    requestedQn,
    preferMp4,
    page,
    cid,
    movieId,
    sourceGeneration,
    allowQualityChangingTranscode = false,
  } = options
  const profile = await collectPlaybackClientProfile()
  const response = await apiFetch('/api/stream/media/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input,
      roomId,
      roomGrant: roomId ? getRoomMediaGrant(roomId) : undefined,
      movieId,
      sourceGeneration,
      allowQualityChangingTranscode,
      browserSniff,
      requestedQn,
      preferMp4,
      page,
      cid,
      profile,
    }),
  })
  const data = await safeJson<{
    success?: boolean
    message?: string
    descriptor?: MediaDescriptor
    viability?: { removed?: Array<{ mode: string; reason: string }> }
  }>(response, {})
  if (!response.ok || !data.success || !data.descriptor) {
    throw new Error(data.message || '媒体解析失败')
  }
  const result: ResolvedMedia = {
    descriptor: {
      ...data.descriptor,
      finalUrl: normalizeMediaGatewayUrl(data.descriptor.finalUrl) ?? data.descriptor.finalUrl,
      audioUrl: normalizeMediaGatewayUrl(data.descriptor.audioUrl),
    },
    plan: planPlayback(data.descriptor, profile, data.descriptor.transportPlan?.candidates),
    profile,
    sourceReference: data.descriptor.sourceMetadata?.emby?.providerReference
      ?? data.descriptor.sourceMetadata?.jellyfin?.providerReference,
  }
  registerMediaTransport(result.descriptor)
  return result
}

export function browserCapabilities() {
  return toLegacyClientCapabilities(collectPlaybackClientProfileSync())
}

function mediaSessionEndpoint(sessionUrl: string, action: 'start' | 'progress' | 'stop' | 'cleanup'): string {
  const absolute = normalizeMediaGatewayUrl(sessionUrl)
  if (!absolute) throw new Error('媒体播放会话凭证无效')
  const url = new URL(absolute)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${action}`
  return url.toString()
}

async function postMediaSession(
  sessionUrl: string,
  action: 'start' | 'progress' | 'stop' | 'cleanup',
  options: { roomId?: string; sourceGeneration?: number; position?: number; paused?: boolean } = {},
): Promise<void> {
  const response = await apiFetch(mediaSessionEndpoint(sessionUrl, action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomGrant: options.roomId ? getRoomMediaGrant(options.roomId) : undefined,
      sourceGeneration: options.sourceGeneration,
      position: options.position,
      paused: options.paused,
    }),
  })
  const data = await safeJson<{ success?: boolean; message?: string }>(response, {})
  if (!response.ok || !data.success) throw new Error(data.message || '媒体播放会话操作失败')
}

/** Start a provider playback session using an opaque capability from resolve. */
export function startMediaPlaybackSession(sessionUrl: string, options?: { roomId?: string; sourceGeneration?: number }): Promise<void> {
  return postMediaSession(sessionUrl, 'start', options)
}

export function reportMediaPlaybackProgress(sessionUrl: string, position: number, paused: boolean, options?: { roomId?: string; sourceGeneration?: number }): Promise<void> {
  return postMediaSession(sessionUrl, 'progress', { ...options, position, paused })
}

export function stopMediaPlaybackSession(sessionUrl: string, position = 0, options?: { roomId?: string; sourceGeneration?: number }): Promise<void> {
  return postMediaSession(sessionUrl, 'stop', { ...options, position })
}

export function cleanupMediaPlaybackSession(sessionUrl: string, options?: { roomId?: string; sourceGeneration?: number }): Promise<void> {
  return postMediaSession(sessionUrl, 'cleanup', options)
}
