import { assertPublicUrl } from '../../proxy/safe-fetch';
import { probeMediaUrl } from '../probe';
import type { MediaCandidate, MediaDescriptor, ResolverContext, SourceResolver } from '../types';
import { ResolverNotApplicableError } from '../types';
import { scoreMediaCandidate } from '../candidates';
import { createBrowserSafeProxy } from './browser-safe-proxy';

const MEDIA_URL_HINT = /(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.flv|videoplayback|playurl)(?:[?#&/]|$)/i;
const MEDIA_TYPE_HINT = /(?:video\/|audio\/|mpegurl|dash\+xml|octet-stream)/i;
const MAX_JSON_BYTES = 1024 * 1024;
let activeBrowsers = 0;

function discoverJsonUrls(value: unknown, add: (url: string) => void, depth = 0): void {
  if (depth > 8 || value === null) return;
  if (typeof value === 'string') { if (/^https?:\/\//i.test(value) && MEDIA_URL_HINT.test(value)) add(value); return; }
  if (Array.isArray(value)) { value.forEach((item) => discoverJsonUrls(item, add, depth + 1)); return; }
  if (typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => discoverJsonUrls(item, add, depth + 1));
}

export function safeForwardHeaders(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['referer', 'origin', 'user-agent', 'cookie']) {
    if (input[name]) result[name === 'user-agent' ? 'User-Agent' : name[0].toUpperCase() + name.slice(1)] = input[name];
  }
  return result;
}

export function boundedJsonContentLength(headers: Record<string, string>): number | undefined {
  const raw = headers['content-length'];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 && length <= MAX_JSON_BYTES ? length : undefined;
}

interface BrowserBodyResponse {
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

export async function readBoundedJsonBody(response: BrowserBodyResponse): Promise<unknown | undefined> {
  if (boundedJsonContentLength(response.headers()) === undefined) return undefined;
  const body = await response.body();
  if (body.length > MAX_JSON_BYTES) return undefined;
  try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

interface BrowserCookie {
  name: string;
  value: string;
}

interface BrowserCookieContext {
  cookies(url: string): Promise<BrowserCookie[]>;
}

/**
 * A URL discovered inside an API JSON response is a new browser destination.
 * Ask Chromium which cookies match that exact URL instead of copying the API
 * request Cookie header (which could belong to another domain or path).
 */
export async function headersForJsonCandidate(
  candidateUrl: string,
  apiRequestHeaders: Record<string, string>,
  browserContext: BrowserCookieContext,
): Promise<Record<string, string>> {
  const source = safeForwardHeaders(apiRequestHeaders);
  const result: Record<string, string> = {};
  if (source['User-Agent']) result['User-Agent'] = source['User-Agent'];
  if (source.Referer) result.Referer = source.Referer;
  const cookies = await browserContext.cookies(candidateUrl);
  if (cookies.length) result.Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  return result;
}

/** Optional JS resolver. Disabled unless MEDIA_BROWSER_RESOLVER=true. */
export class BrowserResolver implements SourceResolver {
  readonly name = 'browser';
  constructor(private readonly runtime?: { playwright: any; createProxy?: typeof createBrowserSafeProxy }) {}
  canHandle(input: string): boolean {
    if (process.env.MEDIA_BROWSER_RESOLVER !== 'true') return false;
    try { return ['http:', 'https:'].includes(new URL(input).protocol); } catch { return false; }
  }

  async resolve(input: string, context: ResolverContext): Promise<MediaDescriptor> {
    if (!context.browserSniff) throw new ResolverNotApplicableError('浏览器嗅探未请求');
    await assertPublicUrl(input);
    let playwright: { chromium: { launch(options: { headless: boolean; executablePath?: string; proxy?: { server: string }; args?: string[] }): Promise<any> } };
    try { playwright = this.runtime?.playwright ?? require('playwright') as typeof playwright; }
    catch { throw new Error('Browser Resolver 未安装 Playwright/Chromium'); }
    const limit = Math.max(1, Number(process.env.MEDIA_BROWSER_MAX_CONCURRENCY) || 1);
    if (activeBrowsers >= limit) throw new Error('Browser Resolver 正忙，请稍后重试');
    activeBrowsers += 1;
    let browser: any;
    let pageContext: any;
    let safeProxy: Awaited<ReturnType<typeof createBrowserSafeProxy>> | undefined;
    try {
      safeProxy = await (this.runtime?.createProxy ?? createBrowserSafeProxy)();
      browser = await playwright.chromium.launch({
        headless: true,
        proxy: { server: safeProxy.url },
        args: [
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {}),
      });
      pageContext = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await safeProxy?.close().catch(() => undefined);
      activeBrowsers -= 1;
      throw error;
    }
    const page = await pageContext.newPage();
    const candidates = new Map<string, MediaCandidate>();
    const candidateHeaders = new Map<string, Record<string, string>>();
    const pendingResponses = new Set<Promise<void>>();
    try {
      if (context.signal?.aborted) throw new Error('browser resolution cancelled');
      await page.route('**/*', async (route: any) => {
        const requestUrl = route.request().url();
        if (!/^https?:/i.test(requestUrl)) return route.continue();
        try { await assertPublicUrl(requestUrl); await route.continue(); }
        catch { await route.abort('blockedbyclient'); }
      });
      page.on('response', (response: any) => {
        const task = (async () => {
          const url = response.url();
          const responseHeaders = response.headers() as Record<string, string>;
          const contentType = responseHeaders['content-type'] ?? '';
          // headers() can omit Cookie and other browser-managed request headers.
          const allRequestHeaders = await response.request().allHeaders() as Record<string, string>;
          const requestHeaders = safeForwardHeaders(allRequestHeaders);
          const add = (
            candidateUrl: string,
            baseScore: number,
            reason: string,
            headers: Record<string, string>,
          ) => {
            if (/\.(?:m4s|ts)(?:[?#]|$)/i.test(candidateUrl)) return;
            const score = scoreMediaCandidate(candidateUrl, baseScore);
            const existing = candidates.get(candidateUrl);
            if (!existing || score > existing.score) candidates.set(candidateUrl, { url: candidateUrl, score, reason, contentType });
            candidateHeaders.set(candidateUrl, headers);
          };
          if (MEDIA_URL_HINT.test(url) || MEDIA_TYPE_HINT.test(contentType)) {
            add(url, /mpegurl|dash\+xml|\.m3u8|\.mpd/i.test(`${contentType} ${url}`) ? 120 : /^video\//i.test(contentType) ? 100 : 70, 'browser network response', requestHeaders);
          }
          if (!/application\/json/i.test(contentType)) return;

          // Playwright's body() buffers the whole response. Never call it when
          // Content-Length is absent, invalid or above the hard cap.
          const parsed = await readBoundedJsonBody(response);
          if (parsed === undefined) return;
          const discovered: string[] = [];
          discoverJsonUrls(parsed, (mediaUrl) => discovered.push(mediaUrl));
          for (const mediaUrl of discovered) {
            const headers = await headersForJsonCandidate(mediaUrl, allRequestHeaders, pageContext);
            add(mediaUrl, 85, 'browser playback API', headers);
          }
        })().catch(() => undefined).finally(() => pendingResponses.delete(task));
        pendingResponses.add(task);
      });
      await page.goto(input, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(5_000);
      if (context.signal?.aborted) throw new Error('browser resolution cancelled');
      await Promise.allSettled([...pendingResponses]);
      const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 12);
      for (const candidate of ranked) {
        try {
          const headers = candidateHeaders.get(candidate.url);
          const descriptor = await probeMediaUrl(candidate.url, { headers, sourceType: 'browser-page', resolver: this.name, signal: context.signal });
          if (descriptor.container === 'unknown') continue;
          return { ...descriptor, input, originalUrl: page.url(), candidates: ranked };
        } catch { /* test next candidate */ }
      }
      throw new ResolverNotApplicableError('浏览器网络中未发现可验证的主媒体');
    } finally {
      await pageContext.close();
      await browser.close();
      await safeProxy?.close();
      activeBrowsers -= 1;
    }
  }
}
