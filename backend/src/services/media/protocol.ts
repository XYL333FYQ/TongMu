import type { MediaContainer, MediaDescriptor, MediaTransport } from './types';
import type { PlaybackPipeline, PlaybackVideoCodec, PlaybackAudioCodec } from './playback-profile';

export type TransportMode = 'DIRECT' | 'MANIFEST_ASSISTED' | 'PARTIAL_PROXY' | 'FULL_PROXY';
export interface TransportCandidate { mode: TransportMode; url: string; audioUrl?: string }
export interface TransportPlan { candidates: TransportCandidate[]; reason: string }
/** Server-private resolved source. Never serialize this type as a public DTO. */
export type PrivateMediaSource = Pick<MediaDescriptor, 'input' | 'originalUrl' | 'finalUrl' | 'headers' | 'credentialOrigins'>;

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
}
export type PublicMediaDescriptor = Omit<MediaDescriptor, 'input' | 'originalUrl' | 'headers' | 'credentialOrigins' | 'candidates'> & {
  input: string; originalUrl: string; transportPlan?: TransportPlan;
};

export function publicTransportCandidate(candidate: PlaybackCandidate): TransportCandidate {
  return {
    mode: candidate.mode,
    url: candidate.url,
    audioUrl: candidate.audioUrl,
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
    .map((c: any) => ({ mode: c.mode, url: c.url, audioUrl: c.audioUrl && (c.audioUrl.startsWith('/api/stream/media/') || canPublishDirectUrl(c.audioUrl)) ? c.audioUrl : undefined })) };
}
