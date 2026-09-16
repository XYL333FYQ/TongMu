import type { MusicCodec, MusicQuality } from '../music-provider';
import type {
  NcmCatalogResourceType,
  NcmCatalogSearchType,
  NcmCommentRequest,
  NcmPageRequest,
  NcmSearchRequest,
  NcmUpstreamResponse,
} from './catalog-types';

export type NcmQrStatus =
  | 'idle'
  | 'qr-created'
  | 'waiting'
  | 'scanned'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'logged-in';

export type NcmErrorCode =
  | 'NCM_NOT_CONFIGURED'
  | 'NCM_UPSTREAM_ERROR'
  | 'NCM_NOT_LOGGED_IN'
  | 'NCM_CREDENTIAL_INVALID'
  | 'NCM_QR_SESSION_NOT_FOUND'
  | 'NCM_QR_SESSION_EXPIRED'
  | 'NCM_QR_SESSION_REPLACED'
  | 'NCM_QUALITY_UNAVAILABLE'
  | 'NCM_STREAM_UNAVAILABLE'
  | 'NCM_TRACK_NOT_FOUND'
  | 'NCM_UNSUPPORTED_CODEC'
  | 'NCM_PRIVATE_ACCOUNT_DATA'
  | 'NCM_RATE_LIMITED'
  | 'NCM_PROVIDER_UNAVAILABLE'
  | 'NCM_RESOURCE_NOT_FOUND'
  | 'NCM_INVALID_RESPONSE'
  | 'MUSIC_TRACK_NOT_CURRENT'
  | 'MUSIC_CAPABILITY_INVALID'
  | 'MUSIC_ROOM_FORBIDDEN'
  | 'MUSIC_INVALID_REQUEST';

export class NcmProviderError extends Error {
  constructor(
    public readonly code: NcmErrorCode,
    message: string,
    public readonly status = 502,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NcmProviderError';
  }
}

export interface NcmProfileFacts {
  accountId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface NcmQrCreateResult {
  qrKey: string;
  qrUrl: string;
  qrImageDataUrl: string;
  expiresAt: number;
}

export interface NcmQrCheckResult {
  status: 'waiting' | 'scanned' | 'authorized' | 'expired';
  cookieHeader?: string;
  profile?: NcmProfileFacts;
}

export interface NcmCredentialSecrets {
  /** Cookie header used only by server-side NCM calls. */
  cookieHeader: string;
  csrfToken?: string;
}

export interface NcmTrackResolution {
  trackId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  url: string | null;
  actualQuality: MusicQuality | null;
  availableQualities: MusicQuality[];
  availableMaximum: MusicQuality | null;
  codec: MusicCodec;
  container: string;
  mimeType: string;
  expiresAt: number | null;
  /** Upstream returned only a preview/trial window rather than full playback. */
  isPreview?: boolean;
}

export interface NcmClient {
  createQr(signal?: AbortSignal): Promise<NcmQrCreateResult>;
  checkQr(qrKey: string, signal?: AbortSignal): Promise<NcmQrCheckResult>;
  getStatus(
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<{ loggedIn: boolean; profile?: NcmProfileFacts }>;
  logout(credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<void>;
  resolveTrack(
    trackId: string,
    requestedQuality: MusicQuality,
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmTrackResolution>;
  /** Explicit, bounded catalog modules. There is intentionally no generic call method. */
  search(params: NcmSearchRequest, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getPlaylistDetail(playlistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getPlaylistTracks(params: NcmPageRequest & { playlistId: string }, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getSongDetails(trackIds: string[], signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getAlbumDetail(albumId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getArtistDetail(artistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getArtistTopSongs(artistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getArtistSongs(params: NcmPageRequest & { artistId: string }, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getArtistAlbums(params: NcmPageRequest & { artistId: string }, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getUserPlaylists(params: NcmPageRequest & { accountId: string }, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getLikedSongs(accountId: string, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getPersonalFm(credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  trashFm(trackId: string, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getCloudSongs(params: NcmPageRequest, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getLyrics(trackId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  getComments(params: NcmCommentRequest, credential?: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  likeSong(trackId: string, liked: boolean, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
  likeComment(params: {
    resourceType: NcmCatalogResourceType;
    resourceId: string;
    commentId: string;
    liked: boolean;
  }, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse>;
}

export interface NcmCredentialStatusDto {
  provider: 'ncm';
  loggedIn: boolean;
  credentialValid: boolean;
  status: 'none' | 'logged-in' | 'invalid';
  accountId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  credentialVersion: number | null;
  updatedAt: string | null;
}

export interface NcmQrSessionDto {
  sessionId: string;
  status: NcmQrStatus;
  qrUrl?: string;
  qrImageDataUrl?: string;
  expiresAt: number;
  loggedIn: boolean;
  accountId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface NcmResolveDto {
  descriptor: import('../music-provider').MusicPublicDescriptor;
  playbackUrl: string;
  expiresAt: number;
}
