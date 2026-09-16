import type { MusicQuality } from '../music-provider';

export type NcmCatalogSearchType = 'song' | 'playlist' | 'album' | 'artist';
export type NcmCatalogResourceType = 'song' | 'playlist' | 'album';
export type MusicCatalogResourceType = NcmCatalogResourceType;
export type NcmCatalogAvailability = 'available' | 'restricted' | 'unknown';

export interface MusicCatalogPage<T> {
  items: T[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
  total: number | null;
}

export interface MusicCatalogTrack {
  provider: 'ncm';
  trackId: string;
  sourceRef: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  durationMs: number | null;
  availability: NcmCatalogAvailability;
  availableQualities: MusicQuality[];
  availableMaximum: MusicQuality | null;
  liked: boolean | null;
}

export interface MusicCatalogPlaylist {
  provider: 'ncm';
  playlistId: string;
  title: string;
  description: string | null;
  creatorName: string | null;
  artworkUrl: string | null;
  trackCount: number | null;
  privacy: 'public' | 'private' | 'unknown';
}

export interface MusicCatalogPlaylistDetail {
  playlist: MusicCatalogPlaylist;
  tracks: MusicCatalogTrack[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
  total: number | null;
}

export interface MusicCatalogAlbum {
  provider: 'ncm';
  albumId: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  trackCount: number | null;
  description: string | null;
  tracks: MusicCatalogTrack[];
}

export interface MusicCatalogArtist {
  provider: 'ncm';
  artistId: string;
  name: string;
  artworkUrl: string | null;
  albumCount: number | null;
  trackCount: number | null;
  topTracks: MusicCatalogTrack[];
  albums: MusicCatalogAlbumSummary[];
}

export interface MusicCatalogArtistDetail {
  artist: MusicCatalogArtist;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  total: number | null;
}

export interface MusicCatalogAlbumSummary {
  provider: 'ncm';
  albumId: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  trackCount: number | null;
}

export interface MusicCatalogLyricsLine {
  timestampMs: number | null;
  text: string;
}

export interface MusicCatalogLyrics {
  provider: 'ncm';
  trackId: string;
  original: MusicCatalogLyricsLine[];
  translated: MusicCatalogLyricsLine[];
  romanized: MusicCatalogLyricsLine[];
}

export interface MusicCatalogComment {
  commentId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  createdAt: string | null;
  likedCount: number;
  liked: boolean | null;
}

export interface MusicCatalogCommentPage extends MusicCatalogPage<MusicCatalogComment> {
  mode: 'hot' | 'latest';
  resourceType: NcmCatalogResourceType;
  resourceId: string;
}

export interface NcmUpstreamResponse {
  code?: number;
  message?: string;
  msg?: string;
  data?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface NcmSearchRequest {
  keywords: string;
  type: NcmCatalogSearchType;
  offset: number;
  limit: number;
}

export interface NcmPageRequest {
  offset: number;
  limit: number;
}

export interface NcmCommentRequest extends NcmPageRequest {
  resourceType: NcmCatalogResourceType;
  resourceId: string;
  mode: 'hot' | 'latest';
}
