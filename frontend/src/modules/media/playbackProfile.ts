export const CURRENT_PLAYBACK_PROFILE_VERSION = 1 as const
export const MAX_PLAYBACK_MEDIA_CAPABILITIES = 64

export type PlaybackClientEnvironment = 'web' | 'desktop' | 'native' | 'mobile'
export type PlaybackPipeline = 'native' | 'mse' | 'managed-mse' | 'playsvideo'
export type PlaybackTransport = 'progressive' | 'hls' | 'dash' | 'flv' | 'mpeg-ts' | 'webrtc'
export type PlaybackContainer = 'mp4' | 'webm' | 'mkv' | 'avi' | 'wmv' | 'mov' | 'flv' | 'ts' | 'hls' | 'dash'
export type PlaybackVideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | 'mpeg4' | 'unknown'
export type PlaybackAudioCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'ac3' | 'eac3' | 'dts' | 'flac' | 'unknown'
export type PlaybackLiveTransport = 'hls' | 'flv' | 'webrtc'

export interface PlaybackMediaCapabilityV1 {
  transport: PlaybackTransport
  container: PlaybackContainer
  videoCodec?: PlaybackVideoCodec
  audioCodec?: PlaybackAudioCodec
  pipeline: PlaybackPipeline
  exactCodecStrings?: string[]
  supportsCustomHeaders: boolean
}

export interface PlaybackClientProfileV1 {
  profileVersion: typeof CURRENT_PLAYBACK_PROFILE_VERSION
  environment: PlaybackClientEnvironment
  mediaCapabilities: PlaybackMediaCapabilityV1[]
  supportsProviderProxy: boolean
  supportsInsecureHttpMedia: boolean
  mixedContentRestricted: boolean
  maxStreamingBitrate?: number
  maxAudioChannels?: number
  subtitlePreference: 'external' | 'embedded-or-external' | 'none'
  liveTransports: PlaybackLiveTransport[]
  p2pExtension?: boolean
}

export interface LegacyClientCapabilities {
  nativeHls?: boolean
  mediaSource?: boolean
  playsvideo?: boolean
  hevc?: boolean
}

const capabilityKey = (capability: PlaybackMediaCapabilityV1): string => JSON.stringify({
  ...capability,
  exactCodecStrings: [...(capability.exactCodecStrings ?? [])].sort(),
})

function addCapability(
  capabilities: Map<string, PlaybackMediaCapabilityV1>,
  capability: PlaybackMediaCapabilityV1,
): void {
  const normalized = {
    ...capability,
    exactCodecStrings: capability.exactCodecStrings?.map((value) => value.trim().toLowerCase()).filter(Boolean).sort(),
  }
  capabilities.set(capabilityKey(normalized), normalized)
}

function hasNativeSupport(video: HTMLVideoElement, mime: string): boolean {
  try {
    return video.canPlayType(mime) !== ''
  } catch {
    return false
  }
}

function mediaSourceSupports(mime: string): boolean {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)
  } catch {
    return false
  }
}

function managedMediaSource(): typeof MediaSource | undefined {
  const candidate = (globalThis as typeof globalThis & {
    ManagedMediaSource?: typeof MediaSource
  }).ManagedMediaSource
  return candidate
}

function hasPlaysVideoRuntime(): boolean {
  if (typeof window === 'undefined' || typeof Worker !== 'function' || typeof WebAssembly === 'undefined') return false
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640029,mp4a.40.2"')
  } catch {
    return false
  }
}

interface CodecProbe {
  container: PlaybackContainer
  transport: PlaybackTransport
  videoCodec: PlaybackVideoCodec
  audioCodec: PlaybackAudioCodec
  mime: string
  exactCodecStrings: string[]
}

