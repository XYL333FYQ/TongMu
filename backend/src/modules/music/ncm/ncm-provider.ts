import { validateProxyUrl } from '../../../services/proxy/safe-fetch';
import { ncmCredentialService, NcmCredentialService } from './ncm-credential.service';
import { ncmApiClient } from './ncm-client';
import {
  CredentialedMusicProviderRegistry,
  isMusicQuality,
  type CredentialedMusicProvider,
  type CredentialedMusicProviderContext,
  type CredentialedMusicProviderResolution,
  type MusicQuality,
} from '../music-provider';
import {
  NcmProviderError,
  type NcmClient,
} from './types';

const NCM_TRACK_REF_RE = /^music:\/\/ncm\/track\/([1-9][0-9]{0,19})$/;
const NCM_HOST_SUFFIX = '.music.126.net';

function allowedNcmOrigin(url: URL): boolean {
  const configuredFixture = process.env.NODE_ENV === 'test'
    ? process.env.MEDIA_E2E_FIXTURE_ORIGIN?.trim()
    : undefined;
  if (configuredFixture) {
    try {
      if (url.origin === new URL(configuredFixture).origin) return true;
    } catch {
      // Invalid test configuration is not an allowlist entry.
    }
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'music.126.net' || hostname.endsWith(NCM_HOST_SUFFIX);
}

export function validateNcmAudioUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = validateProxyUrl(rawUrl);
  } catch {
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云音频地址无效');
  }
  if (!allowedNcmOrigin(parsed)) {
    // Do not let a compromised upstream response turn NCM resolve into an SSRF primitive.
    throw new NcmProviderError('NCM_UPSTREAM_ERROR', '网易云音频地址未被允许');
  }
  return parsed;
}

export function ncmTrackIdFromRef(sourceRef: string): string | null {
  return NCM_TRACK_REF_RE.exec(sourceRef)?.[1] || null;
}

export function ncmTrackRef(trackId: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(trackId)) throw new Error('NCM track id 无效');
  return `music://ncm/track/${trackId}`;
}

function distinctQualities(values: MusicQuality[]): MusicQuality[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export class NcmMusicProvider implements CredentialedMusicProvider {
  readonly providerId = 'ncm';

  constructor(
    private readonly client: NcmClient = ncmApiClient,
    private readonly credentials: NcmCredentialService = ncmCredentialService,
  ) {}

  canResolve(sourceRef: string): boolean {
    return NCM_TRACK_REF_RE.test(sourceRef);
  }

  async resolve(
    context: CredentialedMusicProviderContext,
    sourceRef: string,
  ): Promise<CredentialedMusicProviderResolution> {
    const trackId = ncmTrackIdFromRef(sourceRef);
    if (!trackId) throw new NcmProviderError('MUSIC_INVALID_REQUEST', 'NCM 歌曲引用无效', 400);
    if (!isMusicQuality(context.requestedQuality)) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', 'requestedQuality 无效', 400);
    }
    const credential = await this.credentials.getPrivateCredential(context.credentialOwnerId);
    if (!credential) throw new NcmProviderError('NCM_NOT_LOGGED_IN', '房主尚未登录网易云', 409);

    const track = await this.client.resolveTrack(
      trackId,
      context.requestedQuality,
      credential,
      context.signal,
    );
    const availableQualities = distinctQualities(track.availableQualities);
    const actualQuality = track.actualQuality;
    const availableMaximum = track.availableMaximum || actualQuality;
    if (track.isPreview) {
      throw new NcmProviderError('NCM_STREAM_UNAVAILABLE', '当前网易云账号只能播放试听片段', 403, {
        requestedQuality: context.requestedQuality,
        actualQuality,
        availableMaximum,
        availableQualities,
      });
    }
    if (!track.url || !actualQuality || actualQuality !== context.requestedQuality) {
      throw new NcmProviderError(
        'NCM_QUALITY_UNAVAILABLE',
        '请求的音质不可用，未自动切换到其他音质',
        409,
        {
          requestedQuality: context.requestedQuality,
          actualQuality,
          availableMaximum,
          availableQualities,
        },
      );
    }
    if (!availableQualities.includes(actualQuality)) availableQualities.push(actualQuality);
    if (!availableMaximum) {
      throw new NcmProviderError('NCM_QUALITY_UNAVAILABLE', '网易云未返回可用音质事实', 409);
    }
    validateNcmAudioUrl(track.url);
    if (track.codec === 'unknown' || !track.mimeType.startsWith('audio/')) {
      throw new NcmProviderError('NCM_UNSUPPORTED_CODEC', '当前音频编码无法安全播放', 415, {
        codec: track.codec,
        mimeType: track.mimeType,
      });
    }
    const expiresAt = track.expiresAt && track.expiresAt > Date.now()
      ? track.expiresAt
      : Date.now() + 60_000;
    return {
      privateSource: {
        provider: 'ncm',
        trackId,
        stableRef: ncmTrackRef(trackId),
        credentialOwnerId: context.credentialOwnerId,
        url: track.url,
        headers: { Cookie: credential.cookieHeader },
        requestedQuality: context.requestedQuality,
        actualQuality,
        availableQualities,
        availableMaximum,
        expiresAt,
        contentType: track.mimeType,
        codec: track.codec,
      },
      descriptor: {
        provider: 'ncm',
        trackId,
        sourceRef: ncmTrackRef(trackId),
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
        codec: track.codec,
        container: track.container,
        mimeType: track.mimeType,
        requestedQuality: context.requestedQuality,
        actualQuality,
        availableMaximum,
        availableQualities,
        availability: 'available',
        expiresAt,
      },
    };
  }
}

export const ncmMusicProvider = new NcmMusicProvider();

export const credentialedMusicProviderRegistry = new CredentialedMusicProviderRegistry();
credentialedMusicProviderRegistry.register(ncmMusicProvider);
