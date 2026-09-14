import { randomUUID } from 'node:crypto';
import { assertProviderActive, type ProviderContext } from './types';
import {
  mediaServerRequest,
  mediaServerUrl,
  normalizeMediaServerUrl,
  type MediaServerHttpOptions,
} from './media-server-http';
import { mapMediaServerPlaybackInfo } from './media-server-client-mappers';
import type {
  MediaServerClient,
  MediaServerPlaybackInfo,
  MediaServerPlaybackRequest,
  MediaServerProviderId,
  MediaServerSessionBinding,
} from './media-server-types';
import type { UserMount } from '../../../entities/UserMount';

const EMBY_AUTHORIZATION = 'MediaBrowser Client="TongMu", Device="Web Browser", DeviceId="tongmu-emby-'
  + randomUUID() + '", Version="2.0.0"';

function endpointParts(serverUrl: string): { baseUrl: string; apiPrefix: string } {
  const normalized = normalizeMediaServerUrl(serverUrl, 'Emby');
  const parsed = new URL(normalized);
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (pathname.toLowerCase().endsWith('/emby')) return { baseUrl: normalized, apiPrefix: '' };
  return { baseUrl: normalized, apiPrefix: 'emby' };
}

function positionTicks(position: number): number {
  if (!Number.isFinite(position) || position < 0) return 0;
  return Math.min(Math.floor(position * 10_000_000), Number.MAX_SAFE_INTEGER);
}

function deviceProfile(context: ProviderContext): Record<string, unknown> {
  const directPlayProfiles = context.profile.mediaCapabilities.map((capability) => ({
    Container: capability.container,
    Type: 'Video',
    VideoCodec: capability.videoCodec,
    AudioCodec: capability.audioCodec,
    Protocol: capability.transport === 'progressive' ? 'http' : capability.transport,
  }));
  return {
    MaxStreamingBitrate: context.profile.maxStreamingBitrate,
    MaxStaticBitrate: context.profile.maxStreamingBitrate,
    DirectPlayProfiles: directPlayProfiles,
    TranscodingProfiles: [],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }, { Format: 'srt', Method: 'External' }],
  };
}

export interface EmbyProviderClientOptions {
  serverUrl: string;
  token?: string;
  userId?: string;
  context: ProviderContext;
}

export class EmbyProviderClient implements MediaServerClient {
  readonly providerId: MediaServerProviderId = 'emby';
  readonly baseUrl: string;
  readonly userId?: string;
  private readonly token?: string;
  private readonly http: MediaServerHttpOptions;
  private readonly deviceId = randomUUID();

  constructor(options: EmbyProviderClientOptions) {
    const parts = endpointParts(options.serverUrl);
    this.baseUrl = parts.baseUrl;
    this.token = options.token;
    this.userId = options.userId;
    this.http = {
      providerId: 'emby',
      baseUrl: parts.baseUrl,
      apiPrefix: parts.apiPrefix,
      token: options.token,
      userId: options.userId,
      context: options.context,
    };
  }

  private headers(): Record<string, string> {
    return { 'X-Emby-Authorization': EMBY_AUTHORIZATION };
  }

  authHeaders(): Record<string, string> {
    return {
      ...this.headers(),
      ...(this.token ? { 'X-Emby-Token': this.token } : {}),
    };
  }

  private async withContext(context?: ProviderContext): Promise<EmbyProviderClient> {
    if (!context || context === this.http.context) return this;
    return new EmbyProviderClient({
      serverUrl: this.baseUrl,
      token: this.token,
      userId: this.userId,
      context,
    });
  }

  async login(username: string, password: string, context = this.http.context): Promise<{ token: string; userId: string }> {
    assertProviderActive(context);
    const client = await this.withContext(context);
    const response = await mediaServerRequest<{
      AccessToken?: string;
      User?: { Id?: string };
    }>(client.http, 'Users/authenticatebyname', {
      method: 'POST',
      includeToken: false,
      headers: client.headers(),
      body: { Username: username, Pw: password },
    });
    if (!response.AccessToken || !response.User?.Id) throw new Error('Emby 登录未返回有效会话');
    return { token: response.AccessToken, userId: response.User.Id };
  }

  async currentUserId(context = this.http.context): Promise<string> {
    if (this.userId) return this.userId;
    const client = await this.withContext(context);
    const response = await mediaServerRequest<{ Id?: string }>(client.http, 'Users/Me', { headers: client.headers() });
    if (!response.Id) throw new Error('Emby 未返回用户身份');
    return response.Id;
  }

