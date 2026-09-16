import { MAX_MUSIC_DURATION_MS } from '../types';
import {
  MUSIC_QUALITY_VALUES,
  isMusicQuality,
  type MusicQuality,
} from '../music-provider';
import { safePublicHttpUrl } from '../safe-url';
import { ncmApiClient } from './ncm-client';
import { NcmCredentialService, ncmCredentialService } from './ncm-credential.service';
import {
  NcmProviderError,
  type NcmClient,
  type NcmCredentialSecrets,
} from './types';
import type {
  MusicCatalogAlbum,
  MusicCatalogAlbumSummary,
  MusicCatalogArtist,
  MusicCatalogArtistDetail,
  MusicCatalogComment,
  MusicCatalogCommentPage,
  MusicCatalogLyrics,
  MusicCatalogLyricsLine,
  MusicCatalogPage,
  MusicCatalogPlaylist,
  MusicCatalogPlaylistDetail,
  MusicCatalogResourceType,
  MusicCatalogTrack,
  NcmCatalogSearchType,
  NcmCommentRequest,
  NcmPageRequest,
  NcmSearchRequest,
  NcmUpstreamResponse,
} from './catalog-types';

const ID_RE = /^[1-9][0-9]{0,19}$/;
const MAX_QUERY_LENGTH = 100;
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 100_000;
const MAX_ALBUM_TRACKS = 50;
const MAX_ARTIST_TOP_TRACKS = 50;
const MAX_FM_TRACKS = 20;
const MAX_LYRIC_LINES = 2_000;
const MAX_LYRIC_TEXT_LENGTH = 2_000;
const MAX_COMMENT_TEXT_LENGTH = 4_000;

export interface NcmCatalogPageInput {
  offset?: number;
  limit?: number;
}

export interface NcmCatalogSearchInput {
  query: string;
  type: NcmCatalogSearchType;
  offset?: number;
  limit?: number;
}

export interface NcmCatalogCommentInput {
  resourceType: MusicCatalogResourceType;
  resourceId: string;
  mode: 'hot' | 'latest';
  offset?: number;
  limit?: number;
}

export interface NcmCatalogCommentLikeInput {
  resourceType: MusicCatalogResourceType;
  resourceId: string;
  commentId: string;
  liked: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= maxLength ? text || null : null;
}

function positiveId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

function requiredId(value: unknown, label: string): string {
  const id = positiveId(value);
  if (!id) throw invalidResponse(`${label} ID 无效`);
  return id;
}

function finiteCount(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_OFFSET * MAX_PAGE_SIZE
    ? number
    : null;
}

function durationMs(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_MUSIC_DURATION_MS
    ? number
    : null;
}

function timestampMs(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 && number <= 4_102_444_800_000
    ? number
    : null;
}

function artistText(value: unknown): string {
  const direct = boundedText(value, 200);
  if (direct) return direct;
  if (!Array.isArray(value)) {
    const record = objectValue(value);
    return boundedText(record.name, 200) || '';
  }
  return value
    .map((entry) => boundedText(objectValue(entry).name, 80))
    .filter((name): name is string => !!name)
    .join(' / ')
    .slice(0, 200);
}

function safeArtwork(value: unknown): string | null {
  return safePublicHttpUrl(value, 2_048);
}

function qualityRank(value: MusicQuality): number {
  return MUSIC_QUALITY_VALUES.indexOf(value);
}

