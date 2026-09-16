import type { Request, Response } from 'express';
import { IsNull, type DataSource } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import { Room } from '../../../entities/Room';
import { Session } from '../../../entities/Session';
import {
  issueMediaHandle,
  resolveMediaHandle,
  type MediaHandleResource,
  type RoomMediaGrant,
} from '../../../services/media/handles';
import { authorizeRoomMediaGrant } from '../../../services/media/room-access';
import { proxyHttpUpstream, type UpstreamHeaderOptions } from '../../../services/proxy/http-proxy';
import { musicSyncService, type MusicAuthoritativeTrack, type MusicSyncService } from '../music-sync.service';
import {
  isMusicQuality,
  type CredentialedMusicProviderRegistry,
  type CredentialedMusicProviderResolution,
  type MusicPublicDescriptor,
  type MusicQuality,
} from '../music-provider';
import { credentialedMusicProviderRegistry } from './ncm-provider';
import { ncmCredentialService, NcmCredentialService } from './ncm-credential.service';
import { NcmProviderError, type NcmResolveDto } from './types';

const CAPABILITY_TTL_MS = 5 * 60 * 1000;
const CAPABILITY_KIND = 'ncm-music-capability';

export interface MusicResolveRequest {
  roomId: string;
  roomGrant: string;
  queueItemId: number;
  sourceRef: string;
  musicGeneration: number;
  requestedQuality: MusicQuality;
}

interface MusicCapabilityClaims {
  kind: typeof CAPABILITY_KIND;
  roomId: string;
  socketId: string;
  actorUserId: number | null;
  credentialOwnerId: number;
  credentialVersion: number;
  queueItemId: number;
  sourceRef: string;
  musicGeneration: number;
  requestedQuality: MusicQuality;
}

interface AuthorizedActor {
  room: Room;
  session: Session;
  grant: RoomMediaGrant;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCapabilityClaims(value: unknown): value is MusicCapabilityClaims {
  if (!value || typeof value !== 'object') return false;
  const claim = value as Partial<MusicCapabilityClaims>;
  return claim.kind === CAPABILITY_KIND &&
    typeof claim.roomId === 'string' && claim.roomId.length <= 128 &&
    typeof claim.socketId === 'string' && claim.socketId.length <= 256 &&
    (claim.actorUserId === null || isPositiveInteger(claim.actorUserId)) &&
    isPositiveInteger(claim.credentialOwnerId) &&
    isPositiveInteger(claim.credentialVersion) &&
    isPositiveInteger(claim.queueItemId) &&
    typeof claim.sourceRef === 'string' && claim.sourceRef.length <= 512 &&
    typeof claim.musicGeneration === 'number' && Number.isSafeInteger(claim.musicGeneration) && claim.musicGeneration >= 0 &&
    isMusicQuality(claim.requestedQuality);
}

function publicDescriptor(
  resolution: CredentialedMusicProviderResolution,
  track: MusicAuthoritativeTrack,
): MusicPublicDescriptor {
  const item = track.currentItem;
  return {
    ...resolution.descriptor,
    title: resolution.descriptor.title || item?.title || null,
    artist: resolution.descriptor.artist || item?.artist || null,
    album: resolution.descriptor.album || item?.album || null,
    durationMs: resolution.descriptor.durationMs ?? item?.durationMs ?? null,
  };
}

function ncmHeaders(source: CredentialedMusicProviderResolution['privateSource']): UpstreamHeaderOptions {
  return {
    cookie: source.headers?.Cookie,
    referer: 'https://music.163.com/',
  };
}

/**
 * Converts the current MusicSyncDomain fact into a short-lived, actor-bound
 * gateway capability. Provider resolution is repeated at stream time, so a
 * signed CDN URL is never persisted in the handle or queue.
 */
export class MusicPlaybackService {
  constructor(
    private readonly dataSource: DataSource = AppDataSource,
    private readonly music: MusicSyncService = musicSyncService,
    private readonly providers: CredentialedMusicProviderRegistry = credentialedMusicProviderRegistry,
    private readonly credentials: NcmCredentialService = ncmCredentialService,
  ) {}

