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

function safeForwardHeaders(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['referer', 'origin', 'user-agent', 'cookie']) {
    if (input[name]) result[name === 'user-agent' ? 'User-Agent' : name[0].toUpperCase() + name.slice(1)] = input[name];
  }
  return result;
}

/** Optional JS resolver. Disabled unless MEDIA_BROWSER_RESOLVER=true. */
export class BrowserResolver implements SourceResolver {
  readonly name = 'browser';
  canHandle(input: string): boolean {
    if (process.env.MEDIA_BROWSER_RESOLVER !== 'true') return false;
    try { return ['http:', 'https:'].includes(new URL(input).protocol); } catch { return false; }
  }

  async resolve(input: string, context: ResolverContext): Promise<MediaDescriptor> {
    if (!context.browserSniff) throw new ResolverNotApplicableError('浏览器嗅探未请求');
    await assertPublicUrl(input);
    let playwright: { chromium: { launch(options: { headless: boolean; executablePath?: string; proxy?: { server: string }; args?: string[] }): Promise<any> } };
    try { playwright = require('playwright') as typeof playwright; }
    catch { throw new Error('Browser Resolver 未安装 Playwright/Chromium'); }
    const limit = Math.max(1, Number(process.env.MEDIA_BROWSER_MAX_CONCURRENCY) || 1);
    if (activeBrowsers >= limit) throw new Error('Browser Resolver 正忙，请稍后重试');
    activeBrowsers += 1;
    let browser: any;
    let pageContext: any;
    let safeProxy: Awaited<ReturnType<typeof createBrowserSafeProxy>> | undefined;
    try {
      safeProxy = await createBrowserSafeProxy();
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
      await page.route('**/*', async (route: any) => {
        const requestUrl = route.request().url();
        if (!/^https?:/i.test(requestUrl)) return route.continue();
        try { await assertPublicUrl(requestUrl); await route.continue(); }
        catch { await route.abort('blockedbyclient'); }
      });
      page.on('response', (response: any) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] ?? '';
        const requestHeaders = safeForwardHeaders(response.request().headers());
        const add = (candidateUrl: string, baseScore: number, reason: string) => {
          if (/\.(?:m4s|ts)(?:[?#]|$)/i.test(candidateUrl)) return;
          const score = scoreMediaCandidate(candidateUrl, baseScore);
          const existing = candidates.get(candidateUrl);
          if (!existing || score > existing.score) candidates.set(candidateUrl, { url: candidateUrl, score, reason, contentType });
          candidateHeaders.set(candidateUrl, requestHeaders);
        };
        if (MEDIA_URL_HINT.test(url) || MEDIA_TYPE_HINT.test(contentType)) {
          add(url, /mpegurl|dash\+xml|\.m3u8|\.mpd/i.test(`${contentType} ${url}`) ? 120 : /^video\//i.test(contentType) ? 100 : 70, 'browser network response');
        }
        if (/application\/json/i.test(contentType)) {
          const length = Number(response.headers()['content-length'] || 0);
          if (length > MAX_JSON_BYTES) return;
          const task = response.body().then((body: Buffer) => {
            if (body.length > MAX_JSON_BYTES) return;
            try { discoverJsonUrls(JSON.parse(body.toString('utf8')), (mediaUrl) => add(mediaUrl, 85, 'browser playback API')); } catch { /* non-JSON body */ }
          }).catch(() => undefined).finally(() => pendingResponses.delete(task));
          pendingResponses.add(task);
        }
      });
      await page.goto(input, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(5_000);
      await Promise.allSettled([...pendingResponses]);
      const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 12);
      for (const candidate of ranked) {
        try {
          const headers = candidateHeaders.get(candidate.url);
          const descriptor = await probeMediaUrl(candidate.url, { headers, sourceType: 'browser-page', resolver: this.name });
          if (descriptor.container === 'unknown') continue;
          return { ...descriptor, input, originalUrl: page.url(), headers, candidates: ranked };
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
