import type { MediaContainer, MediaDescriptor, MediaTransport } from './types';
import type { PlaybackPipeline, PlaybackVideoCodec, PlaybackAudioCodec } from './playback-profile';
import type { MediaServerUpstreamMode } from './providers/media-server-types';

export type TransportMode = 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY';
export interface TransportCandidate {
  mode: TransportMode;
  url: string;
  audioUrl?: string;
  transport?: import('./playback-profile').PlaybackTransport;
  container?: import('./playback-profile').PlaybackContainer;
  videoCodec?: PlaybackVideoCodec;
  audioCodec?: PlaybackAudioCodec;
  exactCodecStrings?: string[];
  requiredPipelines?: PlaybackPipeline[];
  representationId?: string;
  upstreamMode?: MediaServerUpstreamMode;
  qualityPreserved?: boolean;
  qualityChanged?: boolean;
  audioTranscoded?: boolean;
  /** Opaque control capability; never a provider session id. */
  playbackSessionUrl?: string;
}
export interface TransportPlan { candidates: TransportCandidate[]; reason: string }
/** Server-private resolved source. Never serialize this type as a public DTO. */
export interface PrivateMediaSource {
  input: string;
  originalUrl: string;
  finalUrl: string;
  headers?: Record<string, string>;
  credentialOrigins?: string[];
  /** Provider identity and opaque server-only material for the media gateway. */
  providerId?: string;
  providerData?: Record<string, unknown>;
}

/**
 * Candidate facts used by the server viability filter. URL/header fields remain
 * private until the route has applied the filter and converted the result to a
 * small public TransportCandidate.
 */
export interface PlaybackCandidate {
  mode: TransportMode;
  url: string;
  audioUrl?: string;
  transport: MediaTransport;
  container: MediaContainer;
  videoCodec?: PlaybackVideoCodec;
  audioCodec?: PlaybackAudioCodec;
  exactCodecStrings?: string[];
  actualQuality?: number;
  requiredPipelines: PlaybackPipeline[];
  requiresCustomHeaders?: boolean;
  representationId?: string;
  upstreamMode?: MediaServerUpstreamMode;
  qualityPreserved?: boolean;
  qualityChanged?: boolean;
  audioTranscoded?: boolean;
  /** Server-private session binding, sealed before leaving the route. */
  session?: import('./providers/media-server-types').MediaServerSessionBinding;
  qualityIdentity?: {
    container: MediaContainer;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    bitrate?: number;
    audioChannels?: number;
  };
}
export type PublicMediaDescriptor = Omit<MediaDescriptor, 'input' | 'originalUrl' | 'headers' | 'credentialOrigins' | 'candidates'> & {
  input: string; originalUrl: string; transportPlan?: TransportPlan;
};

export function publicTransportCandidate(candidate: PlaybackCandidate, playbackSessionUrl?: string): TransportCandidate {
  return {
    mode: candidate.mode,
    url: candidate.url,
    audioUrl: candidate.audioUrl,
    transport: candidate.transport === 'direct' ? 'progressive' : candidate.transport,
    container: candidate.container === 'unknown' ? undefined : candidate.container,
    videoCodec: candidate.videoCodec,
    audioCodec: candidate.audioCodec,
    exactCodecStrings: candidate.exactCodecStrings,
    requiredPipelines: candidate.requiredPipelines,
    representationId: candidate.representationId,
    upstreamMode: candidate.upstreamMode,
    qualityPreserved: candidate.qualityPreserved,
    qualityChanged: candidate.qualityChanged,
    audioTranscoded: candidate.audioTranscoded,
    playbackSessionUrl,
  };
}

/** Public capability URLs may contain expiring signatures, never account/session secrets. */
export function canPublishDirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false;
    return ![...url.searchParams.keys()].some(key => /token|cookie|auth|password|secret|api.?key/i.test(key));
  } catch { return false; }
}
export function canDirect(media: MediaDescriptor): boolean {
  return !Object.keys(media.headers ?? {}).some(key => !/^accept(?:-language)?$/i.test(key)) &&
    canPublishDirectUrl(media.finalUrl) && (!media.audioUrl || canPublishDirectUrl(media.audioUrl));
}

/** Also applied to legacy persisted descriptors before any HTTP/Socket serialization. */
export function publicMetadata(value: unknown, depth = 0): any {
  if (depth > 12) return undefined;
  if (typeof value === 'string') {
    if (/^https?:/i.test(value) && !canPublishDirectUrl(value)) return undefined;
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => publicMetadata(item, depth + 1));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:input|originalUrl|sourceInput|headers|credentialOrigins|candidates|playbackPlan|cookie|authorization|password)$/i.test(key) && !/token|api.?key|secret/i.test(key))
    .map(([key, item]) => [key, key === 'transportPlan' ? publicTransportPlan(item) : publicMetadata(item, depth + 1)]));
}
function publicTransportPlan(value: any): TransportPlan | undefined {
  if (!Array.isArray(value?.candidates)) return undefined;
  return { reason: '客户端按顺序尝试同一媒体，保持原始质量', candidates: value.candidates
    .filter((c: any) => ['DIRECT', 'MANIFEST_ASSISTED', 'PARTIAL_PROXY', 'FULL_PROXY'].includes(c?.mode))
    .filter((c: any) => typeof c.url === 'string' && (c.url.startsWith('/api/stream/media/') || canPublishDirectUrl(c.url)))
    .map((c: any) => ({
      mode: c.mode,
      url: c.url,
      audioUrl: c.audioUrl && (c.audioUrl.startsWith('/api/stream/media/') || canPublishDirectUrl(c.audioUrl)) ? c.audioUrl : undefined,
      transport: typeof c.transport === 'string' ? c.transport : undefined,
      container: typeof c.container === 'string' ? c.container : undefined,
      videoCodec: typeof c.videoCodec === 'string' ? c.videoCodec : undefined,
      audioCodec: typeof c.audioCodec === 'string' ? c.audioCodec : undefined,
      exactCodecStrings: Array.isArray(c.exactCodecStrings) ? c.exactCodecStrings.filter((v: any) => typeof v === 'string').slice(0, 16) : undefined,
      requiredPipelines: Array.isArray(c.requiredPipelines) ? c.requiredPipelines.filter((v: any) => typeof v === 'string').slice(0, 8) : undefined,
      representationId: typeof c.representationId === 'string' ? c.representationId : undefined,
      upstreamMode: ['direct-play', 'direct-stream', 'transcode'].includes(c.upstreamMode) ? c.upstreamMode : undefined,
      qualityPreserved: typeof c.qualityPreserved === 'boolean' ? c.qualityPreserved : undefined,
      qualityChanged: typeof c.qualityChanged === 'boolean' ? c.qualityChanged : undefined,
      audioTranscoded: typeof c.audioTranscoded === 'boolean' ? c.audioTranscoded : undefined,
    })) };
}
