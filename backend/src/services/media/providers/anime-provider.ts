import { resolveBilibiliVideo } from '../../bilibili/resolver';
import { getAnimeProvider } from '../../anime';
import { getProvider as getAniSubsProvider } from '../../anisubs';
import type { AnimeEpisode, AnimePlaybackUrl } from '../../anime/types';
import { getProvider as getKazumiProvider } from '../../kazumi';
import { assertPublicUrl } from '../../proxy/safe-fetch';
import { BrowserResolver } from '../resolvers/browser';
import type { MediaDescriptor, ResolverContext } from '../types';
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

export type AnimeProviderFamily = 'anisubs' | 'kazumi' | 'anime';

const MAX_REFERENCE_LENGTH = 4096;
const MAX_SELECTOR_LENGTH = 2048;
const VOLATILE_KEY = /(?:url|token|cookie|auth|secret|sign|signature|expires|exp|key)/i;

function stableSelector(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    if (index >= 64) break;
    if (key !== 'episodeUrl' && VOLATILE_KEY.test(key)) continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (String(item).length <= 512) result[key] = item;
    } else if (item && typeof item === 'object') {
      const nested = stableSelector(item, depth + 1);
      if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}

/** Keep provider catalog selectors while removing volatile media inputs. */
export function sanitizeAnimePlaybackParams(value: unknown): Record<string, unknown> {
  return stableSelector(value);
}

export function buildAnimeProviderReference(
  family: AnimeProviderFamily,
  source: string,
  episode: Pick<AnimeEpisode, 'id' | 'title' | 'episodeNumber' | 'playbackParams'>,
): string {
  const query = new URLSearchParams({
    source: source.slice(0, 512),
    episode: episode.id.slice(0, 512),
  });
  const selector = stableSelector(episode.playbackParams);
  if (Object.keys(selector).length) {
    const selectorJson = JSON.stringify(selector);
    if (selectorJson.length > MAX_SELECTOR_LENGTH) throw new Error('番剧 Provider selector 过长');
    query.set('selector', selectorJson);
  }

  // Do not slice the finished URI: selector is JSON and slicing it can create a
  // reference that looks valid but cannot be parsed on the next refresh.
  if (episode.title) query.set('title', episode.title.slice(0, 256));
  if (Number.isFinite(episode.episodeNumber)) query.set('number', String(episode.episodeNumber));
  let reference = `provider://${family}?${query.toString()}`;
  if (reference.length > MAX_REFERENCE_LENGTH && episode.title) {
    query.delete('title');
    reference = `provider://${family}?${query.toString()}`;
  }
  if (reference.length > MAX_REFERENCE_LENGTH && Number.isFinite(episode.episodeNumber)) {
    query.delete('number');
    reference = `provider://${family}?${query.toString()}`;
  }
  if (reference.length > MAX_REFERENCE_LENGTH) throw new Error('番剧 Provider 引用过长');
  return reference;
}

interface ParsedReference {
  family: AnimeProviderFamily;
  source: string;
  episode: AnimeEpisode;
  selectorUrl?: string;
}

