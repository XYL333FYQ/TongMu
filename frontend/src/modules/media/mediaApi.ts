import { registerMediaTransport } from './transport';
import { planPlayback } from './localPlanner';
import { apiFetch, getApiUrl, safeJson } from '@/lib/api'
import type { MediaFormat } from '@/lib/mediaFormat'
import { getRoomMediaGrant } from './roomMediaGrant'
import type { ResolvedSource } from '@/modules/bilibili/types'

export interface MediaDescriptor {
  transportPlan?: { candidates: Array<{ mode: 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY'; url: string; audioUrl?: string }>; reason: string }
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
}

export interface ResolvedMedia {
  descriptor: MediaDescriptor
  plan: PlaybackPlan
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
}

export async function resolveMediaInput(
  input: string,
  options: ResolveMediaInputOptions = {}
): Promise<ResolvedMedia> {
  const { browserSniff = false, roomId, requestedQn, preferMp4, page, cid } = options
  const video = document.createElement('video')
  const response = await apiFetch('/api/stream/media/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input,
      roomId,
      roomGrant: roomId ? getRoomMediaGrant(roomId) : undefined,
      browserSniff,
      requestedQn,
      preferMp4,
      page,
      cid,
      capabilities: {
        nativeHls: video.canPlayType('application/vnd.apple.mpegurl') !== '',
        mediaSource: typeof MediaSource !== 'undefined',
        playsvideo: typeof Worker !== 'undefined',
        hevc: video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '',
      },
    }),
  })
  const data = await safeJson<{
    success?: boolean
    message?: string
    descriptor?: MediaDescriptor
    plan?: PlaybackPlan
  }>(response, {})
  if (!response.ok || !data.success || !data.descriptor || !data.plan) {
    throw new Error(data.message || '媒体解析失败')
  }
  const result: ResolvedMedia = {
    descriptor: {
      ...data.descriptor,
      finalUrl: normalizeMediaGatewayUrl(data.descriptor.finalUrl) ?? data.descriptor.finalUrl,
      audioUrl: normalizeMediaGatewayUrl(data.descriptor.audioUrl),
    },
    plan: planPlayback(data.descriptor, browserCapabilities()),
  }
  registerMediaTransport(result.descriptor)
  return result
}

export function browserCapabilities() {
  const video = document.createElement('video')
  return { nativeHls: !!video.canPlayType('application/vnd.apple.mpegurl'), mediaSource: typeof MediaSource !== 'undefined', playsvideo: typeof Worker !== 'undefined', hevc: !!video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') }
}