const CODEC_PROBES: CodecProbe[] = [
  {
    container: 'mp4', transport: 'progressive', videoCodec: 'h264', audioCodec: 'aac',
    mime: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'],
  },
  {
    container: 'mp4', transport: 'progressive', videoCodec: 'hevc', audioCodec: 'aac',
    mime: 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"', exactCodecStrings: ['hvc1.1.6.l93.b0', 'mp4a.40.2'],
  },
  {
    container: 'mp4', transport: 'progressive', videoCodec: 'av1', audioCodec: 'aac',
    mime: 'video/mp4; codecs="av01.0.05M.08,mp4a.40.2"', exactCodecStrings: ['av01.0.05m.08', 'mp4a.40.2'],
  },
  {
    container: 'webm', transport: 'progressive', videoCodec: 'vp9', audioCodec: 'opus',
    mime: 'video/webm; codecs="vp09.00.10.08,opus"', exactCodecStrings: ['vp09.00.10.08', 'opus'],
  },
  {
    container: 'webm', transport: 'progressive', videoCodec: 'av1', audioCodec: 'opus',
    mime: 'video/webm; codecs="av01.0.05M.08,opus"', exactCodecStrings: ['av01.0.05m.08', 'opus'],
  },
]

function currentProtocol(): 'http' | 'https' {
  return typeof location !== 'undefined' && location.protocol === 'https:' ? 'https' : 'http'
}

function canonicalProfile(profile: PlaybackClientProfileV1): string {
  return JSON.stringify({
    ...profile,
    mediaCapabilities: [...profile.mediaCapabilities].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b))),
    liveTransports: [...profile.liveTransports].sort(),
  })
}

