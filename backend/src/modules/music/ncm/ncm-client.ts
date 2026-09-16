import * as http from 'node:http';
import QRCode from 'qrcode';
import { fetch, type Headers, type Response } from 'undici';
import { DEFAULT_PROXY_UA } from '../../../services/proxy';
import { isMusicQuality, type MusicCodec, type MusicQuality } from '../music-provider';
import {
  NcmProviderError,
  type NcmClient,
  type NcmCredentialSecrets,
  type NcmProfileFacts,
  type NcmQrCheckResult,
  type NcmQrCreateResult,
  type NcmTrackResolution,
} from './types';
import type {
  NcmCatalogResourceType,
  NcmCommentRequest,
  NcmPageRequest,
  NcmSearchRequest,
  NcmUpstreamResponse,
} from './catalog-types';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const QR_TTL_MS = 3 * 60 * 1000;
const STREAM_URL_DEFAULT_TTL_MS = 8 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const NCM_MAX_REQUEST_ATTEMPTS = 2;
const NCM_RETRY_DELAY_MS = 100;
const INTERNAL_API_BASE_PORT = 36_530;
const INTERNAL_API_PORT_RETRIES = 5;
const INTERNAL_API_LISTEN_TIMEOUT_MS = 8_000;

const ALLOWED_ENDPOINTS = new Set([
  '/login/qr/key',
  '/login/qr/create',
  '/login/qr/check',
  '/login/status',
  '/logout',
  '/song/url/v1',
  '/search',
  '/playlist/detail',
  '/playlist/track/all',
  '/song/detail',
  '/album',
  '/artist/detail',
  '/artist/top/song',
  '/artist/songs',
  '/artist/album',
  '/user/playlist',
  '/likelist',
  '/personal_fm',
  '/fm_trash',
  '/user/cloud',
  '/lyric',
  '/comment/music',
  '/comment/hot',
  '/comment/playlist',
  '/comment/album',
  '/comment/like',
  '/like',
]);

interface ServeNcmApiModule {
  serveNcmApi?: (options: {
    port: number;
    host: string;
    checkVersion: boolean;
  }) => Promise<{ server?: http.Server }>;
}

interface JsonResponse {
  code?: number;
  message?: string;
  msg?: string;
  data?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

const NCM_SEARCH_TYPES = {
  song: '1',
  album: '10',
  artist: '100',
  playlist: '1000',
} as const;

const NCM_COMMENT_TYPES: Record<NcmCatalogResourceType, string> = {
  song: '0',
  playlist: '2',
  album: '3',
};

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

function boundedAccountId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return boundedString(value, 128);
}

function artistString(value: unknown): string | null {
  const direct = boundedString(value, 200);
  if (direct) return direct;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return boundedString((value as Record<string, unknown>).name, 200);
  }
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) => entry && typeof entry === 'object'
      ? boundedString((entry as Record<string, unknown>).name, 80)
      : null)
    .filter((name): name is string => !!name);
  return names.length > 0 ? boundedString(names.join(' / '), 200) : null;
}

function profileFrom(value: unknown): NcmProfileFacts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const profile = record.profile && typeof record.profile === 'object'
    ? record.profile as Record<string, unknown>
    : record;
  const account = record.account && typeof record.account === 'object'
    ? record.account as Record<string, unknown>
    : {};
  const accountId = boundedAccountId(
    profile.userId ?? profile.id ?? account.id ?? account.userId,
  );
  const displayName = boundedString(
    profile.nickname ?? profile.userName ?? account.userName,
    200,
  );
  const avatarUrl = boundedString(profile.avatarUrl ?? profile.avatar ?? account.avatarUrl, 2048);
  if (!accountId && !displayName && !avatarUrl) return undefined;
  return { accountId, displayName, avatarUrl };
}