  async playbackInfo(request: MediaServerPlaybackRequest): Promise<MediaServerPlaybackInfo> {
    assertProviderActive(request.context);
    const response = await mediaServerRequest<unknown>(this.http, `Items/${encodeURIComponent(request.itemId)}/PlaybackInfo`, {
      method: 'POST',
      headers: this.headers(),
      query: { UserId: request.userId, reqformat: 'json' },
      body: {
        UserId: request.userId,
        MediaSourceId: request.mediaSourceId,
        MaxStreamingBitrate: request.profile.maxStreamingBitrate,
        MaxAudioChannels: request.profile.maxAudioChannels,
        EnableDirectPlay: true,
        EnableDirectStream: true,
        // Quality-changing provider transcode is disabled by default. The
        // caller must explicitly opt in through the generic policy.
        EnableTranscoding: request.allowTranscoding,
        DeviceProfile: deviceProfile(request.context),
      },
    });
    const mapped = mapMediaServerPlaybackInfo(response);
    if (!mapped.mediaSources.length) throw new Error('Emby 未返回可用媒体源');
    return mapped;
  }

  playbackUrl(itemId: string, mediaSourceId: string, mode: 'direct-play' | 'direct-stream' | 'transcode'): string {
    const path = `Videos/${encodeURIComponent(itemId)}/${mode === 'transcode' ? 'master.m3u8' : 'stream'}`;
    return mediaServerUrl(this.http, path, {
      static: mode !== 'transcode' ? true : undefined,
      MediaSourceId: mediaSourceId,
      VideoCodec: mode === 'transcode' ? 'h264' : undefined,
      AudioCodec: mode === 'transcode' ? 'aac' : undefined,
    });
  }

  async startPlayback(session: MediaServerSessionBinding, context: ProviderContext): Promise<void> {
    const client = await this.withContext(context);
    await mediaServerRequest<void>(client.http, 'Sessions/Playing', {
      method: 'POST', headers: client.headers(),
      body: { ItemId: session.itemId, MediaSourceId: session.mediaSourceId, PlaySessionId: session.playSessionId, PositionTicks: 0 },
    });
  }

  async reportProgress(session: MediaServerSessionBinding, position: number, paused: boolean, context: ProviderContext): Promise<void> {
    const client = await this.withContext(context);
    await mediaServerRequest<void>(client.http, 'Sessions/Playing/Progress', {
      method: 'POST', headers: client.headers(),
      body: { ItemId: session.itemId, MediaSourceId: session.mediaSourceId, PlaySessionId: session.playSessionId, PositionTicks: positionTicks(position), IsPaused: paused },
    });
  }

  async stopPlayback(session: MediaServerSessionBinding, position: number, context: ProviderContext): Promise<void> {
    const client = await this.withContext(context);
    await mediaServerRequest<void>(client.http, 'Sessions/Playing/Stopped', {
      method: 'POST', headers: client.headers(),
      body: { ItemId: session.itemId, PlaySessionId: session.playSessionId, PositionTicks: positionTicks(position) },
    });
  }

  async cleanupPlayback(session: MediaServerSessionBinding, context: ProviderContext): Promise<void> {
    const client = await this.withContext(context);
    await mediaServerRequest<void>(client.http, 'Videos/ActiveEncodings/Delete', {
      method: 'POST', headers: client.headers(),
      body: { DeviceId: client.deviceId, PlaySessionId: session.playSessionId },
    });
  }

  async subtitleContent(itemId: string, mediaSourceId: string, index: number, context: ProviderContext): Promise<string> {
    const client = await this.withContext(context);
    return mediaServerRequest<string>(client.http, `Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/Stream`, {
      headers: client.headers(), responseType: 'text',
    });
  }
}

export async function createEmbyProviderClient(
  mount: Pick<UserMount, 'serverUrl' | 'apiKey' | 'username' | 'password' | 'embyUserId'>,
  context: ProviderContext,
): Promise<EmbyProviderClient> {
  if (!mount.serverUrl) throw new Error('Emby 挂载未配置服务器地址');
  const cachedUserId = mount.embyUserId?.trim() || undefined;
  if (mount.apiKey?.trim()) {
    const client = new EmbyProviderClient({ serverUrl: mount.serverUrl, token: mount.apiKey.trim(), userId: cachedUserId, context });
    if (cachedUserId) return client;
    const userId = await client.currentUserId(context);
    return new EmbyProviderClient({ serverUrl: mount.serverUrl, token: mount.apiKey.trim(), userId, context });
  }
  if (!mount.username?.trim() || !mount.password) throw new Error('Emby 挂载缺少 API Key 或账号密码');
  const loginClient = new EmbyProviderClient({ serverUrl: mount.serverUrl, context });
  const login = await loginClient.login(mount.username.trim(), mount.password, context);
  return new EmbyProviderClient({ serverUrl: mount.serverUrl, token: login.token, userId: login.userId, context });
}
