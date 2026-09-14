import { createHash } from 'node:crypto';
import type { MediaContainer, MediaDescriptor, MediaTransport } from './types';

export const CURRENT_PLAYBACK_PROFILE_VERSION = 1 as const;
export const MAX_PLAYBACK_MEDIA_CAPABILITIES = 64;
export const MAX_PLAYBACK_CODEC_STRINGS = 16;
export const MAX_PLAYBACK_STRING_LENGTH = 256;

export type PlaybackClientEnvironment = 'web' | 'desktop' | 'native' | 'mobile';
export type PlaybackPipeline = 'native' | 'mse' | 'managed-mse' | 'playsvideo';
export type PlaybackTransport = 'progressive' | 'hls' | 'dash' | 'flv' | 'mpeg-ts' | 'webrtc';
export type PlaybackContainer = Exclude<MediaContainer, 'unknown'>;
export type PlaybackVideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | 'mpeg4' | 'unknown';
export type PlaybackAudioCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'ac3' | 'eac3' | 'dts' | 'flac' | 'unknown';
export type PlaybackLiveTransport = 'hls' | 'flv' | 'webrtc';
export type PlaybackSubtitlePreference = 'external' | 'embedded-or-external' | 'none';

export interface PlaybackMediaCapabilityV1 {
  transport: PlaybackTransport;
  container: PlaybackContainer;
  videoCodec?: PlaybackVideoCodec;
  audioCodec?: PlaybackAudioCodec;
  pipeline: PlaybackPipeline;
  /** RFC 6381 tokens, usually one combined string or one token per entry. */
  exactCodecStrings?: string[];
  /** Whether this exact pipeline/tuple can attach custom upstream headers. */
  supportsCustomHeaders: boolean;
}

export interface PlaybackClientProfileV1 {
  profileVersion: typeof CURRENT_PLAYBACK_PROFILE_VERSION;
  environment: PlaybackClientEnvironment;
  mediaCapabilities: PlaybackMediaCapabilityV1[];
  supportsProviderProxy: boolean;
  supportsInsecureHttpMedia: boolean;
  mixedContentRestricted: boolean;
  maxStreamingBitrate?: number;
  maxAudioChannels?: number;
  subtitlePreference: PlaybackSubtitlePreference;
  liveTransports: PlaybackLiveTransport[];
  p2pExtension?: boolean;
}

export interface PlaybackCapabilityFacts {
  transport: PlaybackTransport;
  container: PlaybackContainer | 'unknown';
  videoCodec?: PlaybackVideoCodec;
  audioCodec?: PlaybackAudioCodec;
  exactCodecStrings?: string[];
  requiredPipelines: PlaybackPipeline[];
  requiresCustomHeaders?: boolean;
}

export class PlaybackProfileError extends Error {
  constructor(
    message: string,
    readonly code: 'MALFORMED_PROFILE' | 'UNSUPPORTED_PROFILE_VERSION',
  ) {
    super(message);
    this.name = 'PlaybackProfileError';
  }
}

const ENVIRONMENTS = new Set<PlaybackClientEnvironment>(['web', 'desktop', 'native', 'mobile']);
const PIPELINES = new Set<PlaybackPipeline>(['native', 'mse', 'managed-mse', 'playsvideo']);
const TRANSPORTS = new Set<PlaybackTransport>(['progressive', 'hls', 'dash', 'flv', 'mpeg-ts', 'webrtc']);
const CONTAINERS = new Set<PlaybackContainer>([
  'mp4', 'webm', 'mkv', 'avi', 'wmv', 'mov', 'flv', 'ts', 'hls', 'dash',
]);
const VIDEO_CODECS = new Set<PlaybackVideoCodec>(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'unknown']);
const AUDIO_CODECS = new Set<PlaybackAudioCodec>(['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'dts', 'flac', 'unknown']);
const LIVE_TRANSPORTS = new Set<PlaybackLiveTransport>(['hls', 'flv', 'webrtc']);
const SUBTITLE_PREFERENCES = new Set<PlaybackSubtitlePreference>(['external', 'embedded-or-external', 'none']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max = MAX_PLAYBACK_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PlaybackProfileError(`${field} must be a non-empty bounded string`, 'MALFORMED_PROFILE');
  }
  return value.trim();
}

function enumValue<T extends string>(value: unknown, set: Set<T>, field: string): T {
  if (typeof value !== 'string' || !set.has(value as T)) {
    throw new PlaybackProfileError(`${field} is not supported`, 'MALFORMED_PROFILE');
  }
  return value as T;
}

function boundedOptionalNumber(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new PlaybackProfileError(`${field} is outside the supported bound`, 'MALFORMED_PROFILE');
  }
  return value;
}

