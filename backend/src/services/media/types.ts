export type MediaTransport = 'direct' | 'hls' | 'dash' | 'flv';

export type MediaContainer =
  | 'mp4'
  | 'webm'
  | 'mkv'
  | 'avi'
  | 'wmv'
  | 'mov'
  | 'flv'
  | 'ts'
  | 'hls'
  | 'dash'
  | 'unknown';

export interface MediaCandidate {
  url: string;
  score: number;
  reason: string;
  contentType?: string;
  qualityLabel?: string;
  headers?: Record<string, string>;
}

export interface DrmInfo {
  protected: boolean;
  systems?: string[];
  reason?: string;
}

/** Resolver、probe、planner 与播放器之间唯一的媒体事实对象。 */
export interface MediaDescriptor {
  title?: string;
  sourceType: string;
  resolver: string;
  input: string;
  originalUrl: string;
  finalUrl: string;
  audioUrl?: string;
  transport: MediaTransport;
  container: MediaContainer;
  contentType?: string;
  contentLength?: number;
  rangeSupported?: boolean;
  contentDisposition?: string;
  videoCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  audioCodec?: string;
  channels?: number;
  audioBitrate?: number;
  duration?: number;
  subtitles?: Array<{ url: string; language?: string; label?: string }>;
  sourceMaximumQuality?: number;
  availableMaximumQuality?: number;
  actualCodec?: string;
  actualBandwidth?: number;
  requestedQuality?: number;
  actualQuality?: number;
  qualityLabel?: string;
  loggedIn?: boolean;
  vip?: boolean;
  fallbackReason?: string;
  sourceMetadata?: {
    bilibili?: {
      cid: number;
      requestedQn?: number;
      actualQn?: number;
      preferMp4: boolean;
      availableQualities: Array<{ id: number; label: string; resolution?: string }>;
      qualityLabel?: string;
      videoCodec?: string;
      audioCodec?: string;
      videoBandwidth?: number;
      fallbackReason?: string;
      pages?: Array<{ page: number; cid: number; part: string; duration: number }>;
      currentPage?: number;
    };
  };
  drm: DrmInfo;
  expiresAt?: number;
  headers?: Record<string, string>;
  /** Internal-only credential provenance; stripped from public descriptors. */
  credentialOrigins?: string[];
  candidates?: MediaCandidate[];
  probe: {
    method: 'head' | 'range-get' | 'resolver';
    bytesRead: number;
    magic?: string;
    warnings: string[];
  };
}

export type PlaybackEngine = 'direct' | 'hls' | 'dash' | 'flv' | 'playsvideo' | 'blocked';

export interface ClientCapabilities {
  nativeHls?: boolean;
  mediaSource?: boolean;
  playsvideo?: boolean;
  hevc?: boolean;
}

export interface PlaybackPlan {
  engine: PlaybackEngine;
  mode: 'direct' | 'manifest' | 'remux' | 'audio-transcode' | 'unsupported';
  proxy: boolean;
  videoAction: 'direct' | 'copy' | 'transcode' | 'none';
  audioAction: 'direct' | 'copy' | 'transcode-aac' | 'none';
  reasons: string[];
}

export interface ResolverContext {
  userId: string;
  cookie?: string;
  browserSniff?: boolean;
  requestedQn?: number;
  preferMp4?: boolean;
  page?: number;
  cid?: number;
  signal?: AbortSignal;
  deadline?: number;
  roomId?: string;
  sourceGeneration?: number;
  playbackClientProfile?: import('./playback-profile').PlaybackClientProfileV1;
  credentialOwnerPolicy?: import('./providers/types').ProviderCredentialOwner;
}

export interface SourceResolver {
  readonly name: string;
  canHandle(input: string): boolean;
  resolve(input: string, context: ResolverContext): Promise<MediaDescriptor>;
}

export class ResolverNotApplicableError extends Error {
  constructor(message = 'resolver not applicable') {
    super(message);
    this.name = 'ResolverNotApplicableError';
  }
}
