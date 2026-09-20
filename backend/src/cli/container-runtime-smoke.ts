import { createServer } from 'node:http';
import { BrowserResolver } from '../services/media/resolvers/browser';
import { GenericWebResolver } from '../services/media/resolvers/generic-web';
import { probeMediaUrl } from '../services/media/probe';
import { ResolverNotApplicableError } from '../services/media/types';

const MP4_MAGIC = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

async function fixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const send = (body: Buffer | string, contentType: string) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      response.setHeader('Content-Type', contentType);
      response.setHeader('Accept-Ranges', 'bytes');
      const range = request.headers.range;
      if (range === 'bytes=0-65535') {
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes 0-${bytes.length - 1}/${bytes.length}`);
      }
      response.setHeader('Content-Length', String(bytes.length));
      if (request.method === 'HEAD') response.end();
      else response.end(bytes);
    };
    if (pathname === '/browser-page') {
      return send('<!doctype html><title>runtime fixture</title><script>fetch("/runtime-media")</script>', 'text/html; charset=utf-8');
    }
    if (pathname === '/runtime-media' || pathname === '/direct.mp4') return send(MP4_MAGIC, 'video/mp4');
    if (pathname === '/hls/master.m3u8') return send('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n', 'application/vnd.apple.mpegurl');
    if (pathname === '/dash/manifest.mpd') return send('<?xml version="1.0"?><MPD type="static"></MPD>', 'application/dash+xml');
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('runtime fixture did not bind TCP');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withFixture<T>(work: (origin: string) => Promise<T>): Promise<T> {
  const fixture = await fixtureServer();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigin = process.env.MEDIA_E2E_FIXTURE_ORIGIN;
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_E2E_FIXTURE_ORIGIN = fixture.origin;
  try { return await work(fixture.origin); }
  finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigin === undefined) delete process.env.MEDIA_E2E_FIXTURE_ORIGIN; else process.env.MEDIA_E2E_FIXTURE_ORIGIN = previousOrigin;
    await fixture.close();
  }
}

export async function runBrowserResolverContainerSmoke(): Promise<Record<string, unknown>> {
  return withFixture(async (origin) => {
    let genericFailedClosed = false;
    try { await new GenericWebResolver().resolve(`${origin}/browser-page`, { userId: 'smoke' }); }
    catch (error) {
      if (!(error instanceof ResolverNotApplicableError)) throw error;
      genericFailedClosed = true;
    }
    if (!genericFailedClosed) throw new Error('static HTTP resolver unexpectedly found the dynamic fixture');
    process.env.MEDIA_BROWSER_RESOLVER = 'true';
    const descriptor = await new BrowserResolver().resolve(`${origin}/browser-page`, { userId: 'smoke', browserSniff: true });
    if (descriptor.container !== 'mp4' || descriptor.transport !== 'direct') throw new Error('BrowserResolver returned the wrong media descriptor');
    return { ok: true, genericFailedClosed, browserFallback: true, container: descriptor.container, transport: descriptor.transport };
  });
}

export async function runMediaContainerSmoke(): Promise<Record<string, unknown>> {
  return withFixture(async (origin) => {
    const cases = [
      ['direct', `${origin}/direct.mp4`],
      ['hls', `${origin}/hls/master.m3u8`],
      ['dash', `${origin}/dash/manifest.mpd`],
    ] as const;
    const results = [];
    for (const [expected, url] of cases) {
      const descriptor = await probeMediaUrl(url, { sourceType: 'container-smoke', resolver: 'probe' });
      if (descriptor.transport !== expected) throw new Error(`media smoke expected ${expected}, received ${descriptor.transport}`);
      results.push({ transport: descriptor.transport, container: descriptor.container, rangeSupported: descriptor.rangeSupported });
    }
    return { ok: true, results };
  });
}
