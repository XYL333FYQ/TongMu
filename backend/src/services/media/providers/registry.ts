import { fetchWithProxyPolicy, ProxyTargetError } from '../../proxy/safe-fetch';
import { BilibiliResolver } from '../resolvers/bilibili';
import { BrowserResolver } from '../resolvers/browser';
import { DirectUrlResolver } from '../resolvers/direct-url';
import { GenericWebResolver } from '../resolvers/generic-web';
import { ResolverNotApplicableError, type MediaDescriptor, type ResolverContext } from '../types';
import { MediaResolutionError } from '../resolution-error';
import { legacyPlaybackClientProfile, type PlaybackClientProfileV1 } from '../playback-profile';
import { LegacyResolverAdapter } from './legacy-resolver-adapter';
import { FtpProvider, LocalFileProvider, OpenListProvider, WebDavProvider } from './storage-providers';
import { EmbyProvider, JellyfinProvider } from './media-server-provider';
import { LiveProvider } from './live-provider';
import { AnimeProvider, AniSubsProvider, KazumiProvider } from './anime-provider';
import {
  assertProviderActive,
  providerActorForUser,
  type MediaProvider,
  type ProviderContext,
  type ProviderPrivateContext,
  type ProviderResolution,
} from './types';

export function defaultProviderRegistry(): MediaProvider[] {
  return [
    new LocalFileProvider(),
    new WebDavProvider(),
    new FtpProvider(),
    new OpenListProvider(),
    new EmbyProvider(),
    new JellyfinProvider(),
    new AniSubsProvider(),
    new KazumiProvider(),
    new AnimeProvider('anime'),
    new LiveProvider(),
    new LegacyResolverAdapter({
      id: 'bilibili', sourceKinds: ['bilibili'], resolver: new BilibiliResolver(),
      credentialDependencies: [{ providerId: 'bilibili', owner: 'current-viewer', requirement: 'optional', scope: 'playback' }],
    }),
    new LegacyResolverAdapter({ id: 'direct-url', sourceKinds: ['url'], resolver: new DirectUrlResolver() }),
    new LegacyResolverAdapter({ id: 'generic-web', sourceKinds: ['web-page'], resolver: new GenericWebResolver() }),
    new LegacyResolverAdapter({ id: 'browser', sourceKinds: ['browser-page'], resolver: new BrowserResolver() }),
  ];
}

export class MediaProviderRegistry {
  private readonly providers = new Map<string, MediaProvider>();

  constructor(providers: MediaProvider[] = defaultProviderRegistry()) {
    providers.forEach((provider) => this.register(provider));
  }

  register(provider: MediaProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`duplicate media provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  list(): MediaProvider[] { return [...this.providers.values()]; }

  get(id: string): MediaProvider | undefined { return this.providers.get(id); }

  matching(input: string): MediaProvider[] {
    return this.list().filter((provider) => provider.canHandle(input));
  }

  async resolveProvider(
    input: string,
    context: ProviderContext,
    privateContext: ProviderPrivateContext,
  ): Promise<ProviderResolution> {
    let hadUnexpectedFailure = false;
    for (const provider of this.matching(input)) {
      try {
        assertProviderActive(context);
        await provider.validateInput(context, input);
        const normalized = provider.normalizeInput(input);
        const available = await provider.availability(context);
        if (!available.available) throw new Error(available.reason ?? 'provider unavailable');
        return await provider.resolve(context, normalized, privateContext);
      } catch (error) {
        if (Date.now() >= context.deadline) throw new MediaResolutionError('TIMEOUT');
        if (context.signal.aborted) throw new MediaResolutionError('CANCELLED');
        if (error instanceof ProxyTargetError) throw new MediaResolutionError('TARGET_BLOCKED');
        if (error instanceof MediaResolutionError) throw error;
        if (!(error instanceof ResolverNotApplicableError) && provider.id === 'bilibili') throw error;
        if (!(error instanceof ResolverNotApplicableError)) hadUnexpectedFailure = true;
      }
    }
    throw new MediaResolutionError(hadUnexpectedFailure ? 'RESOLVE_FAILED' : 'NO_MEDIA_FOUND');
  }

  async resolve(
    input: string,
    context: ProviderContext,
    privateContext: ProviderPrivateContext,
  ): Promise<MediaDescriptor> {
    return (await this.resolveProvider(input, context, privateContext)).descriptor;
  }
}

export const mediaProviderRegistry = new MediaProviderRegistry();

export function providerContextFromResolverContext(context: ResolverContext): ProviderContext {
  const controller = new AbortController();
  if (context.signal) {
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return {
    actor: providerActorForUser(context.userId),
    userId: context.userId,
    roomId: context.roomId,
    movieId: context.movieId,
    sourceGeneration: context.sourceGeneration,
    credentialOwnerId: context.credentialOwnerId,
    qualityChangingTranscode: context.qualityChangingTranscode ?? 'disabled',
    signal: controller.signal,
    deadline: context.deadline ?? Date.now() + 30_000,
    profile: context.playbackClientProfile ?? legacyPlaybackClientProfile(),
    requestedQn: context.requestedQn,
    browserSniff: context.browserSniff === true,
    preferMp4: context.preferMp4,
    page: context.page,
    cid: context.cid,
    credentialOwnerPolicy: context.credentialOwnerPolicy ?? (context.roomId ? 'room-owner' : 'current-viewer'),
    safeFetch: fetchWithProxyPolicy,
  };
}

export function privateProviderContextFromResolverContext(context: ResolverContext): ProviderPrivateContext {
  return { providerCookie: context.cookie };
}
