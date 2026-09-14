import type { MediaDescriptor, PlaybackPlan } from './mediaApi'
import {
  audioCodecFamily,
  isPlaybackClientProfile,
  type LegacyClientCapabilities,
  type PlaybackClientProfileV1,
  type PlaybackPipeline,
  type PlaybackTransport,
  type PlaybackVideoCodec,
  type PlaybackAudioCodec,
} from './playbackProfile'

export type ClientCapabilities = LegacyClientCapabilities

const AUDIO_TRANSCODE_CODECS = new Set(['dts', 'dca', 'ac3', 'eac3', 'truehd', 'flac'])
const CANDIDATE_ORDER = new Map([
  ['DIRECT', 0],
  ['MANIFEST_ASSISTED', 1],
  ['PARTIAL_PROXY', 2],
  ['FULL_PROXY', 3],
])

interface TransportCandidate {
  mode: 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY'
  url: string
  audioUrl?: string
}

function blocked(reason: string): PlaybackPlan {
  return {
    engine: 'blocked', mode: 'unsupported', proxy: false,
    videoAction: 'none', audioAction: 'none', reasons: [reason],
  }
}

function legacyPlanPlayback(media: MediaDescriptor, capabilities: ClientCapabilities = {}): PlaybackPlan {
  if (media.drm?.protected) return blocked(`检测到 DRM：${media.drm.systems?.join(', ') || 'ContentProtection'}`)
  const audioCodec = media.audioCodec?.toLowerCase()
  const videoCodec = media.videoCodec?.toLowerCase()
  if (videoCodec && /^(?:hevc|h265|hev1|hvc1)/.test(videoCodec) && capabilities.hevc === false) {
    return blocked('当前浏览器不支持 HEVC，且项目未启用全视频转码')
  }
  if (media.transport === 'hls') {
    if (capabilities.nativeHls === false && capabilities.mediaSource === false) return blocked('当前浏览器既不支持原生 HLS，也没有 MediaSource')
    return {
      engine: 'hls', mode: 'manifest', proxy: false, videoAction: 'direct', audioAction: 'direct',
      reasons: [capabilities.nativeHls ? '客户端可原生播放 HLS' : '使用现有 HLS 引擎'],
    }
  }
  if (media.transport === 'dash') {
    if (capabilities.mediaSource === false) return blocked('当前浏览器没有 MediaSource，无法播放 DASH')
    return { engine: 'dash', mode: 'manifest', proxy: false, videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 DASH 引擎'] }
  }
  if (media.transport === 'flv') {
    if (capabilities.mediaSource === false) return blocked('当前浏览器没有 MediaSource，无法播放 FLV')
    return { engine: 'flv', mode: 'manifest', proxy: false, videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 FLV 引擎'] }
  }
  if (audioCodec && AUDIO_TRANSCODE_CODECS.has(audioCodec)) {
    if (media.rangeSupported === false) return blocked('源站不支持 Range，无法安全执行随机读取与音频转码')
    if (capabilities.playsvideo === false) return blocked('当前浏览器无法运行音频转码工作线程')
    return {
      engine: 'playsvideo', mode: 'audio-transcode', proxy: false, videoAction: 'copy', audioAction: 'transcode-aac',
      reasons: [`${audioCodec.toUpperCase()} 音频浏览器不兼容；保留视频，仅转 AAC`],
    }
  }
  if (['mkv', 'ts', 'avi', 'wmv'].includes(media.container)) {
    if (media.rangeSupported === false) return blocked('源站不支持 Range，playsvideo 无法随机读取并重封装')
    if (capabilities.playsvideo === false) return blocked('当前浏览器无法运行 playsvideo 重封装')
    return {
      engine: 'playsvideo', mode: 'remux', proxy: false, videoAction: 'copy', audioAction: 'copy',
      reasons: [`${media.container.toUpperCase()} 交给现有 playsvideo 重封装`],
    }
  }
  return {
    engine: 'direct', mode: 'direct', proxy: false, videoAction: 'direct', audioAction: 'direct',
    reasons: media.rangeSupported === false ? ['浏览器原生顺序播放；源站不支持 seek'] : ['浏览器原生 Direct Play'],
  }
}

function transportForMedia(media: MediaDescriptor): PlaybackTransport {
  if (media.transport === 'direct' && media.container === 'ts') return 'mpeg-ts'
  return media.transport === 'direct' ? 'progressive' : media.transport
}

function requiredPipelines(media: MediaDescriptor): PlaybackPipeline[] {
  if (media.transport === 'hls') return ['native', 'mse', 'managed-mse']
  if (media.transport === 'dash' || media.transport === 'flv') return ['mse', 'managed-mse']
  if (['mkv', 'avi', 'wmv', 'ts'].includes(media.container)) return ['native', 'playsvideo']
  return ['native']
}

function videoFamily(value?: string): PlaybackVideoCodec | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  if (/^(?:avc1|avc3|h264|h\.264)/.test(normalized)) return 'h264'
  if (/^(?:hev1|hvc1|hevc|h265|h\.265)/.test(normalized)) return 'hevc'
  if (/^(?:vp09|vp9)/.test(normalized)) return 'vp9'
  if (/^(?:vp08|vp8)/.test(normalized)) return 'vp8'
  if (/^(?:av01|av1)/.test(normalized)) return 'av1'
  if (/^(?:mp4v|mpeg4)/.test(normalized)) return 'mpeg4'
  return 'unknown'
}

function exactTokens(values?: string[]): string[] {
  return (values ?? [])
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase()))
    .filter((token) => /^(?:avc1|avc3|hev1|hvc1|av01|vp0[89]|mp4a|opus|vorbis|ac-?3|ec-?3|dts|flac)(?:[.\d]|$)/.test(token))
}

