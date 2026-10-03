import type {
  MediaDescriptor,
  PlaybackPlan,
  PlaybackTransportCandidate,
} from './mediaApi'
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

const AUDIO_TRANSCODE_CODECS = new Set([
  'dts',
  'dca',
  'ac3',
  'eac3',
  'truehd',
  'flac',
])
const CANDIDATE_ORDER = new Map([
  ['DIRECT', 0],
  ['MANIFEST_ASSISTED', 1],
  ['PARTIAL_PROXY', 2],
  ['FULL_PROXY', 3],
])

type TransportCandidate = PlaybackTransportCandidate

function blocked(reason: string): PlaybackPlan {
  return {
    engine: 'blocked',
    mode: 'unsupported',
    proxy: false,
    videoAction: 'none',
    audioAction: 'none',
    reasons: [reason],
  }
}

function legacyPlanPlayback(
  media: MediaDescriptor,
  capabilities: ClientCapabilities = {}
): PlaybackPlan {
  if (media.drm?.protected)
    return blocked(
      `DRM detected: ${media.drm.systems?.join(', ') || 'ContentProtection'}`
    )
  const audioCodec = media.audioCodec?.toLowerCase()
  const videoCodec = media.videoCodec?.toLowerCase()
  if (
    videoCodec &&
    /^(?:hevc|h265|hev1|hvc1)/.test(videoCodec) &&
    capabilities.hevc === false
  ) {
    return blocked(
      'HEVC is unsupported in this browser and full video transcoding is disabled.'
    )
  }
  if (media.transport === 'hls') {
    if (capabilities.nativeHls === false && capabilities.mediaSource === false)
      return blocked(
        'This browser supports neither native HLS nor MediaSource.'
      )
    return {
      engine: 'hls',
      mode: 'manifest',
      proxy: false,
      videoAction: 'direct',
      audioAction: 'direct',
      reasons: [
        capabilities.nativeHls
          ? 'Native HLS playback is available.'
          : 'Using the HLS engine.',
      ],
    }
  }
  if (media.transport === 'dash') {
    if (capabilities.mediaSource === false)
      return blocked(
        'DASH requires MediaSource, which is unavailable in this browser.'
      )
    return {
      engine: 'dash',
      mode: 'manifest',
      proxy: false,
      videoAction: 'direct',
      audioAction: 'direct',
      reasons: ['Using the DASH engine.'],
    }
  }
  if (media.transport === 'flv') {
    if (capabilities.mediaSource === false)
      return blocked(
        'FLV requires MediaSource, which is unavailable in this browser.'
      )
    return {
      engine: 'flv',
      mode: 'manifest',
      proxy: false,
      videoAction: 'direct',
      audioAction: 'direct',
      reasons: ['Using the FLV engine.'],
    }
  }
  if (audioCodec && AUDIO_TRANSCODE_CODECS.has(audioCodec)) {
    if (media.rangeSupported === false)
      return blocked(
        'Audio conversion requires range requests, which this source does not support.'
      )
    if (capabilities.playsvideo === false)
      return blocked(
        'Audio conversion workers are unavailable in this browser.'
      )
    return {
      engine: 'playsvideo',
      mode: 'audio-transcode',
      proxy: false,
      videoAction: 'copy',
      audioAction: 'transcode-aac',
      reasons: [
        `${audioCodec.toUpperCase()} audio is unsupported; video is preserved and only audio is converted to AAC.`,
      ],
    }
  }
  if (['mkv', 'ts', 'avi', 'wmv'].includes(media.container)) {
    if (media.rangeSupported === false)
      return blocked(
        'Browser remuxing requires range requests, which this source does not support.'
      )
    if (capabilities.playsvideo === false)
      return blocked('Browser remuxing is unavailable in this browser.')
    return {
      engine: 'playsvideo',
      mode: 'remux',
      proxy: false,
      videoAction: 'copy',
      audioAction: 'copy',
      reasons: [
        `${media.container.toUpperCase()} is remuxed by the browser compatibility engine.`,
      ],
    }
  }
  return {
    engine: 'direct',
    mode: 'direct',
    proxy: false,
    videoAction: 'direct',
    audioAction: 'direct',
    reasons:
      media.rangeSupported === false
        ? ['Native sequential playback; seeking is unavailable on this source.']
        : ['Native direct playback.'],
  }
}