function qualityFacts(row: Record<string, unknown>): {
  availableQualities: MusicQuality[];
  availableMaximum: MusicQuality | null;
} {
  const raw = row.availableQualities ?? row.availableLevels ?? row.qualities;
  const values = Array.isArray(raw) ? raw.filter(isMusicQuality) : [];
  const qualities = values.filter((value, index) => values.indexOf(value) === index);
  const privilege = objectValue(row.privilege);
  const maximumBitrate = finiteCount(row.maxbr ?? privilege.maxbr);
  if (qualities.length === 0 && maximumBitrate !== null && maximumBitrate > 0) {
    const maximum = maximumBitrate >= 999_000
      ? 'hires'
      : maximumBitrate >= 320_000
        ? 'lossless'
        : maximumBitrate >= 192_000
          ? 'exhigh'
          : maximumBitrate >= 128_000
            ? 'higher'
            : 'standard';
    const maximumIndex = qualityRank(maximum);
    qualities.push(...MUSIC_QUALITY_VALUES.slice(0, maximumIndex + 1));
  }
  const actual = isMusicQuality(row.level) ? row.level : isMusicQuality(row.quality) ? row.quality : null;
  if (actual && !qualities.includes(actual)) qualities.push(actual);
  const maximum = qualities.length > 0
    ? qualities.reduce((best, value) => qualityRank(value) > qualityRank(best) ? value : best, qualities[0])
    : null;
  return { availableQualities: qualities, availableMaximum: maximum };
}

function normalizeTrack(value: unknown, likedOverride: boolean | null = null): MusicCatalogTrack {
  const source = objectValue(value);
  const simpleSong = objectValue(source.simpleSong);
  const row = Object.keys(simpleSong).length > 0 ? { ...simpleSong, ...source } : source;
  const trackId = positiveId(row.id ?? row.trackId);
  const title = boundedText(row.name ?? row.songName ?? row.title, 200);
  if (!trackId || !title) throw invalidResponse('歌曲条目结构无效');
  const album = firstObject(row.al ?? row.album);
  const quality = qualityFacts(row);
  const privilege = objectValue(row.privilege);
  const fee = finiteCount(row.fee);
  const restricted = fee === 1 || fee === 4 || (typeof privilege.st === 'number' && privilege.st !== 0);
  return {
    provider: 'ncm',
    trackId,
    sourceRef: `music://ncm/track/${trackId}`,
    title,
    artist: artistText(row.ar ?? row.artists ?? row.artist),
    album: artistText(row.al ?? row.album ?? row.albumName),
    artworkUrl: safeArtwork(row.picUrl ?? row.coverUrl ?? album.picUrl ?? objectValue(row.al).picUrl),
    durationMs: durationMs(row.dt ?? row.durationMs ?? row.duration),
    availability: restricted ? 'restricted' : 'available',
    availableQualities: quality.availableQualities,
    availableMaximum: quality.availableMaximum,
    liked: likedOverride !== null ? likedOverride : typeof row.liked === 'boolean' ? row.liked : null,
  };
}

function normalizePlaylist(value: unknown): MusicCatalogPlaylist {
  const row = objectValue(value);
  const playlistId = requiredId(row.id ?? row.playlistId, '歌单');
  const creator = firstObject(row.creator, row.user);
  const privacy = finiteCount(row.privacy);
  return {
    provider: 'ncm',
    playlistId,
    title: boundedText(row.name ?? row.title, 200) || '未命名歌单',
    description: optionalText(row.description ?? row.desc, 2_000),
    creatorName: boundedText(creator.nickname ?? creator.name, 200),
    artworkUrl: safeArtwork(row.coverImgUrl ?? row.coverUrl ?? row.picUrl),
    trackCount: finiteCount(row.trackCount ?? row.trackNumberUpdate ?? row.size),
    privacy: privacy === 10 || row.private === true ? 'private' : privacy === 0 ? 'public' : 'unknown',
  };
}

function normalizeAlbumSummary(value: unknown): MusicCatalogAlbumSummary {
  const row = objectValue(value);
  const albumId = requiredId(row.id ?? row.albumId, '专辑');
  return {
    provider: 'ncm',
    albumId,
    title: boundedText(row.name ?? row.title, 200) || '未命名专辑',
    artist: artistText(row.artist ?? row.artists),
    artworkUrl: safeArtwork(row.picUrl ?? row.coverUrl),
    trackCount: finiteCount(row.size ?? row.trackCount),
  };
}

function normalizeAlbum(value: unknown, songs: unknown[]): MusicCatalogAlbum {
  const row = objectValue(value);
  const summary = normalizeAlbumSummary(row);
  const tracks = songs.slice(0, MAX_ALBUM_TRACKS).map((song) => normalizeTrack(song));
  return {
    ...summary,
    description: optionalText(row.description ?? row.desc, 2_000),
    tracks,
  };
}

