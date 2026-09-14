import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../../../data-source';
import { UserMount, type MountType } from '../../../entities/UserMount';
import {
  audioCodecFamily,
  videoCodecFamily,
  type PlaybackPipeline,
  type PlaybackAudioCodec,
  type PlaybackVideoCodec,
} from '../playback-profile';
import { type PlaybackCandidate, type PrivateMediaSource } from '../protocol';
import type {
  MediaContainer,
  MediaDescriptor,
  MediaTransport,
  MediaServerSourceMetadata,
} from '../types';
import {
  assertProviderActive,
  type MediaProvider,
  type ProviderAvailability,
  type ProviderContext,
  type ProviderCredentialDependency,
  type ProviderPrivateContext,
  type ProviderPlaybackSessionLifecycle,
  type ProviderResolution,
} from './types';
import {
  assertMediaServerReference,
  buildMediaServerReference,
  type MediaServerReference,
} from './media-server-reference';
import { createEmbyProviderClient } from './emby-client';
import { createJellyfinProviderClient } from './jellyfin-client';
import type {
  MediaServerClient,
  MediaServerMediaSource,
  MediaServerProviderId,
  MediaServerSessionBinding,
  MediaServerStream,
  MediaServerUpstreamMode,
} from './media-server-types';

export interface MediaServerProviderDependencies {
  loadMount?: (
    context: ProviderContext,
    reference: MediaServerReference,
    type: MountType,
  ) => Promise<UserMount | undefined>;
  createClient?: (mount: UserMount, context: ProviderContext) => Promise<MediaServerClient>;
  assertPublicUrl?: (url: string) => Promise<URL>;
}

type MediaServerCandidate = PlaybackCandidate & {
  upstreamMode: MediaServerUpstreamMode;
};