function cookieHeaderFromSetCookie(headers: Headers): string | undefined {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = getSetCookie
    ? getSetCookie.call(headers)
    : (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  const pairs = values
    .map((value) => value.split(';', 1)[0]?.trim() || '')
    .filter((value) => /^[^=;\s]{1,128}=[^;\r\n]{0,4096}$/.test(value));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function qualityList(value: unknown): MusicQuality[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isMusicQuality).filter((quality, index, list) => list.indexOf(quality) === index);
}

function codecFrom(value: unknown): { codec: MusicCodec; container: string; mimeType: string } {
  const raw = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (raw === 'mp3' || raw === 'mpeg') return { codec: 'mp3', container: 'mp3', mimeType: 'audio/mpeg' };
  if (raw === 'aac' || raw === 'adts') return { codec: 'aac', container: 'aac', mimeType: 'audio/aac' };
  if (raw === 'flac') return { codec: 'flac', container: 'flac', mimeType: 'audio/flac' };
  if (raw === 'wav' || raw === 'wave') return { codec: 'wav', container: 'wav', mimeType: 'audio/wav' };
  if (typeof value === 'string' && /^audio\//i.test(value)) {
    const mimeType = value.split(';', 1)[0].toLowerCase();
    if (mimeType === 'audio/mpeg') return { codec: 'mp3', container: 'mp3', mimeType };
    if (mimeType === 'audio/aac') return { codec: 'aac', container: 'aac', mimeType };
    if (mimeType === 'audio/flac') return { codec: 'flac', container: 'flac', mimeType };
    if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return { codec: 'wav', container: 'wav', mimeType };
  }
  return { codec: 'unknown', container: 'unknown', mimeType: 'audio/*' };
}

function expiryFromUrl(rawUrl: string): number {
  try {
    const parsed = new URL(rawUrl);
    const seconds = Number(parsed.searchParams.get('expires') || parsed.searchParams.get('expi'));
    if (Number.isSafeInteger(seconds) && seconds > Math.floor(Date.now() / 1000)) {
      return seconds * 1000;
    }
  } catch {
    // Provider validation reports the URL error later; keep this parser side-effect free.
  }
  return Date.now() + STREAM_URL_DEFAULT_TTL_MS;
}

function hasPreviewWindow(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && value !== 'null';
}

function safeQrImageDataUrl(value: unknown): string | null {
  const image = boundedString(value, 2 * 1024 * 1024);
  return image && /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image)
    ? image
    : null;
}

function safeQrUrl(value: unknown): string | null {
  const raw = boundedString(value, 2048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'ncm:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<JsonResponse> {
  const length = response.headers.get('content-length');
  if (length && Number.isSafeInteger(Number(length)) && Number(length) > MAX_JSON_BYTES) {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口响应过大');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_JSON_BYTES) {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口响应过大');
  }
  try {
    const value = JSON.parse(bytes.toString('utf8')) as JsonResponse;
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口响应格式无效');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForListening(server: http.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ncm api listen timeout'));
    }, INTERNAL_API_LISTEN_TIMEOUT_MS);
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      server.off('listening', onListening);
      server.off('error', onError);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

let internalServer: http.Server | null = null;
let internalBase = '';
let internalStart: Promise<string> | null = null;
let privateRequestSequence = 0;

async function startInternalApi(): Promise<string> {
  if (internalServer) return internalBase;
  if (internalStart) return internalStart;
  internalStart = (async () => {
    let moduleValue: ServeNcmApiModule;
    try {
      // The package is server-only and loaded lazily so deterministic tests can
      // inject a local fixture without starting an extra upstream service.
      moduleValue = require('@neteasecloudmusicapienhanced/api') as ServeNcmApiModule;
    } catch {
      throw new NcmProviderError('NCM_NOT_CONFIGURED', '网易云服务依赖不可用', 503);
    }
    if (typeof moduleValue.serveNcmApi !== 'function') {
      throw new NcmProviderError('NCM_NOT_CONFIGURED', '网易云服务接口不可用', 503);
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= INTERNAL_API_PORT_RETRIES; attempt += 1) {
      const port = INTERNAL_API_BASE_PORT + attempt;
      try {
        const app = await moduleValue.serveNcmApi({
          port,
          host: '127.0.0.1',
          checkVersion: false,
        });
        if (!app.server) throw new Error('ncm api server missing');
        await waitForListening(app.server);
        internalServer = app.server;
        internalBase = `http://127.0.0.1:${port}`;
        return internalBase;
      } catch (error) {
        lastError = error;
      }
    }
    throw new NcmProviderError(
      'NCM_NOT_CONFIGURED',
      lastError instanceof Error ? '网易云服务启动失败' : '网易云服务启动失败',
      503,
    );
  })();
  try {
    return await internalStart;
  } finally {
    if (internalStart && !internalServer) internalStart = null;
  }
}