function normalizeArtist(value: unknown, topSongs: unknown[], albums: unknown[]): MusicCatalogArtist {
  const row = objectValue(value);
  const artistId = requiredId(row.id ?? row.artistId, '歌手');
  const name = boundedText(row.name ?? row.nickname, 200);
  if (!name) throw invalidResponse('歌手条目结构无效');
  return {
    provider: 'ncm',
    artistId,
    name,
    artworkUrl: safeArtwork(row.picUrl ?? row.coverUrl ?? row.img1v1Url),
    albumCount: finiteCount(row.albumSize ?? row.albumCount),
    trackCount: finiteCount(row.musicSize ?? row.trackCount),
    topTracks: topSongs.slice(0, MAX_ARTIST_TOP_TRACKS).map((song) => normalizeTrack(song)),
    albums: albums.slice(0, MAX_PAGE_SIZE).map((album) => normalizeAlbumSummary(album)),
  };
}

function invalidResponse(message: string): NcmProviderError {
  return new NcmProviderError('NCM_INVALID_RESPONSE', message, 502);
}

function checkResponse(body: NcmUpstreamResponse, label: string): NcmUpstreamResponse {
  const rawCode: unknown = body.code;
  const code = typeof rawCode === 'number'
    ? rawCode
    : typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? Number(rawCode) : undefined;
  if (code === 301 || code === 401) throw new NcmProviderError('NCM_NOT_LOGGED_IN', '网易云登录凭据已失效', 401);
  if (code === 404) throw new NcmProviderError('NCM_RESOURCE_NOT_FOUND', `${label}不存在`, 404);
  if (code === 429) throw new NcmProviderError('NCM_RATE_LIMITED', '网易云请求过于频繁，请稍后再试', 429);
  if (code !== undefined && code !== 0 && code !== 200) {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', `${label}接口返回失败`, 502);
  }
  return body;
}

function pageInput(input: NcmCatalogPageInput = {}): NcmPageRequest {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new NcmProviderError('MUSIC_INVALID_REQUEST', '分页参数无效', 400);
  }
  return { offset, limit };
}

function collection(root: Record<string, unknown>, key: string, label: string): unknown[] {
  if (!Array.isArray(root[key])) throw invalidResponse(`${label}列表结构无效`);
  return root[key] as unknown[];
}

function payloadRoot(body: NcmUpstreamResponse): Record<string, unknown> {
  const result = objectValue(body.result);
  if (Object.keys(result).length > 0) return result;
  const data = objectValue(body.data);
  if (Object.keys(data).length > 0) return data;
  return objectValue(body);
}

function arrayPayload(body: NcmUpstreamResponse, label: string): unknown[] {
  if (Array.isArray(body.data)) return body.data;
  const root = payloadRoot(body);
  for (const key of ['songs', 'tracks', 'playlist', 'playlists', 'data', 'cloudSongs']) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  throw invalidResponse(`${label}列表结构无效`);
}

function totalFrom(root: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteCount(root[key]);
    if (value !== null) return value;
  }
  return null;
}

function pageResult<T>(items: T[], input: NcmPageRequest, total: number | null): MusicCatalogPage<T> {
  return {
    items,
    offset: input.offset,
    pageSize: input.limit,
    hasMore: total === null ? items.length >= input.limit : input.offset + items.length < total,
    total,
  };
}

function trackIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => positiveId(entry) || positiveId(objectValue(entry).id))
    .filter((id): id is string => !!id);
}

function songsFrom(body: NcmUpstreamResponse, label: string): unknown[] {
  const root = payloadRoot(body);
  if (Array.isArray(root.songs)) return root.songs as unknown[];
  if (Array.isArray(root.tracks)) return root.tracks as unknown[];
  if (Array.isArray(body.data)) return body.data;
  throw invalidResponse(`${label}歌曲列表结构无效`);
}