function booleanValue(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new PlaybackProfileError(`${field} must be boolean`, 'MALFORMED_PROFILE');
  }
  return value;
}

function normalizeCodecStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PLAYBACK_CODEC_STRINGS) {
    throw new PlaybackProfileError(`${field} must contain at most ${MAX_PLAYBACK_CODEC_STRINGS} items`, 'MALFORMED_PROFILE');
  }
  const normalized = value.map((item, index) => boundedString(item, `${field}[${index}]`, 128).toLowerCase());
  return [...new Set(normalized)].sort();
}

function capabilityKey(value: PlaybackMediaCapabilityV1): string {
  return JSON.stringify({
    transport: value.transport,
    container: value.container,
    videoCodec: value.videoCodec ?? null,
    audioCodec: value.audioCodec ?? null,
    pipeline: value.pipeline,
    exactCodecStrings: value.exactCodecStrings ?? [],
    supportsCustomHeaders: value.supportsCustomHeaders,
  });
}

function normalizeCapability(value: unknown, index: number): PlaybackMediaCapabilityV1 {
  if (!isRecord(value)) {
    throw new PlaybackProfileError(`mediaCapabilities[${index}] must be an object`, 'MALFORMED_PROFILE');
  }
  const videoCodec = value.videoCodec === undefined
    ? undefined
    : enumValue(value.videoCodec, VIDEO_CODECS, `mediaCapabilities[${index}].videoCodec`);
  const audioCodec = value.audioCodec === undefined
    ? undefined
    : enumValue(value.audioCodec, AUDIO_CODECS, `mediaCapabilities[${index}].audioCodec`);
  return {
    transport: enumValue(value.transport, TRANSPORTS, `mediaCapabilities[${index}].transport`),
    container: enumValue(value.container, CONTAINERS, `mediaCapabilities[${index}].container`),
    videoCodec,
    audioCodec,
    pipeline: enumValue(value.pipeline, PIPELINES, `mediaCapabilities[${index}].pipeline`),
    exactCodecStrings: normalizeCodecStrings(value.exactCodecStrings, `mediaCapabilities[${index}].exactCodecStrings`),
    supportsCustomHeaders: booleanValue(value.supportsCustomHeaders, `mediaCapabilities[${index}].supportsCustomHeaders`, false),
  };
}

function sortCapabilities(values: PlaybackMediaCapabilityV1[]): PlaybackMediaCapabilityV1[] {
  return [...values].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b)));
}

/** Conservative profile used for clients that predate the V1 request field. */
export function legacyPlaybackClientProfile(): PlaybackClientProfileV1 {
  const capability = (
    transport: PlaybackTransport,
    container: PlaybackContainer,
    pipeline: PlaybackPipeline,
    videoCodec?: PlaybackVideoCodec,
    audioCodec?: PlaybackAudioCodec,
  ): PlaybackMediaCapabilityV1 => ({
    transport,
    container,
    pipeline,
    videoCodec,
    audioCodec,
    supportsCustomHeaders: pipeline !== 'native',
  });
  return {
    profileVersion: CURRENT_PLAYBACK_PROFILE_VERSION,
    environment: 'web',
    mediaCapabilities: sortCapabilities([
      capability('progressive', 'mp4', 'native', 'h264', 'aac'),
      capability('progressive', 'webm', 'native', 'vp9', 'opus'),
      capability('hls', 'hls', 'native'),
      capability('hls', 'hls', 'mse'),
      capability('dash', 'dash', 'mse'),
      capability('flv', 'flv', 'mse'),
      capability('progressive', 'mkv', 'playsvideo', 'h264', 'aac'),
      capability('mpeg-ts', 'ts', 'playsvideo', 'h264', 'aac'),
    ]),
    supportsProviderProxy: true,
    supportsInsecureHttpMedia: true,
    mixedContentRestricted: false,
    subtitlePreference: 'external',
    liveTransports: ['flv', 'hls'],
  };
}

