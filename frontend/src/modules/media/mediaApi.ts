import { apiFetch, safeJson } from '@/lib/api'
import type { MediaFormat } from '@/lib/mediaFormat'

export interface MediaDescriptor {
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

export async function resolveMediaInput(
  input: string,
  browserSniff = false,
  roomId?: string
): Promise<ResolvedMedia> {
  const response = await apiFetch('/api/stream/media/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input,
      roomId,
      browserSniff,
      capabilities: {
        mediaSource: typeof MediaSource !== 'undefined',
        playsvideo: typeof Worker !== 'undefined',
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
  return { descriptor: data.descriptor, plan: data.plan }
}