function mergeHydratedTracks(ids: string[], songs: unknown[]): MusicCatalogTrack[] {
  const byId = new Map<string, MusicCatalogTrack>();
  for (const song of songs) {
    const normalized = normalizeTrack(song);
    if (!byId.has(normalized.trackId)) byId.set(normalized.trackId, normalized);
  }
  return ids
    .map((id) => byId.get(id))
    .filter((track): track is MusicCatalogTrack => !!track);
}

function lyricText(value: unknown): string {
  const row = objectValue(value);
  return typeof value === 'string' ? value : typeof row.lyric === 'string' ? row.lyric : '';
}

/** Parse LRC without interpreting markup; duplicate timestamps remain distinct. */
export function parseNcmLyricText(value: unknown): MusicCatalogLyricsLine[] {
  const source = lyricText(value);
  if (!source) return [];
  const lines: MusicCatalogLyricsLine[] = [];
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of source.split(/\r?\n/).slice(0, MAX_LYRIC_LINES)) {
    const line = rawLine.trim();
    if (!line) continue;
    timestamp.lastIndex = 0;
    const tags: number[] = [];
    const validRanges: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = timestamp.exec(line)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fractionText = match[3] || '0';
      const fraction = Number(fractionText.padEnd(3, '0').slice(0, 3));
      if (seconds < 60 && fraction < 1_000) {
        tags.push((minutes * 60 + seconds) * 1_000 + fraction);
        validRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
    let text = line;
    for (let index = validRanges.length - 1; index >= 0; index -= 1) {
      const range = validRanges[index];
      text = `${text.slice(0, range.start)}${text.slice(range.end)}`;
    }
    text = text.trim().slice(0, MAX_LYRIC_TEXT_LENGTH);
    if (!text) continue;
    if (tags.length === 0) {
      lines.push({ timestampMs: null, text });
    } else {
      for (const timestampMs of tags) lines.push({ timestampMs, text });
    }
  }
  return lines;
}

function commentRoot(body: NcmUpstreamResponse): Record<string, unknown> {
  const root = payloadRoot(body);
  return Array.isArray(root.comments) ? root : objectValue(body.data);
}

function normalizeComment(value: unknown): MusicCatalogComment {
  const row = objectValue(value);
  const user = firstObject(row.user, row.author);
  const commentId = requiredId(row.commentId ?? row.id, '评论');
  const text = boundedText(row.content ?? row.text, MAX_COMMENT_TEXT_LENGTH);
  if (!text) throw invalidResponse('评论条目结构无效');
  const time = timestampMs(row.time);
  return {
    commentId,
    authorName: boundedText(user.nickname ?? user.name, 200) || '网易云用户',
    authorAvatarUrl: safeArtwork(user.avatarUrl ?? user.avatar ?? user.picUrl),
    text,
    createdAt: time === null ? null : new Date(time).toISOString(),
    likedCount: finiteCount(row.likedCount ?? row.likeCount) || 0,
    liked: typeof row.liked === 'boolean' ? row.liked : null,
  };
}

export class NcmCatalogService {
  constructor(
    private readonly client: NcmClient = ncmApiClient,
    private readonly credentials: NcmCredentialService = ncmCredentialService,
  ) {}

