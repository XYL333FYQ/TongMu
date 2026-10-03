import * as cheerio from 'cheerio';
import { fetchWithProxyPolicy } from '../../proxy/safe-fetch';
import { probeMediaUrl } from '../probe';
import type { MediaCandidate, MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { ResolverNotApplicableError } from '../types';
import { MediaResolutionError } from '../resolution-error';
import { rankMediaCandidates, scoreMediaCandidate } from '../candidates';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_CANDIDATES_TO_PROBE = 12;
const MEDIA_HINT = /(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.flv|\.m4s|videoplayback|playurl)(?:[?#&/]|$)/i;
const MEDIA_FIELD = /^(?:url|src|file|contentUrl|streamUrl|playUrl|hls|dash|manifest|video)$/i;

function addCandidate(store: Map<string, MediaCandidate>, raw: unknown, base: string, score: number, reason: string): void {
  if (typeof raw !== 'string' || !raw.trim()) return;
  const decoded = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
  let url: URL;
  try { url = new URL(decoded, base); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const value = url.toString();
  const finalScore = scoreMediaCandidate(value, score);
  const previous = store.get(value);
  if (!previous || finalScore > previous.score) store.set(value, { url: value, score: finalScore, reason });
}

function walkJson(value: unknown, base: string, candidates: Map<string, MediaCandidate>, depth = 0): void {
  if (depth > 8 || value === null) return;
  if (Array.isArray(value)) return value.forEach((item) => walkJson(item, base, candidates, depth + 1));
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MEDIA_FIELD.test(key)) addCandidate(candidates, child, base, /contentUrl|streamUrl|playUrl|hls|dash/i.test(key) ? 95 : 75, `JSON field ${key}`);
    walkJson(child, base, candidates, depth + 1);
  }
}

/** Read a JSON player assignment as data, without evaluating the site's code. */
function playerConfigurations(script: string): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [];
  let inspected = 0;
  for (const match of script.matchAll(/\bplayer_[a-zA-Z0-9_]+\s*=\s*(?=\{)/g)) {
    if (inspected++ >= 12) break;
    const start = match.index! + match[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < Math.min(script.length, start + 131_072); end++) {
      const char = script[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const config = JSON.parse(script.slice(start, end + 1));
          if (config && typeof config === 'object' && !Array.isArray(config)) configs.push(config);
        } catch { /* Executable or malformed object literals are not JSON. */ }
        break;
      }
    }
  }
  return configs;
}

function playerMediaUrl(config: Record<string, unknown>): string | undefined {
  if (typeof config.url !== 'string' || config.url.length > 65_536) return undefined;
  let value = config.url;
  try {
    if (config.encrypt === 2 || config.encrypt === '2') {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
      value = Buffer.from(value, 'base64').toString('utf8');
    } else if (config.encrypt !== undefined && ![0, 1, '0', '1'].includes(config.encrypt as number | string)) {
      return undefined;
    }
    // A Base64 envelope can contain an already valid URL. Preserve its escaped
    // signed path/query; only unwrap URI encoding when the URL itself is encoded.
    if (!/^https?:\/\//i.test(value) && [1, 2, '1', '2'].includes(config.encrypt as number | string)) {
      value = decodeURIComponent(value);
    }
  } catch { return undefined; }
  return MEDIA_HINT.test(value) ? value : undefined;
}

async function readHtml(response: Awaited<ReturnType<typeof fetchWithProxyPolicy>>): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.slice(0, MAX_HTML_BYTES - total);
      chunks.push(Buffer.from(part)); total += part.length;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, total).toString('utf8');
}

export class GenericWebResolver implements SourceResolver {
  readonly name = 'generic-web';
  canHandle(input: string): boolean {
    try { return ['http:', 'https:'].includes(new URL(input).protocol); } catch { return false; }
  }

  async resolve(input: string, context: ResolverContext): Promise<MediaDescriptor> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const onAbort = () => controller.abort();
    if (context.signal?.aborted) controller.abort();
    else context.signal?.addEventListener('abort', onAbort, { once: true });
    let pageUrl: string;
    let html: string;
    try {
      const response = await fetchWithProxyPolicy(input, {
        method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 ZViewer/2.0' },
        signal: controller.signal,
      }, 'public-only');
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new MediaResolutionError('ACCESS_DENIED');
        throw new Error(`网页加载失败（HTTP ${response.status}）`);
      }
      pageUrl = response.url || input;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('html') && !contentType.includes('json') && !contentType.includes('text')) {
        await response.body?.cancel();
        throw new ResolverNotApplicableError('响应不是网页');
      }
      html = await readHtml(response);
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', onAbort);
    }
    if (context.signal?.aborted) throw new Error('generic web resolution cancelled');
    const discovered = discoverCandidatesFromHtml(html, pageUrl);
    const ranked = discovered.candidates.slice(0, MAX_CANDIDATES_TO_PROBE);
    const headers = { Referer: pageUrl, Origin: new URL(pageUrl).origin, 'User-Agent': 'Mozilla/5.0 ZViewer/2.0' };
    const probed = await Promise.all(ranked.map(async (candidate) => {
      try {
        const descriptor = await probeMediaUrl(candidate.url, { headers, sourceType: 'web-page', resolver: this.name, signal: context.signal });
        return descriptor.container === 'unknown' ? undefined : { candidate, descriptor };
      } catch { return undefined; }
    }));
    const playable = probed.filter((item): item is { candidate: MediaCandidate; descriptor: MediaDescriptor } => !!item);
    const preferred = rankMediaCandidates(playable.map(item => ({
      ...item.candidate,
      score: item.candidate.score + (['hls', 'dash'].includes(item.descriptor.transport) ? 20 : 0),
    })))[0];
    const selected = playable.find(item => item.candidate.url === preferred?.url);
    if (!selected) throw new ResolverNotApplicableError('网页中未发现可验证的媒体资源');
    return {
      ...selected.descriptor, title: discovered.title || selected.descriptor.title,
      input, originalUrl: pageUrl, resolver: this.name, sourceType: 'web-page',
      candidates: ranked,
    };
  }
}

/** Pure extraction step, separately testable without making network requests. */
export function discoverCandidatesFromHtml(
  html: string,
  pageUrl: string,
): { title?: string; candidates: MediaCandidate[] } {
    const candidates = new Map<string, MediaCandidate>();
    const $ = cheerio.load(html);
    $('video[src], video source[src], source[src]').each((_index, element) => {
      addCandidate(candidates, $(element).attr('src'), pageUrl, 110, `<${element.tagName}> source`);
    });
    $('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"]').each((_index, element) => {
      addCandidate(candidates, $(element).attr('content'), pageUrl, 90, 'video metadata');
    });
    $('script[type="application/ld+json"]').each((_index, element) => {
      try { walkJson(JSON.parse($(element).text()), pageUrl, candidates); } catch { /* malformed site data */ }
    });
    $('script:not([src])').each((_index, element) => {
      for (const config of playerConfigurations($(element).text())) {
        addCandidate(candidates, playerMediaUrl(config), pageUrl, 100, 'encoded player config');
      }
    });
    for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+/g)) {
      if (MEDIA_HINT.test(match[0])) addCandidate(candidates, match[0], pageUrl, /\.m3u8|\.mpd/i.test(match[0]) ? 85 : 65, 'embedded player config');
    }
    return {
      title: $('title').first().text().trim() || undefined,
      candidates: rankMediaCandidates([...candidates.values()]),
    };
}
