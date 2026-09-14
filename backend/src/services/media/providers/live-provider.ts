import { assertPublicUrl } from '../../proxy/safe-fetch';
import { DirectUrlResolver } from '../resolvers/direct-url';
import type { MediaDescriptor } from '../types';
import type { PlaybackCandidate, PrivateMediaSource } from '../protocol';
import {
  assertProviderActive,
  type MediaProvider,
  type ProviderAvailability,
  type ProviderContext,
  type ProviderCredentialDependency,
  type ProviderPrivateContext,
  type ProviderResolution,
} from './types';

function liveTarget(input: string): { reference: string; url: string } | undefined {
  if (/^live:\/\/(?:hls|flv)(?:\?|$)/i.test(input)) {
    const parsed = new URL(input);
    const url = parsed.searchParams.get('url');
    if (!url) throw new Error('Live 引用缺少 url');
    return { reference: input, url };
  }
  return { reference: input, url: input };
}

function knownLiveUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && /(?:\.m3u8|\.flv)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function wrapperKind(input: string): 'hls' | 'flv' | undefined {
  const match = /^live:\/\/(hls|flv)(?:\?|$)/i.exec(input.trim());
  return match?.[1].toLowerCase() as 'hls' | 'flv' | undefined;
}

function pipelinesFor(descriptor: MediaDescriptor): PlaybackCandidate['requiredPipelines'] {
  return descriptor.transport === 'hls' ? ['native', 'mse'] : ['mse'];
}

/**
 * Ordinary public HLS/HTTP-FLV inputs use the same Media Core as VOD, but the
 * provider makes their live semantics explicit and keeps proxy lifecycle in
 * the existing streaming gateway.
 */
export class LiveProvider implements MediaProvider {
  readonly id = 'live';
  readonly sourceKinds = ['live-hls', 'live-flv'] as const;
  private readonly resolver = new DirectUrlResolver();

  canHandle(input: string): boolean {
    return /^live:\/\/(?:hls|flv)(?:\?|$)/i.test(input.trim()) || knownLiveUrl(input.trim());
  }

  validateInput(_context: ProviderContext, input: string): void {
    if (!this.canHandle(input) || input.length > 4096) throw new Error('Live provider input is invalid');
    const target = liveTarget(input)?.url;
    if (!target) throw new Error('Live provider target is missing');
    try {
      const parsedTarget = new URL(target);
      if (!['http:', 'https:'].includes(parsedTarget.protocol)) throw new Error('scheme');
    } catch {
      throw new Error('Live provider target is invalid');
    }
  }

  normalizeInput(input: string): string { return input.trim().slice(0, 4096); }

  credentialDependencies(_context: ProviderContext, _input: string): ProviderCredentialDependency[] {
    return [];
  }

  availability(_context: ProviderContext): ProviderAvailability { return { available: true }; }

  async resolve(context: ProviderContext, input: string, _privateContext: ProviderPrivateContext): Promise<ProviderResolution> {
    assertProviderActive(context);
    const target = liveTarget(input);
    if (!target) throw new Error('Live provider target is missing');
    await assertPublicUrl(target.url);
    const resolved = await this.resolver.resolve(target.url, {
      userId: context.userId ?? '',
      signal: context.signal,
      deadline: context.deadline,
      playbackClientProfile: context.profile,
    });
    assertProviderActive(context);
    if (resolved.transport !== 'hls' && resolved.transport !== 'flv') {
      throw new Error('Live provider target is not HLS or HTTP-FLV');
    }
    const expectedKind = wrapperKind(input);
    if (expectedKind && expectedKind !== resolved.transport) {
      throw new Error('Live 引用类型与实际媒体传输不一致');
    }
    const descriptor: MediaDescriptor = {
      ...resolved,
      input: target.reference,
      sourceType: 'live',
      resolver: this.id,
      isLive: true,
      liveKind: resolved.transport === 'hls' ? 'hls' : 'http-flv',
      duration: undefined,
      seekable: false,
      reconnect: 'same-source',
    };
    const candidate: PlaybackCandidate = {
      mode: 'DIRECT',
      url: descriptor.finalUrl,
      transport: descriptor.transport,
      container: descriptor.container,
      videoCodec: undefined,
      audioCodec: undefined,
      exactCodecStrings: [descriptor.videoCodec, descriptor.audioCodec].filter((value): value is string => !!value),
      requiredPipelines: pipelinesFor(descriptor),
      requiresCustomHeaders: Object.keys(descriptor.headers ?? {}).some((key) => !/^accept(?:-language)?$/i.test(key)),
    };
    const privateSource: PrivateMediaSource = {
      input: target.reference,
      originalUrl: descriptor.originalUrl,
      finalUrl: descriptor.finalUrl,
      headers: descriptor.headers,
      credentialOrigins: descriptor.credentialOrigins,
      providerId: this.id,
    };
    return { privateSource, descriptor, candidates: [candidate], sourceReference: target.reference };
  }

  async cleanup(context: ProviderContext, sourceGeneration: number): Promise<void> {
    assertProviderActive(context);
    void sourceGeneration;
  }
}