  private async authorizeActor(roomId: string, token: string | undefined): Promise<AuthorizedActor> {
    if (!token) throw new NcmProviderError('MUSIC_ROOM_FORBIDDEN', '需要当前房间成员授权', 403);
    const grant = await authorizeRoomMediaGrant(
      token,
      roomId,
      async (grantRoomId, socketId) => !!await this.dataSource.getRepository(Session).findOneBy({
        roomId: grantRoomId,
        socketId,
        endedAt: IsNull(),
      }),
    );
    if (!grant) throw new NcmProviderError('MUSIC_ROOM_FORBIDDEN', '房间成员授权已失效', 403);
    const [room, session] = await Promise.all([
      this.dataSource.getRepository(Room).findOneBy({ roomId, status: 'active' }),
      this.dataSource.getRepository(Session).findOneBy({ roomId, socketId: grant.socketId, endedAt: IsNull() }),
    ]);
    if (!room || !session) throw new NcmProviderError('MUSIC_ROOM_FORBIDDEN', '房间成员授权已失效', 403);
    return { room, session, grant };
  }

  private async ownerId(room: Room): Promise<number> {
    if (isPositiveInteger(room.ownerUserId)) return room.ownerUserId;
    const host = await this.dataSource.getRepository(Session).findOneBy({
      roomId: room.roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (host && isPositiveInteger(host.userId)) return host.userId;
    throw new NcmProviderError('NCM_NOT_LOGGED_IN', '房间没有可用的网易云账号', 409);
  }

  private async currentResolution(
    actor: AuthorizedActor,
    claims: MusicCapabilityClaims,
  ): Promise<{ resolution: CredentialedMusicProviderResolution; track: MusicAuthoritativeTrack }> {
    if (actor.grant.roomId !== claims.roomId || actor.grant.socketId !== claims.socketId) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐播放授权不属于当前成员', 403);
    }
    const actorUserId = actor.session.userId ?? null;
    if (actorUserId !== claims.actorUserId) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐播放授权身份已变化', 403);
    }
    const ownerUserId = await this.ownerId(actor.room);
    if (ownerUserId !== claims.credentialOwnerId) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '房间音乐账号已变化', 403);
    }
    const credentialVersion = await this.credentials.getCredentialVersion(ownerUserId);
    if (credentialVersion !== claims.credentialVersion) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐账号授权已失效', 403);
    }
    const track = await this.music.getAuthoritativeTrack(actor.room.roomId);
    if (track.queueItemId !== claims.queueItemId ||
        track.sourceRef !== claims.sourceRef ||
        track.musicGeneration !== claims.musicGeneration) {
      throw new NcmProviderError('MUSIC_TRACK_NOT_CURRENT', '当前歌曲已切换，旧播放授权已失效', 409);
    }
    const provider = this.providers.findFor(claims.sourceRef);
    if (!provider || provider.providerId !== 'ncm') {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐 provider 不受支持', 400);
    }
    const resolution = await provider.resolve({
      roomId: actor.room.roomId,
      userId: actorUserId,
      credentialOwnerId: ownerUserId,
      requestedQuality: claims.requestedQuality,
    }, claims.sourceRef);
    return { resolution, track };
  }

  async resolve(request: MusicResolveRequest): Promise<NcmResolveDto> {
    if (!request.roomId || !request.sourceRef || !isPositiveInteger(request.queueItemId) ||
        !Number.isSafeInteger(request.musicGeneration) || request.musicGeneration < 0 ||
        !isMusicQuality(request.requestedQuality)) {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '音乐解析请求无效', 400);
    }
    const actor = await this.authorizeActor(request.roomId, request.roomGrant);
    const track = await this.music.getAuthoritativeTrack(request.roomId);
    if (track.queueItemId !== request.queueItemId ||
        track.sourceRef !== request.sourceRef ||
        track.musicGeneration !== request.musicGeneration) {
      throw new NcmProviderError('MUSIC_TRACK_NOT_CURRENT', '只能解析房间当前歌曲', 409);
    }
    const ownerUserId = await this.ownerId(actor.room);
    const provider = this.providers.findFor(request.sourceRef);
    if (!provider || provider.providerId !== 'ncm') {
      throw new NcmProviderError('MUSIC_INVALID_REQUEST', '当前歌曲不是可解析的网易云引用', 400);
    }
    const credentialVersion = await this.credentials.getCredentialVersion(ownerUserId);
    if (!credentialVersion) throw new NcmProviderError('NCM_NOT_LOGGED_IN', '房主尚未登录网易云', 409);
    const resolution = await provider.resolve({
      roomId: request.roomId,
      userId: actor.session.userId ?? null,
      credentialOwnerId: ownerUserId,
      requestedQuality: request.requestedQuality,
    }, request.sourceRef);
    const expiresAt = Math.min(Date.now() + CAPABILITY_TTL_MS, resolution.privateSource.expiresAt);
    const handle = issueMediaHandle({
      kind: 'media',
      url: 'https://music-capability.tongmu.invalid/ncm',
      scope: `room:${request.roomId}`,
      contentType: resolution.descriptor.mimeType,
      allowRange: true,
      providerId: 'ncm',
      providerData: {
        kind: CAPABILITY_KIND,
        roomId: request.roomId,
        socketId: actor.session.socketId,
        actorUserId: actor.session.userId ?? null,
        credentialOwnerId: ownerUserId,
        credentialVersion,
        queueItemId: request.queueItemId,
        sourceRef: request.sourceRef,
        musicGeneration: request.musicGeneration,
        requestedQuality: request.requestedQuality,
      },
      sourceGeneration: request.musicGeneration,
      expiresAt,
    });
    return {
      descriptor: publicDescriptor(resolution, track),
      playbackUrl: `/api/music/playback/${handle.id}`,
      expiresAt: handle.expiresAt,
    };
  }

  private async resolveCapability(
    token: string,
    roomGrantToken: string | undefined,
  ): Promise<{ actor: AuthorizedActor; claims: MusicCapabilityClaims; resolution: CredentialedMusicProviderResolution; track: MusicAuthoritativeTrack }> {
    const roomGrant = roomGrantToken
      ? await authorizeRoomMediaGrant(roomGrantToken, undefined, async (roomId, socketId) => !!await this.dataSource.getRepository(Session).findOneBy({ roomId, socketId, endedAt: IsNull() }))
      : undefined;
    const resource = resolveMediaHandle(token, '', roomGrant);
    if (!resource || resource.providerId !== 'ncm' || !isCapabilityClaims(resource.providerData)) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐播放授权无效或已过期', 403);
    }
    const claims = resource.providerData;
    if (resource.scope !== `room:${claims.roomId}`) {
      throw new NcmProviderError('MUSIC_CAPABILITY_INVALID', '音乐播放授权范围无效', 403);
    }
    const actor = await this.authorizeActor(claims.roomId, roomGrantToken);
    const current = await this.currentResolution(actor, claims);
    return { actor, claims, ...current };
  }

  async proxy(req: Request, res: Response, token: string, roomGrantToken?: string): Promise<void> {
    const current = await this.resolveCapability(token, roomGrantToken);
    const firstHeaders = ncmHeaders(current.resolution.privateSource);
    await proxyHttpUpstream(req, res, {
      url: current.resolution.privateSource.url,
      targetPolicy: 'public-only',
      headers: firstHeaders,
      defaultContentType: current.resolution.descriptor.mimeType,
      cacheControl: 'no-store',
      logTag: 'music-ncm-gateway',
      errorMessage: '网易云音乐流代理失败',
      onUpstreamAuthFailure: async () => {
        const refreshed = await this.resolveCapability(token, roomGrantToken);
        return {
          url: refreshed.resolution.privateSource.url,
          headers: ncmHeaders(refreshed.resolution.privateSource),
        };
      },
    });
  }
}

export const musicPlaybackService = new MusicPlaybackService();