function configuredBase(): string | null {
  const raw = process.env.NCM_API_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function apiBase(): Promise<string> {
  const configured = configuredBase();
  if (configured) return configured;
  if (process.env.NCM_API_BASE_URL?.trim()) {
    throw new NcmProviderError('NCM_NOT_CONFIGURED', '网易云服务地址配置无效', 503);
  }
  return startInternalApi();
}

async function fetchJson(
  path: string,
  query: Record<string, string | undefined> = {},
  credential?: NcmCredentialSecrets,
  signal?: AbortSignal,
): Promise<{ body: JsonResponse; response: Response }> {
  if (!ALLOWED_ENDPOINTS.has(path)) {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口未被允许');
  }
  const url = new URL(`${await apiBase()}${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': DEFAULT_PROXY_UA,
  };
  if (credential?.cookieHeader) headers.Cookie = credential.cookieHeader;
  if (credential?.csrfToken) headers['X-CSRF-Token'] = credential.csrfToken;
  if (credential?.csrfToken) url.searchParams.set('csrf_token', credential.csrfToken);
  // The bundled NCM server caches by URL and intentionally does not include
  // Cookie in its cache key. Private account requests therefore get a bounded
  // per-request key so one account cannot receive another account's response.
  if (credential) url.searchParams.set('_tongmu_cache_bust', `${Date.now()}-${++privateRequestSequence}`);
  const timeoutValue = Number(process.env.NCM_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(timeoutValue) && timeoutValue >= 1000 && timeoutValue <= 60_000
    ? timeoutValue
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < NCM_MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = !signal?.aborted;
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new NcmProviderError('NCM_CREDENTIAL_INVALID', '网易云登录凭据已失效', response.status);
        }
        if (response.status === 429) {
          throw new NcmProviderError('NCM_RATE_LIMITED', '网易云请求过于频繁，请稍后再试', 429);
        }
        if (response.status >= 500 && attempt + 1 < NCM_MAX_REQUEST_ATTEMPTS) {
          lastError = new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口请求失败');
        } else {
          retryable = false;
          throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口请求失败');
        }
      } else {
        return { body: await readJson(response), response };
      }
    } catch (error) {
      if (error instanceof NcmProviderError) lastError = error;
      else lastError = new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口暂不可用');
      if (!retryable || attempt + 1 >= NCM_MAX_REQUEST_ATTEMPTS) throw lastError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
    await delay(NCM_RETRY_DELAY_MS * (attempt + 1));
  }
  throw lastError instanceof NcmProviderError
    ? lastError
    : new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云接口暂不可用');
}

export class NcmApiClient implements NcmClient {
  async createQr(signal?: AbortSignal): Promise<NcmQrCreateResult> {
    const keyResponse = await fetchJson('/login/qr/key', {}, undefined, signal);
    const keyData = keyResponse.body.data && typeof keyResponse.body.data === 'object'
      ? keyResponse.body.data as Record<string, unknown>
      : {};
    const qrKey = boundedString(keyData.unikey ?? keyData.key, 512);
    if (!qrKey) throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云二维码 key 无效');
    const qrResponse = await fetchJson('/login/qr/create', { key: qrKey, qrimg: 'true' }, undefined, signal);
    const qrData = qrResponse.body.data && typeof qrResponse.body.data === 'object'
      ? qrResponse.body.data as Record<string, unknown>
      : {};
    const qrUrl = safeQrUrl(qrData.qrurl ?? qrData.qrUrl ?? qrData.url);
    const suppliedImage = safeQrImageDataUrl(qrData.qrimg ?? qrData.qrImageDataUrl);
    if (!qrUrl && !suppliedImage) throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云二维码数据无效');
    const qrImageDataUrl = suppliedImage || await QRCode.toDataURL(qrUrl!);
    return {
      qrKey,
      qrUrl: qrUrl || 'ncm://qr',
      qrImageDataUrl,
      expiresAt: Date.now() + QR_TTL_MS,
    };
  }

  async checkQr(qrKey: string, signal?: AbortSignal): Promise<NcmQrCheckResult> {
    const result = await fetchJson('/login/qr/check', { key: qrKey }, undefined, signal);
    const code = result.body.code ?? (result.body.data && typeof result.body.data === 'object'
      ? Number((result.body.data as Record<string, unknown>).code)
      : undefined);
    if (code === 800) return { status: 'expired' };
    if (code === 801) return { status: 'waiting' };
    if (code === 802) return { status: 'scanned' };
    if (code === 803) {
      const data = result.body.data;
      const cookieHeader = cookieHeaderFromSetCookie(result.response.headers) ||
        (data && typeof data === 'object' && typeof (data as Record<string, unknown>).cookie === 'string'
          ? String((data as Record<string, unknown>).cookie).split(';').map((part) => part.trim()).filter((part) => part.includes('=')).join('; ')
          : undefined);
      return { status: 'authorized', cookieHeader, profile: profileFrom(data) };
    }
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云二维码状态无效');
  }

  async getStatus(
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<{ loggedIn: boolean; profile?: NcmProfileFacts }> {
    const result = await fetchJson('/login/status', {}, credential, signal);
    return {
      loggedIn: result.body.code === 200,
      profile: result.body.code === 200 ? profileFrom(result.body.data) : undefined,
    };
  }

  async logout(credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<void> {
    await fetchJson('/logout', {}, credential, signal);
  }

  async resolveTrack(
    trackId: string,
    requestedQuality: MusicQuality,
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmTrackResolution> {
    const result = await fetchJson(
      '/song/url/v1',
      { id: trackId, level: requestedQuality },
      credential,
      signal,
    );
    if (result.body.code === 301 || result.body.code === 401) {
      throw new NcmProviderError('NCM_CREDENTIAL_INVALID', '网易云登录凭据已失效', 401);
    }
    if (result.body.code === 404) {
      throw new NcmProviderError('NCM_TRACK_NOT_FOUND', '网易云歌曲不存在', 404);
    }
    if (typeof result.body.code === 'number' && result.body.code !== 200) {
      throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云歌曲接口返回失败');
    }
    const data = Array.isArray(result.body.data) ? result.body.data[0] : undefined;
    const row = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const url = boundedString(row.url, 4096);
    const media = codecFrom(row.type ?? row.mime ?? row.mimetype);
    const rawAvailable = row.availableQualities ?? row.availableLevels ?? row.qualities;
    const availableQualities = qualityList(rawAvailable);
    const actualQuality = isMusicQuality(row.level ?? row.quality) ? (row.level ?? row.quality) as MusicQuality : null;
    if (actualQuality && !availableQualities.includes(actualQuality)) availableQualities.push(actualQuality);
    const availableMaximum = availableQualities.length > 0
      ? availableQualities.reduce<MusicQuality>((best, value) =>
        Math.max(0, (['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'dolby'] as readonly string[]).indexOf(value)) >
          Math.max(0, (['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'dolby'] as readonly string[]).indexOf(best)) ? value : best,
        availableQualities[0])
      : actualQuality;
    return {
      trackId,
      title: boundedString(row.name ?? row.songName, 200),
      artist: artistString(row.artist ?? row.ar),
      album: artistString(row.album ?? row.al ?? row.albumName),
      durationMs: Number.isSafeInteger(row.dt) && Number(row.dt) >= 0 ? Number(row.dt) : null,
      url,
      actualQuality,
      availableQualities,
      availableMaximum,
      codec: media.codec,
      container: media.container,
      mimeType: media.mimeType,
      expiresAt: url ? expiryFromUrl(url) : null,
      isPreview: hasPreviewWindow(row.freeTrialInfo),
    };
  }

  private async catalogRequest(
    path: string,
    query: Record<string, string | undefined> = {},
    credential?: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    const result = await fetchJson(path, query, credential, signal);
    return result.body;
  }

  async search(params: NcmSearchRequest, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    const type = NCM_SEARCH_TYPES[params.type];
    if (!type || params.keywords.length === 0 || params.keywords.length > 100 ||
        !Number.isSafeInteger(params.offset) || params.offset < 0 ||
        !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '网易云搜索参数无效', 400);
    }
    return this.catalogRequest('/search', {
      keywords: params.keywords,
      type,
      limit: String(params.limit),
      offset: String(params.offset),
    }, undefined, signal);
  }

  async getPlaylistDetail(playlistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/playlist/detail', { id: playlistId, s: '8' }, undefined, signal);
  }

  async getPlaylistTracks(
    params: NcmPageRequest & { playlistId: string },
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    if (!Number.isSafeInteger(params.offset) || params.offset < 0 ||
        !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌单分页参数无效', 400);
    }
    return this.catalogRequest('/playlist/track/all', {
      id: params.playlistId,
      limit: String(params.limit),
      offset: String(params.offset),
    }, undefined, signal);
  }

  async getSongDetails(trackIds: string[], signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    if (trackIds.length === 0 || trackIds.length > 50 ||
        trackIds.some((id) => !/^[1-9][0-9]{0,19}$/.test(id))) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌曲详情数量或 ID 无效', 400);
    }
    return this.catalogRequest('/song/detail', { ids: trackIds.join(',') }, undefined, signal);
  }

  async getAlbumDetail(albumId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/album', { id: albumId }, undefined, signal);
  }

  async getArtistDetail(artistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/artist/detail', { id: artistId }, undefined, signal);
  }

  async getArtistTopSongs(artistId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/artist/top/song', { id: artistId }, undefined, signal);
  }

  async getArtistSongs(
    params: NcmPageRequest & { artistId: string },
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    if (!Number.isSafeInteger(params.offset) || params.offset < 0 ||
        !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌手歌曲分页参数无效', 400);
    }
    return this.catalogRequest('/artist/songs', {
      id: params.artistId,
      limit: String(params.limit),
      offset: String(params.offset),
      order: 'hot',
    }, undefined, signal);
  }

  async getArtistAlbums(
    params: NcmPageRequest & { artistId: string },
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    if (!Number.isSafeInteger(params.offset) || params.offset < 0 ||
        !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '歌手专辑分页参数无效', 400);
    }
    return this.catalogRequest('/artist/album', {
      id: params.artistId,
      limit: String(params.limit),
      offset: String(params.offset),
    }, undefined, signal);
  }

  async getUserPlaylists(
    params: NcmPageRequest & { accountId: string },
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/user/playlist', {
      uid: params.accountId,
      limit: String(params.limit),
      offset: String(params.offset),
    }, credential, signal);
  }

  async getLikedSongs(
    accountId: string,
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/likelist', { uid: accountId }, credential, signal);
  }

  async getPersonalFm(credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/personal_fm', {}, credential, signal);
  }

  async trashFm(trackId: string, credential: NcmCredentialSecrets, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/fm_trash', { id: trackId, time: '25' }, credential, signal);
  }

  async getCloudSongs(
    params: NcmPageRequest,
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/user/cloud', {
      limit: String(params.limit),
      offset: String(params.offset),
    }, credential, signal);
  }

  async getLyrics(trackId: string, signal?: AbortSignal): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/lyric', { id: trackId }, undefined, signal);
  }

  async getComments(
    params: NcmCommentRequest,
    credential?: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    const query = {
      id: params.resourceId,
      limit: String(params.limit),
      offset: String(params.offset),
      before: '0',
    };
    if (params.mode === 'hot') {
      return this.catalogRequest('/comment/hot', {
        ...query,
        type: NCM_COMMENT_TYPES[params.resourceType],
      }, credential, signal);
    }
    const path = params.resourceType === 'song'
      ? '/comment/music'
      : params.resourceType === 'playlist'
        ? '/comment/playlist'
        : '/comment/album';
    return this.catalogRequest(path, query, credential, signal);
  }

  async likeSong(
    trackId: string,
    liked: boolean,
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/like', { id: trackId, like: String(liked) }, credential, signal);
  }

  async likeComment(
    params: {
      resourceType: NcmCatalogResourceType;
      resourceId: string;
      commentId: string;
      liked: boolean;
    },
    credential: NcmCredentialSecrets,
    signal?: AbortSignal,
  ): Promise<NcmUpstreamResponse> {
    return this.catalogRequest('/comment/like', {
      id: params.resourceId,
      cid: params.commentId,
      t: params.liked ? '1' : '0',
      type: NCM_COMMENT_TYPES[params.resourceType],
    }, credential, signal);
  }
}

export const ncmApiClient = new NcmApiClient();

export function stopNcmApiService(): void {
  const server = internalServer;
  internalServer = null;
  internalBase = '';
  internalStart = null;
  if (server) server.close();
}