  async search(input: NcmCatalogSearchInput, signal?: AbortSignal): Promise<MusicCatalogPage<MusicCatalogTrack | MusicCatalogPlaylist | MusicCatalogAlbumSummary | MusicCatalogArtist>> {
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > MAX_QUERY_LENGTH || !['song', 'playlist', 'album', 'artist'].includes(input?.type)) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '搜索关键词或类型无效', 400);
    }
    const page = pageInput(input);
    const request: NcmSearchRequest = { keywords: query, type: input.type, offset: page.offset, limit: page.limit };
    const body = checkResponse(await this.client.search(request, signal), '搜索');
    const root = payloadRoot(body);
    const key = input.type === 'song' ? 'songs' : input.type === 'playlist' ? 'playlists' : input.type === 'album' ? 'albums' : 'artists';
    const rawItems = collection(root, key, '搜索');
    const items: Array<MusicCatalogTrack | MusicCatalogPlaylist | MusicCatalogAlbumSummary | MusicCatalogArtist> = input.type === 'song'
      ? rawItems.map((item) => normalizeTrack(item))
      : input.type === 'playlist'
        ? rawItems.map((item) => normalizePlaylist(item))
        : input.type === 'album'
          ? rawItems.map((item) => normalizeAlbumSummary(item))
          : rawItems.map((item) => {
            const row = objectValue(item);
            const artistId = requiredId(row.id, '歌手');
            const name = boundedText(row.name, 200);
            if (!name) throw invalidResponse('搜索歌手条目结构无效');
            return {
              provider: 'ncm' as const,
              artistId,
              name,
              artworkUrl: safeArtwork(row.picUrl ?? row.img1v1Url),
              albumCount: finiteCount(row.albumSize),
              trackCount: finiteCount(row.musicSize),
              topTracks: [],
              albums: [],
            } satisfies MusicCatalogArtist;
          });
    const totalKey = input.type === 'song' ? 'songCount' : input.type === 'playlist' ? 'playlistCount' : input.type === 'album' ? 'albumCount' : 'artistCount';
    return pageResult(items, page, totalFrom(root, totalKey));
  }

  async getPlaylist(playlistId: string, input: NcmCatalogPageInput = {}, signal?: AbortSignal): Promise<MusicCatalogPlaylistDetail> {
    const id = requiredId(playlistId, '歌单');
    const page = pageInput(input);
    const body = checkResponse(await this.client.getPlaylistDetail(id, signal), '歌单');
    const root = payloadRoot(body);
    const playlistRow = firstObject(root.playlist, objectValue(body.data).playlist);
    if (Object.keys(playlistRow).length === 0) throw invalidResponse('歌单详情结构无效');
    const playlist = normalizePlaylist(playlistRow);
    const ids = trackIds(playlistRow.trackIds ?? playlistRow.tracks);
    const rawTracks = Array.isArray(playlistRow.tracks) ? playlistRow.tracks as unknown[] : [];
    const detailTotal = playlist.trackCount ?? (ids.length > 0 ? ids.length : rawTracks.length);
    const desiredCount = Math.min(page.limit, detailTotal ?? page.limit);
    let tracks: MusicCatalogTrack[] = [];
    if (rawTracks.length > page.offset && (rawTracks.length >= page.offset + desiredCount || ids.length === 0)) {
      tracks = rawTracks.slice(page.offset, page.offset + page.limit).map((item) => normalizeTrack(item));
    } else {
      const idsForPage = ids.slice(page.offset, page.offset + page.limit);
      if (idsForPage.length > 0) {
        const hydrated = checkResponse(await this.client.getSongDetails(idsForPage, signal), '歌单歌曲');
        tracks = mergeHydratedTracks(idsForPage, songsFrom(hydrated, '歌单'));
      }
    }
    const total = detailTotal;
    return {
      playlist,
      tracks,
      offset: page.offset,
      pageSize: page.limit,
      hasMore: total === null ? tracks.length >= page.limit : page.offset + tracks.length < total,
      total,
    };
  }

  async getAlbum(albumId: string, signal?: AbortSignal): Promise<MusicCatalogAlbum> {
    const id = requiredId(albumId, '专辑');
    const body = checkResponse(await this.client.getAlbumDetail(id, signal), '专辑');
    const root = payloadRoot(body);
    const albumRow = firstObject(root.album, objectValue(body.data).album);
    if (Object.keys(albumRow).length === 0) throw invalidResponse('专辑详情结构无效');
    const rawSongs = Array.isArray(root.songs) ? root.songs : Array.isArray(body.data) ? body.data : [];
    return normalizeAlbum(albumRow, rawSongs);
  }

  async getArtist(artistId: string, input: NcmCatalogPageInput = {}, signal?: AbortSignal): Promise<MusicCatalogArtistDetail> {
    const id = requiredId(artistId, '歌手');
    const page = pageInput(input);
    const [detailResponse, topResponse, albumResponse] = await Promise.all([
      this.client.getArtistDetail(id, signal),
      this.client.getArtistTopSongs(id, signal),
      this.client.getArtistAlbums({ artistId: id, ...page }, signal),
    ]);
    const detailBody = checkResponse(detailResponse, '歌手');
    const topBody = checkResponse(topResponse, '歌手热门歌曲');
    const albumBody = checkResponse(albumResponse, '歌手专辑');
    const detailRoot = payloadRoot(detailBody);
    const artistRow = firstObject(detailRoot.artist, objectValue(detailBody.data).artist, detailRoot);
    const topSongs = songsFrom(topBody, '歌手');
    const albumRoot = payloadRoot(albumBody);
    const albums = Array.isArray(albumRoot.hotAlbums)
      ? albumRoot.hotAlbums
      : Array.isArray(albumRoot.albums) ? albumRoot.albums : Array.isArray(albumBody.data) ? albumBody.data : [];
    const artist = normalizeArtist(artistRow, topSongs, albums);
    const total = artist.albumCount ?? totalFrom(albumRoot, 'albumCount', 'total') ?? albums.length;
    return {
      artist,
      offset: page.offset,
      pageSize: page.limit,
      hasMore: page.offset + artist.albums.length < total,
      total,
    };
  }

  private async ownCredential(userId: number): Promise<{ accountId: string; credential: NcmCredentialSecrets }> {
    const credential = await this.credentials.getPrivateCredential(userId);
    if (!credential) throw new NcmProviderError('NCM_NOT_LOGGED_IN', '请先登录网易云音乐', 409);
    const status = await this.credentials.getStatus(userId);
    if (!status.accountId) throw new NcmProviderError('NCM_PRIVATE_ACCOUNT_DATA', '网易云账号信息暂不可用', 502);
    return { accountId: status.accountId, credential };
  }

  async getPlaylists(userId: number, input: NcmCatalogPageInput = {}, signal?: AbortSignal): Promise<MusicCatalogPage<MusicCatalogPlaylist>> {
    const own = await this.ownCredential(userId);
    const page = pageInput(input);
    const body = checkResponse(await this.client.getUserPlaylists({ accountId: own.accountId, ...page }, own.credential, signal), '我的歌单');
    const root = payloadRoot(body);
    const raw = Array.isArray(root.playlist) ? root.playlist : Array.isArray(root.playlists) ? root.playlists : Array.isArray(body.data) ? body.data : null;
    if (!raw) throw invalidResponse('我的歌单列表结构无效');
    return pageResult(raw.map((item) => normalizePlaylist(item)), page, totalFrom(root, 'playlistCount', 'total'));
  }

  async getLiked(userId: number, input: NcmCatalogPageInput = {}, signal?: AbortSignal): Promise<MusicCatalogPage<MusicCatalogTrack>> {
    const own = await this.ownCredential(userId);
    const page = pageInput(input);
    const body = checkResponse(await this.client.getLikedSongs(own.accountId, own.credential, signal), '喜欢的歌曲');
    const root = payloadRoot(body);
    const direct = Array.isArray(root.songs) ? root.songs : Array.isArray(body.data) ? body.data : null;
    const allIds = trackIds(root.ids ?? root.trackIds);
    let items: MusicCatalogTrack[];
    let total = totalFrom(root, 'count', 'total') ?? (allIds.length > 0 ? allIds.length : null);
    if (direct) {
      items = direct.slice(page.offset, page.offset + page.limit).map((item) => normalizeTrack(item, true));
      total = total ?? direct.length;
    } else {
      const ids = allIds.slice(page.offset, page.offset + page.limit);
      if (ids.length === 0) items = [];
      else {
        const hydrated = checkResponse(await this.client.getSongDetails(ids, signal), '喜欢的歌曲');
        items = mergeHydratedTracks(ids, songsFrom(hydrated, '喜欢的歌曲')).map((item) => ({ ...item, liked: true }));
      }
    }
    return pageResult(items, page, total);
  }

  async getFm(userId: number, signal?: AbortSignal): Promise<MusicCatalogPage<MusicCatalogTrack>> {
    const own = await this.ownCredential(userId);
    const body = checkResponse(await this.client.getPersonalFm(own.credential, signal), '私人 FM');
    const items = arrayPayload(body, '私人 FM').slice(0, MAX_FM_TRACKS).map((item) => normalizeTrack(item));
    return pageResult(items, { offset: 0, limit: MAX_FM_TRACKS }, items.length);
  }

  async dislikeFm(userId: number, trackId: string, signal?: AbortSignal): Promise<{ accepted: true }> {
    const id = requiredId(trackId, 'FM 歌曲');
    const own = await this.ownCredential(userId);
    checkResponse(await this.client.trashFm(id, own.credential, signal), 'FM 操作');
    return { accepted: true };
  }

  async getCloud(userId: number, input: NcmCatalogPageInput = {}, signal?: AbortSignal): Promise<MusicCatalogPage<MusicCatalogTrack>> {
    const own = await this.ownCredential(userId);
    const page = pageInput(input);
    const body = checkResponse(await this.client.getCloudSongs(page, own.credential, signal), '云盘');
    const root = payloadRoot(body);
    const raw = arrayPayload(body, '云盘');
    const items = raw.slice(page.offset, page.offset + page.limit).map((item) => {
      const row = objectValue(item);
      return normalizeTrack(row.simpleSong ?? row.song ?? row);
    });
    return pageResult(items, page, totalFrom(root, 'count', 'total') ?? raw.length);
  }

  async getLyrics(trackId: string, signal?: AbortSignal): Promise<MusicCatalogLyrics> {
    const id = requiredId(trackId, '歌词');
    const body = checkResponse(await this.client.getLyrics(id, signal), '歌词');
    const root = payloadRoot(body);
    return {
      provider: 'ncm',
      trackId: id,
      original: parseNcmLyricText(root.lrc),
      translated: parseNcmLyricText(root.tlyric),
      romanized: parseNcmLyricText(root.romalrc),
    };
  }

  async getComments(input: NcmCatalogCommentInput, userId?: number, signal?: AbortSignal): Promise<MusicCatalogCommentPage> {
    if (!input || !['song', 'playlist', 'album'].includes(input.resourceType) || !['hot', 'latest'].includes(input.mode)) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '评论请求无效', 400);
    }
    const resourceId = requiredId(input.resourceId, '评论资源');
    const page = pageInput(input);
    const request: NcmCommentRequest = {
      resourceId,
      resourceType: input.resourceType,
      mode: input.mode,
      offset: page.offset,
      limit: page.limit,
    };
    let credential: NcmCredentialSecrets | undefined;
    if (userId) credential = (await this.ownCredential(userId)).credential;
    const body = checkResponse(await this.client.getComments(request, credential, signal), '评论');
    const root = commentRoot(body);
    if (!Array.isArray(root.comments)) throw invalidResponse('评论列表结构无效');
    const items = root.comments.map((comment) => normalizeComment(comment));
    const total = totalFrom(root, 'total', 'totalCount', 'commentCount');
    return {
      ...pageResult(items, page, total),
      mode: input.mode,
      resourceType: input.resourceType,
      resourceId,
    };
  }

  async likeTrack(userId: number, trackId: string, liked: boolean, signal?: AbortSignal): Promise<{ liked: boolean }> {
    if (typeof liked !== 'boolean') throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌曲点赞状态无效', 400);
    const id = requiredId(trackId, '歌曲');
    const own = await this.ownCredential(userId);
    checkResponse(await this.client.likeSong(id, liked, own.credential, signal), '歌曲点赞');
    return { liked };
  }

  async likeComment(userId: number, input: NcmCatalogCommentLikeInput, signal?: AbortSignal): Promise<{ liked: boolean }> {
    if (!input || !['song', 'playlist', 'album'].includes(input.resourceType) || typeof input.liked !== 'boolean') {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '评论点赞请求无效', 400);
    }
    const resourceId = requiredId(input.resourceId, '评论资源');
    const commentId = requiredId(input.commentId, '评论');
    const own = await this.ownCredential(userId);
    checkResponse(await this.client.likeComment({ ...input, resourceId, commentId }, own.credential, signal), '评论点赞');
    return { liked: input.liked };
  }
}

export const ncmCatalogService = new NcmCatalogService();