function profileSupports(media: MediaDescriptor, profile: PlaybackClientProfileV1): boolean {
  const transport = transportForMedia(media)
  const container = media.container
  if (container === 'unknown') return false
  const video = videoFamily(media.videoCodec)
  const audio = audioCodecFamily(media.audioCodec) as PlaybackAudioCodec | undefined
  const exact = exactTokens([media.videoCodec, media.audioCodec])
  return profile.mediaCapabilities.some((capability) => {
    if (capability.transport !== transport || capability.container !== container) return false
    if (!requiredPipelines(media).includes(capability.pipeline)) return false
    if (video && capability.videoCodec !== video) return false
    if (audio && capability.audioCodec !== audio) return false
    if (exact.length && capability.exactCodecStrings?.length) {
      const advertised = new Set(exactTokens(capability.exactCodecStrings))
      if (!exact.every((token) => advertised.has(token))) return false
    }
    return true
  })
}

function candidateSupports(media: MediaDescriptor, candidate: TransportCandidate, profile: PlaybackClientProfileV1): boolean {
  if (candidate.mode !== 'DIRECT' && !profile.supportsProviderProxy) return false
  return profileSupports(media, profile)
}

function planWithProfile(
  media: MediaDescriptor,
  profile: PlaybackClientProfileV1,
  candidates: TransportCandidate[],
): PlaybackPlan {
  if (media.drm?.protected) return blocked(`检测到 DRM：${media.drm.systems?.join(', ') || 'ContentProtection'}`)
  if (!profile.mediaCapabilities.length) return blocked('客户端明确没有声明可用的媒体能力')

  const viable = candidates
    .filter((candidate) => candidateSupports(media, candidate, profile))
    .sort((a, b) => (CANDIDATE_ORDER.get(a.mode) ?? 99) - (CANDIDATE_ORDER.get(b.mode) ?? 99))
  const selected = viable[0]
  if (!selected) return blocked('没有与当前容器、编解码器和播放管线同时匹配的候选路线')

  const proxy = selected.mode !== 'DIRECT'
  if (media.transport === 'hls') {
    return {
      engine: 'hls', mode: 'manifest', proxy, videoAction: 'direct', audioAction: 'direct',
      candidateUrl: selected.url, candidateMode: selected.mode,
      reasons: [proxy ? '客户端选择可行的 HLS 中转候选' : '客户端选择可行的 HLS 直连候选'],
    }
  }
  if (media.transport === 'dash') {
    return {
      engine: 'dash', mode: 'manifest', proxy, videoAction: 'direct', audioAction: 'direct',
      candidateUrl: selected.url, candidateMode: selected.mode, reasons: ['客户端选择可行的 DASH 候选'],
    }
  }
  if (media.transport === 'flv') {
    return {
      engine: 'flv', mode: 'manifest', proxy, videoAction: 'direct', audioAction: 'direct',
      candidateUrl: selected.url, candidateMode: selected.mode, reasons: ['客户端选择可行的 FLV 候选'],
    }
  }

  const usesPlaysVideo = ['mkv', 'ts', 'avi', 'wmv'].includes(media.container) ||
    (!!media.audioCodec && AUDIO_TRANSCODE_CODECS.has(media.audioCodec.toLowerCase()))
  if (usesPlaysVideo) {
    if (media.rangeSupported === false) return blocked('源站不支持 Range，playsvideo 无法保持同一媒体表示')
    const canPlay = profile.mediaCapabilities.some((capability) => capability.pipeline === 'playsvideo')
    if (!canPlay) return blocked('当前客户端没有可用的 playsvideo 管线')
    return {
      engine: 'playsvideo', mode: AUDIO_TRANSCODE_CODECS.has(media.audioCodec?.toLowerCase() ?? '') ? 'audio-transcode' : 'remux',
      proxy, videoAction: 'copy', audioAction: AUDIO_TRANSCODE_CODECS.has(media.audioCodec?.toLowerCase() ?? '') ? 'transcode-aac' : 'copy',
      candidateUrl: selected.url, candidateMode: selected.mode,
      reasons: ['客户端选择 playsvideo 兼容管线；表示和清晰度保持不变'],
    }
  }
  return {
    engine: 'direct', mode: 'direct', proxy, videoAction: 'direct', audioAction: 'direct',
    candidateUrl: selected.url, candidateMode: selected.mode,
    reasons: [proxy ? '客户端选择可行的同质量中转候选' : '客户端选择可行的同质量直连候选'],
  }
}

/**
 * Client-owned planner. The legacy overload remains for stored Phase 1 data;
 * new resolve responses pass the complete V1 profile and viable candidates.
 */
export function planPlayback(
  media: MediaDescriptor,
  profileOrCapabilities: PlaybackClientProfileV1 | ClientCapabilities = {},
  candidates?: TransportCandidate[],
): PlaybackPlan {
  if (!isPlaybackClientProfile(profileOrCapabilities)) return legacyPlanPlayback(media, profileOrCapabilities)
  const routes = candidates ?? media.transportPlan?.candidates ?? (media.finalUrl ? [{ mode: 'DIRECT', url: media.finalUrl, audioUrl: media.audioUrl }] : [])
  return planWithProfile(media, profileOrCapabilities, routes)
}