/** Validate and canonicalize the untrusted profile sent by a browser. */
export function validatePlaybackClientProfile(input: unknown): PlaybackClientProfileV1 {
  if (input === undefined || input === null) return legacyPlaybackClientProfile();
  if (!isRecord(input)) {
    throw new PlaybackProfileError('playback profile must be an object', 'MALFORMED_PROFILE');
  }
  const version = input.profileVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new PlaybackProfileError('profileVersion must be a positive integer', 'MALFORMED_PROFILE');
  }
  if (version > CURRENT_PLAYBACK_PROFILE_VERSION) {
    throw new PlaybackProfileError(`unsupported playback profile version: ${version}`, 'UNSUPPORTED_PROFILE_VERSION');
  }
  if (version !== CURRENT_PLAYBACK_PROFILE_VERSION) {
    throw new PlaybackProfileError(`unsupported playback profile version: ${version}`, 'UNSUPPORTED_PROFILE_VERSION');
  }
  if (!Array.isArray(input.mediaCapabilities) || input.mediaCapabilities.length > MAX_PLAYBACK_MEDIA_CAPABILITIES) {
    throw new PlaybackProfileError(`mediaCapabilities must contain at most ${MAX_PLAYBACK_MEDIA_CAPABILITIES} items`, 'MALFORMED_PROFILE');
  }
  const capabilities = sortCapabilities(
    [...new Map(input.mediaCapabilities.map((item, index) => {
      const normalized = normalizeCapability(item, index);
      return [capabilityKey(normalized), normalized] as const;
    })).values()],
  );
  if (capabilities.length > MAX_PLAYBACK_MEDIA_CAPABILITIES) {
    throw new PlaybackProfileError(`mediaCapabilities must contain at most ${MAX_PLAYBACK_MEDIA_CAPABILITIES} unique items`, 'MALFORMED_PROFILE');
  }
  if (!Array.isArray(input.liveTransports) || input.liveTransports.length > MAX_PLAYBACK_MEDIA_CAPABILITIES) {
    throw new PlaybackProfileError('liveTransports is outside the supported bound', 'MALFORMED_PROFILE');
  }
  const liveTransports = [...new Set(input.liveTransports.map((item, index) => enumValue(item, LIVE_TRANSPORTS, `liveTransports[${index}]`)))].sort();
  return {
    profileVersion: CURRENT_PLAYBACK_PROFILE_VERSION,
    environment: enumValue(input.environment, ENVIRONMENTS, 'environment'),
    mediaCapabilities: capabilities,
    supportsProviderProxy: booleanValue(input.supportsProviderProxy, 'supportsProviderProxy'),
    supportsInsecureHttpMedia: booleanValue(input.supportsInsecureHttpMedia, 'supportsInsecureHttpMedia'),
    mixedContentRestricted: booleanValue(input.mixedContentRestricted, 'mixedContentRestricted'),
    maxStreamingBitrate: boundedOptionalNumber(input.maxStreamingBitrate, 'maxStreamingBitrate', 100_000_000),
    maxAudioChannels: boundedOptionalNumber(input.maxAudioChannels, 'maxAudioChannels', 64),
    subtitlePreference: enumValue(input.subtitlePreference, SUBTITLE_PREFERENCES, 'subtitlePreference'),
    liveTransports,
    p2pExtension: input.p2pExtension === undefined ? undefined : booleanValue(input.p2pExtension, 'p2pExtension'),
  };
}

function canonicalProfile(profile: PlaybackClientProfileV1): string {
  return JSON.stringify({
    profileVersion: profile.profileVersion,
    environment: profile.environment,
    mediaCapabilities: sortCapabilities(profile.mediaCapabilities),
    supportsProviderProxy: profile.supportsProviderProxy,
    supportsInsecureHttpMedia: profile.supportsInsecureHttpMedia,
    mixedContentRestricted: profile.mixedContentRestricted,
    maxStreamingBitrate: profile.maxStreamingBitrate ?? null,
    maxAudioChannels: profile.maxAudioChannels ?? null,
    subtitlePreference: profile.subtitlePreference,
    liveTransports: [...profile.liveTransports].sort(),
    p2pExtension: profile.p2pExtension ?? null,
  });
}