function transportForMedia(media: MediaDescriptor): PlaybackTransport {
  if (media.transport === 'direct' && media.container === 'ts') return 'mpeg-ts'
  return media.transport === 'direct' ? 'progressive' : media.transport
}

function requiredPipelines(media: MediaDescriptor): PlaybackPipeline[] {
  if (media.transport === 'hls') return ['native', 'mse', 'managed-mse']
  if (media.transport === 'dash' || media.transport === 'flv')
    return ['mse', 'managed-mse']
  if (['mkv', 'avi', 'wmv', 'ts'].includes(media.container))
    return ['native', 'playsvideo']
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
    .flatMap((value) =>
      value.split(',').map((token) => token.trim().toLowerCase())
    )
    .filter((token) =>
      /^(?:avc1|avc3|hev1|hvc1|av01|vp0[89]|mp4a|opus|vorbis|ac-?3|ec-?3|dts|flac)(?:[.\d]|$)/.test(
        token
      )
    )
}

function candidateSupports(
  media: MediaDescriptor,
  candidate: TransportCandidate,
  profile: PlaybackClientProfileV1
): boolean {
  if (candidate.mode !== 'DIRECT' && !profile.supportsProviderProxy)
    return false
  const transport = candidate.transport ?? transportForMedia(media)
  const container = candidate.container ?? media.container
  if (container === 'unknown') return false
  const video = candidate.videoCodec ?? videoFamily(media.videoCodec)
  const audio =
    candidate.audioCodec ??
    (audioCodecFamily(media.audioCodec) as PlaybackAudioCodec | undefined)
  const exact =
    candidate.exactCodecStrings ??
    exactTokens([media.videoCodec, media.audioCodec])
  const required = candidate.requiredPipelines ?? requiredPipelines(media)
  return profile.mediaCapabilities.some((capability) => {
    if (
      capability.transport !== transport ||
      capability.container !== container
    )
      return false
    if (!required.includes(capability.pipeline)) return false
    if (video && capability.videoCodec !== video) return false
    if (audio && capability.audioCodec !== audio) return false
    if (exact.length && capability.exactCodecStrings?.length) {
      const advertised = new Set(exactTokens(capability.exactCodecStrings))
      if (!exactTokens(exact).every((token) => advertised.has(token)))
        return false
    }
    return true
  })
}

