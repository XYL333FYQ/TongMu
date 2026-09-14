import type { PlaybackClientProfileV1 } from '../playback-profile';
import type { ProviderContext } from './types';

export type MediaServerProviderId = 'emby' | 'jellyfin';
export type MediaServerUpstreamMode = 'direct-play' | 'direct-stream' | 'transcode';

export interface MediaServerStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | string;
  codec?: string;
  language?: string;
  title?: string;
  displayTitle?: string;
  displayLanguage?: string;
  isExternal?: boolean;
  deliveryMethod?: string;
  deliveryUrl?: string;
  isDefault?: boolean;
  isForced?: boolean;
  channels?: number;
  bitrate?: number;
}

export interface MediaServerMediaSource {
  id: string;
  name?: string;
  path?: string;
  protocol?: string;
  container?: string;
  size?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  runTimeTicks?: number;
  supportsDirectPlay?: boolean;
  supportsDirectStream?: boolean;
  supportsTranscoding?: boolean;
  directPlayUrl?: string;
  directStreamUrl?: string;
  transcodingUrl?: string;
  /** True only when the provider response proves elementary streams/quality stay unchanged. */
  directStreamPreservesQuality?: boolean;
  /** Explicit server facts for a quality-changing representation. */
  transcodingContainer?: string;
  transcodingVideoCodec?: string;
  transcodingAudioCodec?: string;
  transcodingWidth?: number;
  transcodingHeight?: number;
  transcodingBitrate?: number;
  mediaStreams: MediaServerStream[];
}

export interface MediaServerPlaybackInfo {
  playSessionId?: string;
  mediaSources: MediaServerMediaSource[];
}

export interface MediaServerSessionBinding {
  providerId: MediaServerProviderId;
  mountId: number;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  reference: string;
  actorUserId?: string;
  credentialOwnerId?: string;
  roomId?: string;
  movieId?: number;
  sourceGeneration?: number;
}

export interface MediaServerPlaybackRequest {
  itemId: string;
  userId: string;
  mediaSourceId?: string;
  profile: PlaybackClientProfileV1;
  allowTranscoding: boolean;
  context: ProviderContext;
}

export interface MediaServerClient {
  readonly providerId: MediaServerProviderId;
  readonly baseUrl: string;
  readonly userId?: string;
  authHeaders(): Record<string, string>;
  playbackInfo(request: MediaServerPlaybackRequest): Promise<MediaServerPlaybackInfo>;
  playbackUrl(itemId: string, mediaSourceId: string, mode: MediaServerUpstreamMode): string;
  startPlayback(session: MediaServerSessionBinding, context: ProviderContext): Promise<void>;
  reportProgress(session: MediaServerSessionBinding, position: number, paused: boolean, context: ProviderContext): Promise<void>;
  stopPlayback(session: MediaServerSessionBinding, position: number, context: ProviderContext): Promise<void>;
  cleanupPlayback(session: MediaServerSessionBinding, context: ProviderContext): Promise<void>;
  subtitleContent?(itemId: string, mediaSourceId: string, index: number, context: ProviderContext): Promise<string>;
}