/** Stable, credential-free cache identity for the complete profile semantics. */
export function playbackClientProfileFingerprint(profile: PlaybackClientProfileV1): string {
  return `pcp-v${profile.profileVersion}-${createHash('sha256').update(canonicalProfile(profile)).digest('hex')}`;
}

export function videoCodecFamily(value?: string): PlaybackVideoCodec | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  if (/^(?:avc1|avc3|h264|h\.264)/.test(normalized)) return 'h264';
  if (/^(?:hev1|hvc1|hevc|h265|h\.265)/.test(normalized)) return 'hevc';
  if (/^(?:vp09|vp9)/.test(normalized)) return 'vp9';
  if (/^(?:vp08|vp8)/.test(normalized)) return 'vp8';
  if (/^(?:av01|av1)/.test(normalized)) return 'av1';
  if (/^(?:mp4v|mpeg4)/.test(normalized)) return 'mpeg4';
  return 'unknown';
}

export function audioCodecFamily(value?: string): PlaybackAudioCodec | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  if (/^(?:mp4a|aac)/.test(normalized)) return 'aac';
  if (/^(?:mp3|mpeg)/.test(normalized)) return 'mp3';
  if (/^opus/.test(normalized)) return 'opus';
  if (/^vorbis/.test(normalized)) return 'vorbis';
  if (/^(?:ac-?3|ac3)/.test(normalized)) return 'ac3';
  if (/^(?:ec-?3|eac3)/.test(normalized)) return 'eac3';
  if (/^(?:dts|dca)/.test(normalized)) return 'dts';
  if (/^flac/.test(normalized)) return 'flac';
  return 'unknown';
}

export function playbackTransportForMedia(transport: MediaTransport): PlaybackTransport {
  if (transport === 'direct') return 'progressive';
  return transport;
}

function codecTokens(values?: string[]): string[] {
  return (values ?? []).flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase())).filter(Boolean);
}

function exactCodecMatches(capability: PlaybackMediaCapabilityV1, requested?: string[]): boolean {
  if (!requested?.length || !capability.exactCodecStrings?.length) return true;
  const advertised = new Set(codecTokens(capability.exactCodecStrings));
  return codecTokens(requested).every((token) => advertised.has(token));
}

/** Tuple matching never combines codecs from two different capability entries. */
export function profileSupportsCapability(
  profile: PlaybackClientProfileV1,
  facts: PlaybackCapabilityFacts,
): boolean {
  return profile.mediaCapabilities.some((capability) => {
    if (facts.container === 'unknown') return false;
    if (capability.transport !== facts.transport || capability.container !== facts.container) return false;
    if (!facts.requiredPipelines.includes(capability.pipeline)) return false;
    if (facts.videoCodec && capability.videoCodec !== facts.videoCodec) return false;
    if (facts.audioCodec && capability.audioCodec !== facts.audioCodec) return false;
    if (facts.requiresCustomHeaders && !capability.supportsCustomHeaders) return false;
    return exactCodecMatches(capability, facts.exactCodecStrings);
  });
}

export function capabilityFactsForDescriptor(
  descriptor: Pick<MediaDescriptor, 'transport' | 'container' | 'videoCodec' | 'audioCodec'>,
  requiredPipelines: PlaybackPipeline[],
  exactCodecStrings?: string[],
): PlaybackCapabilityFacts {
  const transport = descriptor.transport === 'direct' && descriptor.container === 'ts'
    ? 'mpeg-ts'
    : playbackTransportForMedia(descriptor.transport);
  return {
    transport,
    container: descriptor.container,
    videoCodec: videoCodecFamily(descriptor.videoCodec),
    audioCodec: audioCodecFamily(descriptor.audioCodec),
    exactCodecStrings,
    requiredPipelines,
  };
}