function currentCredentialOwnerId(context: ProviderContext): number {
  const value = Number(context.credentialOwnerId ?? context.userId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('媒体服务器凭据所有者无效');
  return value;
}

function providerLabel(provider: MediaServerProviderId): string {
  return provider === 'emby' ? 'Emby' : 'Jellyfin';
}

function streamType(stream: MediaServerStream): string {
  return stream.type.toLowerCase();
}

function firstStream(source: MediaServerMediaSource, type: 'video' | 'audio'): MediaServerStream | undefined {
  return source.mediaStreams.find((stream) => streamType(stream) === type);
}

function mediaContainer(value?: string, fallback?: string): MediaContainer {
  const normalized = (value ?? fallback ?? '').toLowerCase().replace(/^\./, '').split(/[?#]/, 1)[0];
  const known: MediaContainer[] = ['mp4', 'webm', 'mkv', 'avi', 'wmv', 'mov', 'flv', 'ts', 'hls', 'dash'];
  if (known.includes(normalized as MediaContainer)) return normalized as MediaContainer;
  return 'unknown';
}

function containerFromSource(source: MediaServerMediaSource): MediaContainer {
  return mediaContainer(source.container, source.path?.split('.').pop());
}

function contentTypeFor(container: MediaContainer): string {
  switch (container) {
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'wmv': return 'video/x-ms-wmv';
    case 'mov': return 'video/quicktime';
    case 'flv': return 'video/x-flv';
    case 'ts': return 'video/mp2t';
    case 'hls': return 'application/vnd.apple.mpegurl';
    case 'dash': return 'application/dash+xml';
    default: return 'application/octet-stream';
  }
}

function transportForUrl(url: string, container: MediaContainer): MediaTransport {
  if (container === 'hls' || /\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (container === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (container === 'flv') return 'flv';
  return 'direct';
}

function pipelinesFor(transport: MediaTransport, container: MediaContainer): PlaybackPipeline[] {
  if (transport === 'hls') return ['native', 'mse'];
  if (transport === 'dash' || transport === 'flv') return ['mse'];
  if (['mkv', 'avi', 'wmv', 'ts'].includes(container)) return ['native', 'playsvideo'];
  return ['native'];
}

function codecStrings(video?: string, audio?: string): string[] | undefined {
  const values = [video, audio]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase()))
    .filter((value) => /^(?:avc1|avc3|hev1|hvc1|av01|vp0[89]|mp4a|opus|vorbis|ac-?3|ec-?3|dts|flac)(?:[.\d]|$)/i.test(value));
  return values.length ? [...new Set(values)] : undefined;
}

function finitePositive(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function safeUpstreamUrl(raw: string | undefined, fallback: string, baseUrl: string, label: string): string {
  let url: URL;
  try { url = new URL(raw || fallback, baseUrl); } catch { throw new Error(`${label} 返回了无效媒体地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label} 返回了不安全媒体地址`);
  }
  // A media server may return a CDN URL, but an arbitrary different origin
  // must not silently become an SSRF target. The saved provider endpoint is
  // the only upstream trust root in this phase.
  if (url.origin !== new URL(baseUrl).origin) throw new Error(`${label} 媒体地址超出已授权服务器范围`);
  return url.toString();
}

function credentialedHeaders(client: MediaServerClient): Record<string, string> {
  return client.authHeaders();
}

function requiresCustomHeaders(client: MediaServerClient): boolean {
  return Object.keys(credentialedHeaders(client)).some((name) => /authorization|token|cookie|password|api.?key/i.test(name));
}

function qualityIdentity(
  container: MediaContainer,
  videoCodec: string | undefined,
  audioCodec: string | undefined,
  source: MediaServerMediaSource,
  audioChannels?: number,
): NonNullable<PlaybackCandidate['qualityIdentity']> {
  return {
    container,
    videoCodec,
    audioCodec,
    width: finitePositive(source.width),
    height: finitePositive(source.height),
    bitrate: finitePositive(source.bitrate),
    audioChannels,
  };
}

function outputFacts(
  source: MediaServerMediaSource,
  mode: MediaServerUpstreamMode,
  url: string,
): {
  container: MediaContainer;
  transport: MediaTransport;
  videoCodec?: PlaybackVideoCodec;
  audioCodec?: PlaybackAudioCodec;
  exactCodecStrings?: string[];
  qualityIdentity: NonNullable<PlaybackCandidate['qualityIdentity']>;
  actualQuality?: number;
  audioTranscoded?: boolean;
} {
  const video = firstStream(source, 'video');
  const audio = firstStream(source, 'audio');
  if (mode !== 'transcode') {
    const container = containerFromSource(source);
    const transport = transportForUrl(url, container);
    return {
      container,
      transport,
      videoCodec: videoCodecFamily(video?.codec),
      audioCodec: audioCodecFamily(audio?.codec),
      exactCodecStrings: codecStrings(video?.codec, audio?.codec),
      qualityIdentity: qualityIdentity(container, video?.codec, audio?.codec, source, audio?.channels),
      actualQuality: finitePositive(source.height),
    };
  }
  const container = mediaContainer(source.transcodingContainer, /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : source.container);
  const transport = transportForUrl(url, container);
  const videoCodec = source.transcodingVideoCodec || 'h264';
  const audioCodec = source.transcodingAudioCodec || 'aac';
  return {
    container,
    transport,
    videoCodec: videoCodecFamily(videoCodec),
    audioCodec: audioCodecFamily(audioCodec),
    exactCodecStrings: codecStrings(videoCodec, audioCodec),
    qualityIdentity: {
      container,
      videoCodec,
      audioCodec,
      width: finitePositive(source.transcodingWidth),
      height: finitePositive(source.transcodingHeight),
      bitrate: finitePositive(source.transcodingBitrate),
    },
    actualQuality: finitePositive(source.transcodingHeight),
    audioTranscoded: true,
  };
}

function subtitleFacts(reference: string, source: MediaServerMediaSource): NonNullable<MediaServerSourceMetadata['subtitles']> {
  return source.mediaStreams
    .filter((stream) => streamType(stream) === 'subtitle')
    .map((stream) => ({
      index: stream.index,
      language: stream.language || stream.displayLanguage,
      label: stream.displayTitle || stream.title,
      codec: stream.codec,
      embedded: stream.isExternal !== true,
      external: stream.isExternal === true,
      forced: stream.isForced === true,
      default: stream.isDefault === true,
      // This is a stable, credential-free identity. The authorized subtitle
      // resource is resolved server-side by the provider boundary later.
      sourceReference: `${reference}#subtitle=${encodeURIComponent(String(stream.index))}`,
    }));
}

abstract class MediaServerProviderBase implements MediaProvider {
  abstract readonly id: MediaServerProviderId;
  abstract readonly sourceKinds: readonly string[];
  protected abstract readonly mountType: MountType;
  protected abstract createDefaultClient(mount: UserMount, context: ProviderContext): Promise<MediaServerClient>;
  protected readonly deps: MediaServerProviderDependencies;

  constructor(deps: MediaServerProviderDependencies = {}) {
    this.deps = deps;
  }

  canHandle(input: string): boolean {
    return input.startsWith(`provider://${this.id}`);
  }

  validateInput(_context: ProviderContext, input: string): void {
    assertMediaServerReference(input, this.id);
  }

  normalizeInput(input: string): string {
    return buildMediaServerReference(assertMediaServerReference(input, this.id));
  }

  availability(_context: ProviderContext): ProviderAvailability {
    return { available: true };
  }

  credentialDependencies(context: ProviderContext): ProviderCredentialDependency[] {
    return [{
      providerId: this.id,
      owner: context.roomId ? 'room-owner' : 'current-viewer',
      requirement: 'required',
      scope: 'playback',
    }];
  }

  protected async loadMount(context: ProviderContext, reference: MediaServerReference): Promise<UserMount> {
    const loaded = this.deps.loadMount
      ? await this.deps.loadMount(context, reference, this.mountType)
      : await AppDataSource.getRepository(UserMount).findOneBy({
        id: reference.mountId,
        userId: currentCredentialOwnerId(context),
        type: this.mountType,
      });
    if (!loaded) throw new Error(`无权访问该${providerLabel(this.id)}挂载`);
    if (loaded.type !== this.mountType) throw new Error('媒体服务器挂载类型不匹配');
    return loaded;
  }

  protected async clientForMount(mount: UserMount, context: ProviderContext): Promise<MediaServerClient> {
    return this.deps.createClient
      ? this.deps.createClient(mount, context)
      : this.createDefaultClient(mount, context);
  }

  protected async clientForSession(context: ProviderContext, session: MediaServerSessionBinding): Promise<MediaServerClient> {
    if (session.providerId !== this.id) throw new Error('媒体服务器会话 Provider 不匹配');
    const reference = assertMediaServerReference(session.reference, this.id);
    if (reference.mountId !== session.mountId || reference.itemId !== session.itemId || reference.mediaSourceId !== session.mediaSourceId) {
      throw new Error('媒体服务器会话引用不一致');
    }
    const mount = await this.loadMount(context, reference);
    return this.clientForMount(mount, context);
  }

  async resolve(context: ProviderContext, input: string): Promise<ProviderResolution> {
    assertProviderActive(context);
    const reference = assertMediaServerReference(input, this.id);
    const mount = await this.loadMount(context, reference);
    const client = await this.clientForMount(mount, context);
    const serverUserId = client.userId || mount.embyUserId || context.userId;
    if (!serverUserId) throw new Error(`${providerLabel(this.id)} 未解析到服务端用户身份`);
    const allowTranscoding = context.qualityChangingTranscode === 'explicit';
    const playbackInfo = await client.playbackInfo({
      itemId: reference.itemId,
      userId: serverUserId,
      mediaSourceId: reference.mediaSourceId,
      profile: context.profile,
      allowTranscoding,
      context,
    });
    assertProviderActive(context);
    const sources = reference.mediaSourceId
      ? playbackInfo.mediaSources.filter((source) => source.id === reference.mediaSourceId)
      : playbackInfo.mediaSources;
    if (!sources.length) throw new Error(`${providerLabel(this.id)} 未返回请求的媒体源`);

    const privateHeaders = credentialedHeaders(client);
    const privateCredentialOrigins = [new URL(client.baseUrl).origin];
    const customHeadersRequired = requiresCustomHeaders(client);
    const allCandidates: MediaServerCandidate[] = [];
    const sourceCandidates = new Map<string, MediaServerCandidate[]>();
    for (const source of sources) {
      const directPlayUrl = safeUpstreamUrl(
        source.directPlayUrl,
        client.playbackUrl(reference.itemId, source.id, 'direct-play'),
        client.baseUrl,
        providerLabel(this.id),
      );
      const candidates: MediaServerCandidate[] = [];
      if (source.supportsDirectPlay !== false) {
        const facts = outputFacts(source, 'direct-play', directPlayUrl);
        candidates.push({
          mode: 'DIRECT', url: directPlayUrl, transport: facts.transport, container: facts.container,
          videoCodec: facts.videoCodec, audioCodec: facts.audioCodec, exactCodecStrings: facts.exactCodecStrings,
          actualQuality: facts.actualQuality, requiredPipelines: pipelinesFor(facts.transport, facts.container),
          requiresCustomHeaders: customHeadersRequired, representationId: source.id,
          upstreamMode: 'direct-play', qualityPreserved: true, qualityChanged: false,
          qualityIdentity: facts.qualityIdentity,
        });
      }
      // Direct Stream/remux is only admitted when the upstream response proves
      // that the elementary streams and quality are unchanged. A server flag
      // such as SupportsDirectStream alone is not enough.
      if (source.supportsDirectStream && source.directStreamPreservesQuality === true) {
        const directStreamUrl = safeUpstreamUrl(
          source.directStreamUrl,
          client.playbackUrl(reference.itemId, source.id, 'direct-stream'),
          client.baseUrl,
          providerLabel(this.id),
        );
        const facts = outputFacts(source, 'direct-stream', directStreamUrl);
        candidates.push({
          mode: 'DIRECT', url: directStreamUrl, transport: facts.transport, container: facts.container,
          videoCodec: facts.videoCodec, audioCodec: facts.audioCodec, exactCodecStrings: facts.exactCodecStrings,
          actualQuality: facts.actualQuality, requiredPipelines: pipelinesFor(facts.transport, facts.container),
          requiresCustomHeaders: customHeadersRequired, representationId: source.id,
          upstreamMode: 'direct-stream', qualityPreserved: true, qualityChanged: false,
          qualityIdentity: facts.qualityIdentity,
        });
      }
      const directPlay = candidates.find((candidate) => candidate.upstreamMode === 'direct-play');
      const originalContainer = containerFromSource(source);
      const originalAudio = audioCodecFamily(firstStream(source, 'audio')?.codec);
      const needsClientCompatibility = !!directPlay && (
        ['mkv', 'avi', 'wmv', 'ts'].includes(originalContainer) ||
        ['ac3', 'eac3', 'dts', 'flac'].includes(originalAudio ?? '')
      );
      if (needsClientCompatibility && directPlay) {
        const video = firstStream(source, 'video');
        const audio = firstStream(source, 'audio');
        const audioNeedsTranscode = ['ac3', 'eac3', 'dts', 'flac'].includes(originalAudio ?? '');
        const compatibilityAudio = audioNeedsTranscode ? 'aac' : directPlay.audioCodec;
        candidates.push({
          ...directPlay,
          requiredPipelines: ['playsvideo'],
          audioCodec: compatibilityAudio,
          exactCodecStrings: codecStrings(video?.codec, audioNeedsTranscode ? 'mp4a.40.2' : audio?.codec),
          audioTranscoded: audioNeedsTranscode,
          qualityPreserved: !audioNeedsTranscode,
          qualityChanged: false,
          qualityIdentity: {
            container: directPlay.qualityIdentity?.container ?? originalContainer,
            ...directPlay.qualityIdentity,
            audioCodec: audioNeedsTranscode ? 'aac' : directPlay.qualityIdentity?.audioCodec,
          },
        });
      }
      // Quality-changing provider transcode is never an implicit transport
      // fallback. It is emitted only after explicit policy opt-in and remains
      // marked as a different representation for the client planner.
      if (allowTranscoding && source.supportsTranscoding !== false) {
        const transcodeUrl = safeUpstreamUrl(
          source.transcodingUrl,
          client.playbackUrl(reference.itemId, source.id, 'transcode'),
          client.baseUrl,
          providerLabel(this.id),
        );
        const facts = outputFacts(source, 'transcode', transcodeUrl);
        candidates.push({
          mode: 'DIRECT', url: transcodeUrl, transport: facts.transport, container: facts.container,
          videoCodec: facts.videoCodec, audioCodec: facts.audioCodec, exactCodecStrings: facts.exactCodecStrings,
          actualQuality: facts.actualQuality, requiredPipelines: pipelinesFor(facts.transport, facts.container),
          requiresCustomHeaders: customHeadersRequired, representationId: source.id,
          upstreamMode: 'transcode', qualityPreserved: false, qualityChanged: true,
          audioTranscoded: facts.audioTranscoded, qualityIdentity: facts.qualityIdentity,
        });
      }
      sourceCandidates.set(source.id, candidates);
      allCandidates.push(...candidates);
    }
    if (!allCandidates.length) throw new Error(`${providerLabel(this.id)} 没有可用的直接或兼容媒体表示`);

    const primarySource = sources[0];
    const primaryCandidates = sourceCandidates.get(primarySource.id) ?? [];
    const primary = primaryCandidates[0] ?? allCandidates[0];
    const canonicalReference = buildMediaServerReference({ ...reference, mediaSourceId: primary.representationId });
    const primaryVideo = firstStream(primarySource, 'video');
    const primaryAudio = firstStream(primarySource, 'audio');
    const primaryContainer = containerFromSource(primarySource);
    const primaryUrl = primary.url;
    const sourceMetadata: MediaServerSourceMetadata = {
      providerReference: canonicalReference,
      provider: this.id,
      itemId: reference.itemId,
      mediaSourceId: primary.representationId || primarySource.id,
      representationId: primary.representationId || primarySource.id,
      upstreamMode: primary.upstreamMode,
      qualityPreserved: primary.qualityPreserved === true,
      qualityChanged: primary.qualityChanged === true,
      subtitles: subtitleFacts(canonicalReference, primarySource),
    };
    const descriptor: MediaDescriptor = {
      title: primarySource.name || primarySource.path?.split(/[\\/]/).pop() || reference.itemId,
      sourceType: this.id,
      resolver: this.id,
      input,
      originalUrl: primaryUrl,
      finalUrl: primaryUrl,
      transport: primary.transport,
      container: primaryContainer,
      contentType: contentTypeFor(primaryContainer),
      contentLength: primarySource.size,
      rangeSupported: true,
      contentDisposition: primarySource.name,
      videoCodec: primaryVideo?.codec,
      width: primarySource.width,
      height: primarySource.height,
      bitrate: primarySource.bitrate,
      audioCodec: primaryAudio?.codec,
      channels: primaryAudio?.channels,
      audioBitrate: primaryAudio?.bitrate,
      duration: primarySource.runTimeTicks ? primarySource.runTimeTicks / 10_000_000 : undefined,
      subtitles: primarySource.mediaStreams
        .filter((stream) => streamType(stream) === 'subtitle')
        .map((stream) => ({ language: stream.language || stream.displayLanguage, label: stream.displayTitle || stream.title, url: '' })),
      sourceMaximumQuality: primarySource.height,
      availableMaximumQuality: primarySource.height,
      actualCodec: [primaryVideo?.codec, primaryAudio?.codec].filter(Boolean).join(','),
      actualBandwidth: primarySource.bitrate,
      actualQuality: primarySource.height,
      qualityLabel: primarySource.height ? `${primarySource.height}p` : undefined,
      sourceMetadata: { [this.id]: sourceMetadata },
      drm: { protected: false },
      probe: { method: 'resolver', bytesRead: 0, warnings: [] },
    };
    const trustedPrivateHosts = [new URL(client.baseUrl).hostname];
    const privateSource: PrivateMediaSource = {
      input,
      originalUrl: primaryUrl,
      finalUrl: primaryUrl,
      headers: privateHeaders,
      credentialOrigins: privateCredentialOrigins,
      providerId: this.id,
      providerData: {
        kind: 'media-server',
        providerId: this.id,
        mountId: reference.mountId,
        itemId: reference.itemId,
        mediaSourceId: primary.representationId || primarySource.id,
        sourceReference: canonicalReference,
        trustedPrivateHosts,
      },
    };
    const session: MediaServerSessionBinding = {
      providerId: this.id,
      mountId: reference.mountId,
      itemId: reference.itemId,
      mediaSourceId: primary.representationId || primarySource.id,
      playSessionId: playbackInfo.playSessionId || randomUUID(),
      reference: canonicalReference,
      actorUserId: context.userId,
      credentialOwnerId: context.credentialOwnerId ?? context.userId,
      roomId: context.roomId,
      movieId: context.movieId,
      sourceGeneration: context.sourceGeneration,
    };
    for (const candidate of allCandidates) {
      const mediaSourceId = candidate.representationId || primarySource.id;
      candidate.session = {
        ...session,
        mediaSourceId,
        reference: buildMediaServerReference({ ...reference, mediaSourceId }),
      };
    }
    return {
      privateSource,
      descriptor,
      candidates: allCandidates,
      sourceReference: canonicalReference,
      session,
    };
  }

  readonly playbackSession: ProviderPlaybackSessionLifecycle = {
    start: async (context, session) => {
      assertProviderActive(context);
      const client = await this.clientForSession(context, session);
      await client.startPlayback(session, context);
    },
    progress: async (context, session, position, paused) => {
      assertProviderActive(context);
      const client = await this.clientForSession(context, session);
      await client.reportProgress(session, position, paused, context);
    },
    stop: async (context, session, position) => {
      assertProviderActive(context);
      const client = await this.clientForSession(context, session);
      await client.stopPlayback(session, position, context);
    },
    cleanup: async (context, session) => {
      const client = await this.clientForSession(context, session);
      await client.cleanupPlayback(session, context);
    },
  };

  async cleanup(context: ProviderContext, sourceGeneration: number): Promise<void> {
    if (context.sourceGeneration !== undefined && context.sourceGeneration !== sourceGeneration) return;
    assertProviderActive(context);
  }
}

export class EmbyProvider extends MediaServerProviderBase {
  readonly id = 'emby' as const;
  readonly sourceKinds = ['emby'] as const;
  protected readonly mountType = 'emby' as const;

  protected createDefaultClient(mount: UserMount, context: ProviderContext): Promise<MediaServerClient> {
    return createEmbyProviderClient(mount, context);
  }
}

export class JellyfinProvider extends MediaServerProviderBase {
  readonly id = 'jellyfin' as const;
  readonly sourceKinds = ['jellyfin'] as const;
  protected readonly mountType = 'jellyfin' as const;

  protected createDefaultClient(mount: UserMount, context: ProviderContext): Promise<MediaServerClient> {
    return createJellyfinProviderClient(mount, context);
  }
}

export function mediaServerProviderDependenciesForTest(
  deps: MediaServerProviderDependencies,
): MediaServerProviderDependencies {
  return deps;
}