/** Deterministic, credential-free fingerprint for this browser session. */
export function playbackClientProfileFingerprint(profile: PlaybackClientProfileV1): string {
  let hash = 2166136261
  for (const character of canonicalProfile(profile)) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `pcp-v${profile.profileVersion}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Synchronous feature collection used by local playback and non-browser tests. */
export function collectPlaybackClientProfileSync(): PlaybackClientProfileV1 {
  const video = typeof document !== 'undefined' ? document.createElement('video') : undefined
  const capabilities = new Map<string, PlaybackMediaCapabilityV1>()
  const mediaSource = typeof MediaSource !== 'undefined'
  const managed = managedMediaSource()

  for (const probe of CODEC_PROBES) {
    if (video && hasNativeSupport(video, probe.mime)) {
      addCapability(capabilities, {
        transport: probe.transport,
        container: probe.container,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        pipeline: 'native',
        exactCodecStrings: probe.exactCodecStrings,
        supportsCustomHeaders: false,
      })
    }
    if (mediaSource && mediaSourceSupports(probe.mime)) {
      addCapability(capabilities, {
        transport: probe.transport,
        container: probe.container,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        pipeline: 'mse',
        exactCodecStrings: probe.exactCodecStrings,
        supportsCustomHeaders: true,
      })
    }
    if (managed && managed.isTypeSupported?.(probe.mime)) {
      addCapability(capabilities, {
        transport: probe.transport,
        container: probe.container,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        pipeline: 'managed-mse',
        exactCodecStrings: probe.exactCodecStrings,
        supportsCustomHeaders: true,
      })
    }
  }

  if (video && hasNativeSupport(video, 'application/vnd.apple.mpegurl')) {
    addCapability(capabilities, {
      transport: 'hls', container: 'hls', pipeline: 'native', supportsCustomHeaders: false,
    })
  }
  if (mediaSource) {
    addCapability(capabilities, { transport: 'hls', container: 'hls', pipeline: 'mse', supportsCustomHeaders: true })
    addCapability(capabilities, { transport: 'dash', container: 'dash', pipeline: 'mse', supportsCustomHeaders: true })
    addCapability(capabilities, { transport: 'flv', container: 'flv', pipeline: 'mse', supportsCustomHeaders: true })
  }
  if (managed) {
    addCapability(capabilities, { transport: 'hls', container: 'hls', pipeline: 'managed-mse', supportsCustomHeaders: true })
    addCapability(capabilities, { transport: 'dash', container: 'dash', pipeline: 'managed-mse', supportsCustomHeaders: true })
  }
  if (hasPlaysVideoRuntime()) {
    addCapability(capabilities, {
      transport: 'progressive', container: 'mkv', videoCodec: 'h264', audioCodec: 'aac',
      pipeline: 'playsvideo', exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'], supportsCustomHeaders: false,
    })
    addCapability(capabilities, {
      transport: 'mpeg-ts', container: 'ts', videoCodec: 'h264', audioCodec: 'aac',
      pipeline: 'playsvideo', exactCodecStrings: ['avc1.42e01e', 'mp4a.40.2'], supportsCustomHeaders: false,
    })
  }

  const protocol = currentProtocol()
  const liveTransports: PlaybackLiveTransport[] = []
  if ([...capabilities.values()].some((capability) => capability.transport === 'hls')) liveTransports.push('hls')
  if ([...capabilities.values()].some((capability) => capability.transport === 'flv')) liveTransports.push('flv')
  if (typeof RTCPeerConnection !== 'undefined') liveTransports.push('webrtc')

  return {
    profileVersion: CURRENT_PLAYBACK_PROFILE_VERSION,
    environment: 'web',
    mediaCapabilities: [...capabilities.values()].slice(0, MAX_PLAYBACK_MEDIA_CAPABILITIES),
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: protocol !== 'https',
    mixedContentRestricted: protocol === 'https',
    subtitlePreference: 'embedded-or-external',
    liveTransports,
  }
}

/**
 * MediaCapabilities is an optional refinement. A rejected/unsupported API is
 * deliberately ignored so one browser quirk cannot prevent media resolution.
 */
export async function collectPlaybackClientProfile(): Promise<PlaybackClientProfileV1> {
  const profile = collectPlaybackClientProfileSync()
  const mediaCapabilities = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined
  if (!mediaCapabilities?.decodingInfo) return profile
  const probe = CODEC_PROBES[0]
  try {
    const result = await mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: probe.mime, width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 },
      audio: { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: '2' },
    })
    if (result.supported && !profile.mediaCapabilities.some((capability) => capability.exactCodecStrings?.includes('avc1.42e01e'))) {
      profile.mediaCapabilities.push({
        transport: 'progressive', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
        pipeline: 'native', exactCodecStrings: probe.exactCodecStrings, supportsCustomHeaders: false,
      })
    }
  } catch {
    // Optional API failure is not a profile failure.
  }
  return profile
}

export function toLegacyClientCapabilities(profile: PlaybackClientProfileV1): LegacyClientCapabilities {
  return {
    nativeHls: profile.mediaCapabilities.some((capability) => capability.transport === 'hls' && capability.pipeline === 'native'),
    mediaSource: profile.mediaCapabilities.some((capability) => ['mse', 'managed-mse'].includes(capability.pipeline)),
    playsvideo: profile.mediaCapabilities.some((capability) => capability.pipeline === 'playsvideo'),
    hevc: profile.mediaCapabilities.some((capability) => capability.videoCodec === 'hevc'),
  }
}

export function audioCodecFamily(value?: string): PlaybackAudioCodec | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase().trim()
  if (/^(?:mp4a|aac)/.test(normalized)) return 'aac'
  if (/^(?:mp3|mpeg)/.test(normalized)) return 'mp3'
  if (/^opus/.test(normalized)) return 'opus'
  if (/^vorbis/.test(normalized)) return 'vorbis'
  if (/^(?:ac-?3|ac3)/.test(normalized)) return 'ac3'
  if (/^(?:ec-?3|eac3)/.test(normalized)) return 'eac3'
  if (/^(?:dts|dca)/.test(normalized)) return 'dts'
  if (/^flac/.test(normalized)) return 'flac'
  return 'unknown'
}

export function isPlaybackClientProfile(value: unknown): value is PlaybackClientProfileV1 {
  return !!value && typeof value === 'object' && (value as { profileVersion?: unknown }).profileVersion === CURRENT_PLAYBACK_PROFILE_VERSION
}