function planWithProfile(
  media: MediaDescriptor,
  profile: PlaybackClientProfileV1,
  candidates: TransportCandidate[]
): PlaybackPlan {
  if (media.drm?.protected)
    return blocked(
      `DRM detected: ${media.drm.systems?.join(', ') || 'ContentProtection'}`
    )
  if (!profile.mediaCapabilities.length)
    return blocked('This browser reported no supported media capabilities.')

  const viable = candidates
    .filter((candidate) => candidateSupports(media, candidate, profile))
    .sort((a, b) => {
      const routeOrder =
        (CANDIDATE_ORDER.get(a.mode) ?? 99) -
        (CANDIDATE_ORDER.get(b.mode) ?? 99)
      if (routeOrder) return routeOrder
      const aUpstream =
        a.upstreamMode === 'transcode'
          ? 2
          : a.upstreamMode === 'direct-stream'
            ? 1
            : 0
      const bUpstream =
        b.upstreamMode === 'transcode'
          ? 2
          : b.upstreamMode === 'direct-stream'
            ? 1
            : 0
      return aUpstream - bUpstream
    })
  const selected = viable[0]
  if (!selected)
    return blocked(
      'No playback route supports this container, codec and browser pipeline together.'
    )

  const proxy = selected.mode !== 'DIRECT'
  const selectedTransport = selected.transport ?? transportForMedia(media)
  const selectedContainer = selected.container ?? media.container
  if (selectedTransport === 'hls') {
    return {
      engine: 'hls',
      mode: 'manifest',
      proxy,
      videoAction: 'direct',
      audioAction: 'direct',
      candidateUrl: selected.url,
      candidateMode: selected.mode,
      playbackSessionUrl: selected.playbackSessionUrl,
      upstreamMode: selected.upstreamMode,
      representationId: selected.representationId,
      qualityChanged: selected.qualityChanged,
      reasons: [
        selected.qualityChanged
          ? 'Using a provider transcode explicitly authorized by the user.'
          : proxy
            ? 'Using a supported HLS gateway route.'
            : 'Using a supported direct HLS route.',
      ],
    }
  }
  if (selectedTransport === 'dash') {
    return {
      engine: 'dash',
      mode: 'manifest',
      proxy,
      videoAction: 'direct',
      audioAction: 'direct',
      candidateUrl: selected.url,
      candidateMode: selected.mode,
      playbackSessionUrl: selected.playbackSessionUrl,
      upstreamMode: selected.upstreamMode,
      representationId: selected.representationId,
      qualityChanged: selected.qualityChanged,
      reasons: [
        selected.qualityChanged
          ? 'Using a provider transcode explicitly authorized by the user.'
          : 'Using a supported DASH route.',
      ],
    }
  }
  if (selectedTransport === 'flv') {
    return {
      engine: 'flv',
      mode: 'manifest',
      proxy,
      videoAction: 'direct',
      audioAction: 'direct',
      candidateUrl: selected.url,
      candidateMode: selected.mode,
      playbackSessionUrl: selected.playbackSessionUrl,
      upstreamMode: selected.upstreamMode,
      representationId: selected.representationId,
      qualityChanged: selected.qualityChanged,
      reasons: [
        selected.qualityChanged
          ? 'Using a provider transcode explicitly authorized by the user.'
          : 'Using a supported FLV route.',
      ],
    }
  }

  const selectedAudio =
    selected.audioCodec ??
    (audioCodecFamily(media.audioCodec) as PlaybackAudioCodec | undefined)
  const usesPlaysVideo =
    selected.requiredPipelines?.includes('playsvideo') === true ||
    ['mkv', 'ts', 'avi', 'wmv'].includes(selectedContainer) ||
    (!!selectedAudio &&
      AUDIO_TRANSCODE_CODECS.has(selectedAudio.toLowerCase())) ||
    selected.audioTranscoded === true
  if (usesPlaysVideo) {
    if (media.rangeSupported === false)
      return blocked(
        'This source lacks range support required to preserve the selected media representation.'
      )
    const canPlay = profile.mediaCapabilities.some(
      (capability) => capability.pipeline === 'playsvideo'
    )
    if (!canPlay)
      return blocked('The browser compatibility pipeline is unavailable.')
    return {
      engine: 'playsvideo',
      mode:
        selected.audioTranscoded ||
        AUDIO_TRANSCODE_CODECS.has(media.audioCodec?.toLowerCase() ?? '')
          ? 'audio-transcode'
          : 'remux',
      proxy,
      videoAction: 'copy',
      audioAction:
        selected.audioTranscoded ||
        AUDIO_TRANSCODE_CODECS.has(media.audioCodec?.toLowerCase() ?? '')
          ? 'transcode-aac'
          : 'copy',
      candidateUrl: selected.url,
      candidateMode: selected.mode,
      playbackSessionUrl: selected.playbackSessionUrl,
      upstreamMode: selected.upstreamMode,
      representationId: selected.representationId,
      qualityChanged: selected.qualityChanged,
      reasons: [
        selected.qualityChanged
          ? 'Using a provider transcode explicitly authorized by the user.'
          : 'Using the browser compatibility pipeline while preserving the selected video and quality.',
      ],
    }
  }
  return {
    engine: 'direct',
    mode: 'direct',
    proxy,
    videoAction: 'direct',
    audioAction: 'direct',
    candidateUrl: selected.url,
    candidateMode: selected.mode,
    playbackSessionUrl: selected.playbackSessionUrl,
    upstreamMode: selected.upstreamMode,
    representationId: selected.representationId,
    qualityChanged: selected.qualityChanged,
    reasons: [
      selected.qualityChanged
        ? 'Using a provider transcode explicitly authorized by the user.'
        : proxy
          ? 'Using a supported gateway route at the same quality.'
          : 'Using a supported direct route at the same quality.',
    ],
  }
}

/**
 * Client-owned planner. The legacy overload remains for stored Phase 1 data;
 * new resolve responses pass the complete V1 profile and viable candidates.
 */
export function planPlayback(
  media: MediaDescriptor,
  profileOrCapabilities: PlaybackClientProfileV1 | ClientCapabilities = {},
  candidates?: TransportCandidate[]
): PlaybackPlan {
  if (!isPlaybackClientProfile(profileOrCapabilities))
    return legacyPlanPlayback(media, profileOrCapabilities)
  const routes =
    candidates ??
    media.transportPlan?.candidates ??
    (media.finalUrl
      ? [{ mode: 'DIRECT', url: media.finalUrl, audioUrl: media.audioUrl }]
      : [])
  return planWithProfile(media, profileOrCapabilities, routes)
}