function parseReference(input: string): ParsedReference {
  if (input.length > MAX_REFERENCE_LENGTH) throw new Error('番剧 Provider 引用过长');
  const parsed = new URL(input);
  if (parsed.protocol !== 'provider:') throw new Error('番剧 Provider 引用协议无效');
  const family = parsed.hostname.toLowerCase() as AnimeProviderFamily;
  if (!['anisubs', 'kazumi', 'anime'].includes(family)) throw new Error('未知的番剧 Provider');
  const source = parsed.searchParams.get('source')?.trim() ?? '';
  const id = parsed.searchParams.get('episode')?.trim() ?? '';
  if (!source || !id || source.length > 512 || id.length > 512) throw new Error('番剧 Provider 引用缺少稳定标识');
  const rawSelector = parsed.searchParams.get('selector') ?? '{}';
  if (rawSelector.length > MAX_SELECTOR_LENGTH) throw new Error('番剧 Provider selector 过长');
  let selector: Record<string, unknown> = {};
  try {
    const value = JSON.parse(rawSelector);
    selector = stableSelector(value);
  } catch {
    throw new Error('番剧 Provider selector 无效');
  }
  const number = Number(parsed.searchParams.get('number'));
  const selectorUrl = typeof selector.episodeUrl === 'string' ? selector.episodeUrl : undefined;
  if (selectorUrl) {
    let parsedSelectorUrl: URL;
    try {
      parsedSelectorUrl = new URL(selectorUrl);
    } catch {
      throw new Error('番剧 Provider episode URL 无效');
    }
    if (!['http:', 'https:'].includes(parsedSelectorUrl.protocol)) {
      throw new Error('番剧 Provider episode URL 协议无效');
    }
  }
  return {
    family,
    source,
    episode: {
      id,
      title: parsed.searchParams.get('title')?.slice(0, 256) ?? id,
      episodeNumber: Number.isFinite(number) ? number : 1,
      playbackParams: selector,
    },
    selectorUrl,
  };
}

