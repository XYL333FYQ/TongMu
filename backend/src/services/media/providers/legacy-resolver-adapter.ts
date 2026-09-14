import type { PlaybackClientProfileV1 } from '../playback-profile';
import type { PlaybackCandidate, PrivateMediaSource } from '../protocol';
import type { MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { assertProviderActive, type MediaProvider, type ProviderAvailability, type ProviderContext, type ProviderCredentialDependency, type ProviderPrivateContext, type ProviderResolution } from './types';

function pipelinesFor(descriptor: MediaDescriptor): PlaybackCandidate['requiredPipelines'] {
  if (descriptor.transport === 'hls') return ['native', 'mse'];
  if (descriptor.transport === 'dash' || descriptor.transport === 'flv') return ['mse'];
  if (['mkv', 'avi', 'wmv', 'ts'].includes(descriptor.container)) return ['native', 'playsvideo'];
  return ['native'];
}

function privateSourceFor(descriptor: MediaDescriptor): PrivateMediaSource {
  return {
    input: descriptor.input,
    originalUrl: descriptor.originalUrl,
    finalUrl: descriptor.finalUrl,
    headers: descriptor.headers,
    credentialOrigins: descriptor.credentialOrigins,
  };
}

export interface LegacyResolverAdapterOptions {
  id: string;
  sourceKinds: readonly string[];
  resolver: SourceResolver;
  credentialDependencies?: ProviderCredentialDependency[];
}

/**
 * Compatibility façade for the already-audited resolver implementations. It
 * gives them the new provider lifecycle/context without copying their parsing
 * logic or putting credentials in the generic context.
 */
export class LegacyResolverAdapter implements MediaProvider {
  readonly id: string;
  readonly sourceKinds: readonly string[];
  private readonly resolver: SourceResolver;
  private readonly dependencies: ProviderCredentialDependency[];

  constructor(options: LegacyResolverAdapterOptions) {
    this.id = options.id;
    this.sourceKinds = options.sourceKinds;
    this.resolver = options.resolver;
    this.dependencies = options.credentialDependencies ?? [];
  }

  canHandle(input: string): boolean { return this.resolver.canHandle(input); }

  validateInput(_context: ProviderContext, input: string): void {
    if (!input.trim() || input.length > 4096 || !this.canHandle(input)) {
      throw new Error(`${this.id} provider input is invalid`);
    }
  }

  normalizeInput(input: string): string { return input.trim().slice(0, 4096); }

  credentialDependencies(_context: ProviderContext, _input: string): ProviderCredentialDependency[] {
    return this.dependencies.map((dependency) => ({ ...dependency }));
  }

  availability(_context: ProviderContext): ProviderAvailability { return { available: true }; }

  async resolve(context: ProviderContext, input: string, privateContext: ProviderPrivateContext): Promise<ProviderResolution> {
    assertProviderActive(context);
    const resolverContext: ResolverContext = {
      userId: context.userId ?? '',
      cookie: privateContext.providerCookie,
      signal: context.signal,
      deadline: context.deadline,
      roomId: context.roomId,
      sourceGeneration: context.sourceGeneration,
      playbackClientProfile: context.profile,
    };
    const descriptor = await this.resolver.resolve(this.normalizeInput(input), resolverContext);
    assertProviderActive(context);
    const candidates: PlaybackCandidate[] = [{
      mode: 'DIRECT',
      url: descriptor.finalUrl,
      audioUrl: descriptor.audioUrl,
      transport: descriptor.transport,
      container: descriptor.container,
      actualQuality: descriptor.actualQuality,
      requiredPipelines: pipelinesFor(descriptor),
      requiresCustomHeaders: Object.keys(descriptor.headers ?? {}).some((key) => !/^accept(?:-language)?$/i.test(key)),
    }];
    return {
      privateSource: privateSourceFor(descriptor),
      descriptor,
      candidates,
    };
  }

  async cleanup(context: ProviderContext, sourceGeneration: number): Promise<void> {
    assertProviderActive({ signal: context.signal, deadline: context.deadline });
    void sourceGeneration;
  }
}