function formatFacts(result: AnimePlaybackUrl, input: string): Pick<MediaDescriptor, 'transport' | 'container'> {
  const format = result.format ?? (/\.m3u8(?:[?#]|$)/i.test(result.url) ? 'hls' : /\.flv(?:[?#]|$)/i.test(result.url) ? 'flv' : /\.mp4(?:[?#]|$)/i.test(result.url) ? 'mp4' : 'unknown');
  if (format === 'hls') return { transport: 'hls', container: 'hls' };
  if (format === 'flv') return { transport: 'flv', container: 'flv' };
  if (format === 'dash') return { transport: 'dash', container: 'dash' };
  if (format === 'mp4') return { transport: 'direct', container: 'mp4' };
  void input;
  return { transport: 'direct', container: 'unknown' };
}

function pipelinesFor(transport: MediaDescriptor['transport']): PlaybackCandidate['requiredPipelines'] {
  if (transport === 'hls') return ['native', 'mse'];
  if (transport === 'dash' || transport === 'flv') return ['mse'];
  return ['native'];
}

function asAnimeEpisode(episode: AnimeEpisode): AnimeEpisode {
  return { ...episode, playbackParams: stableSelector(episode.playbackParams) };
}

async function resolveBilibiliBangumi(
  episode: AnimeEpisode,
  context: ProviderContext,
  privateContext: ProviderPrivateContext,
): Promise<AnimePlaybackUrl> {
  const bvid = episode.playbackParams.bvid;
  const cid = episode.playbackParams.cid;
  if (typeof bvid !== 'string' || typeof cid !== 'number' || cid <= 0) throw new Error('缺少有效的 B站番剧 BV/CID 参数');
  const resolved = await resolveBilibiliVideo({
    url: `https://www.bilibili.com/video/${bvid}`,
    userId: context.userId,
    cookie: privateContext.providerCookie,
    qn: context.requestedQn,
    preferMp4: context.preferMp4,
    page: context.page,
    cid,
    playbackClientProfile: context.profile,
  });
  return {
    url: resolved.videoUrl,
    audioUrl: resolved.audioUrl,
    format: resolved.format,
    videoCodec: resolved.videoCodec,
    audioCodec: resolved.audioCodec,
    duration: resolved.duration,
  };
}

export class AnimeProvider implements MediaProvider {
  readonly id: string;
  readonly sourceKinds = ['anime', 'anisubs', 'kazumi'] as const;

  constructor(private readonly family: AnimeProviderFamily, id = family) {
    this.id = id;
  }

  canHandle(input: string): boolean {
    return input.trim().toLowerCase().startsWith(`provider://${this.family}?`);
  }

  validateInput(_context: ProviderContext, input: string): void {
    if (!this.canHandle(input) || input.length > MAX_REFERENCE_LENGTH) throw new Error('番剧 Provider 引用无效');
    parseReference(input);
  }

  normalizeInput(input: string): string { return input.trim(); }

  credentialDependencies(_context: ProviderContext, _input: string): ProviderCredentialDependency[] {
    return this.family === 'anime'
      ? [{ providerId: 'anime', owner: 'current-viewer', requirement: 'optional', scope: 'playback' }]
      : [];
  }

  availability(_context: ProviderContext): ProviderAvailability { return { available: true }; }

  async resolve(context: ProviderContext, input: string, privateContext: ProviderPrivateContext): Promise<ProviderResolution> {
    assertProviderActive(context);
    const parsed = parseReference(input);
    let result: AnimePlaybackUrl | null = null;
    try {
      if (parsed.family === 'anime' && parsed.source === 'bilibili_bangumi') {
        result = await resolveBilibiliBangumi(parsed.episode, context, privateContext);
      } else {
        const episode = asAnimeEpisode(parsed.episode);
        const provider = parsed.family === 'anisubs'
          ? await getAniSubsProvider(parsed.source)
          : parsed.family === 'kazumi'
            ? await getKazumiProvider(parsed.source)
            : await getAnimeProvider(parsed.source);
        if (!provider) throw new Error(`番剧数据源不可用: ${parsed.source}`);
        result = await provider.getPlaybackUrl(episode, { signal: context.signal, deadline: context.deadline });
      }
    } catch (error) {
      if (process.env.MEDIA_BROWSER_RESOLVER !== 'true' || !parsed.selectorUrl) throw error;
      const browser = new BrowserResolver();
      const fallback = await browser.resolve(parsed.selectorUrl, {
        userId: context.userId ?? '',
        browserSniff: true,
        signal: context.signal,
        deadline: context.deadline,
        playbackClientProfile: context.profile,
      } as ResolverContext);
      result = { url: fallback.finalUrl, format: fallback.transport === 'hls' ? 'hls' : fallback.container === 'flv' ? 'flv' : fallback.container === 'mp4' ? 'mp4' : 'unknown' };
    }
    assertProviderActive(context);
    if (!result?.url) throw new Error('番剧数据源未返回播放地址');
    await assertPublicUrl(result.url);
    if (result.audioUrl) await assertPublicUrl(result.audioUrl);
    const facts = formatFacts(result, input);
    const descriptor: MediaDescriptor = {
      title: parsed.episode.title,
      sourceType: parsed.family,
      resolver: this.id,
      input,
      originalUrl: result.url,
      finalUrl: result.url,
      audioUrl: result.audioUrl,
      ...facts,
      contentType: facts.transport === 'hls' ? 'application/vnd.apple.mpegurl' : undefined,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      duration: result.duration,
      drm: { protected: false },
      expiresAt: Date.now() + 10 * 60_000,
      headers: result.headers,
      credentialOrigins: result.headers ? [new URL(result.url).origin] : undefined,
      probe: { method: 'resolver', bytesRead: 0, warnings: [] },
    };
    const candidate: PlaybackCandidate = {
      mode: 'DIRECT',
      url: result.url,
      audioUrl: result.audioUrl,
      transport: facts.transport,
      container: facts.container,
      exactCodecStrings: [result.videoCodec, result.audioCodec].filter((value): value is string => !!value),
      requiredPipelines: pipelinesFor(facts.transport),
      requiresCustomHeaders: Object.keys(result.headers ?? {}).some((key) => !/^accept(?:-language)?$/i.test(key)),
    };
    const privateSource: PrivateMediaSource = {
      input,
      originalUrl: result.url,
      finalUrl: result.url,
      headers: result.headers,
      credentialOrigins: descriptor.credentialOrigins,
      providerId: this.id,
      providerData: { family: parsed.family, source: parsed.source, episodeId: parsed.episode.id },
    };
    return { privateSource, descriptor, candidates: [candidate], sourceReference: input };
  }

  async cleanup(context: ProviderContext, sourceGeneration: number): Promise<void> {
    assertProviderActive(context);
    void sourceGeneration;
  }
}

export class AniSubsProvider extends AnimeProvider {
  constructor() { super('anisubs', 'anisubs'); }
}

export class KazumiProvider extends AnimeProvider {
  constructor() { super('kazumi', 'kazumi'); }
}
