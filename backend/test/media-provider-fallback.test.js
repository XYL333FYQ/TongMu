const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { MediaProviderRegistry, providerContextFromResolverContext } = require('../dist/services/media/providers/registry');
const { LegacyResolverAdapter } = require('../dist/services/media/providers/legacy-resolver-adapter');
const { GenericWebResolver } = require('../dist/services/media/resolvers/generic-web');
const { DirectUrlResolver } = require('../dist/services/media/resolvers/direct-url');
const { ResolverNotApplicableError } = require('../dist/services/media/types');
const { MediaResolutionError } = require('../dist/services/media/resolution-error');
const { ProxyTargetError } = require('../dist/services/proxy/safe-fetch');

const mp4 = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const adapter = (id, resolver) => new LegacyResolverAdapter({ id, sourceKinds: ['web-page'], resolver });
const context = (browserSniff, options = {}) => providerContextFromResolverContext({
  userId: 'fixture', browserSniff, deadline: Date.now() + 10_000, ...options,
});

async function withHttpFixture(work) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/page') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Dynamic fixture</title><script>fetch("/movie.mp4")</script>');
    } else if (request.url === '/denied') {
      response.statusCode = 403; response.end();
    } else if (request.url === '/movie.mp4') {
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Content-Length', mp4.length);
      if (request.method === 'HEAD') response.end(); else response.end(mp4);
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const priorEnv = process.env.NODE_ENV;
  const priorOrigin = process.env.MEDIA_E2E_FIXTURE_ORIGIN;
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_E2E_FIXTURE_ORIGIN = origin;
  try { await work(origin, requests); }
  finally {
    if (priorEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnv;
    if (priorOrigin === undefined) delete process.env.MEDIA_E2E_FIXTURE_ORIGIN; else process.env.MEDIA_E2E_FIXTURE_ORIGIN = priorOrigin;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('one resolution falls through real GenericWeb HTTP failure to Browser with browserSniff=true', async () => {
  await withHttpFixture(async (origin, requests) => {
    const seen = [];
    const browser = adapter('browser', {
      name: 'browser', canHandle: () => true,
      resolve: async (input, resolverContext) => {
        seen.push({ input, browserSniff: resolverContext.browserSniff });
        if (!resolverContext.browserSniff) throw new ResolverNotApplicableError('browser sniff not requested');
        return { input, originalUrl: input, finalUrl: `${origin}/movie.mp4`, title: 'Dynamic fixture',
          transport: 'direct', container: 'mp4', sourceType: 'browser-page', resolver: 'browser',
          headers: {}, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] } };
      },
    });
    const registry = new MediaProviderRegistry([adapter('generic-web', new GenericWebResolver()), browser]);
    const result = await registry.resolveProvider(`${origin}/page`, context(true), {});
    assert.equal(result.descriptor.resolver, 'browser');
    assert.equal(result.candidates[0].url, `${origin}/movie.mp4`);
    assert.deepEqual(seen, [{ input: `${origin}/page`, browserSniff: true }]);
    assert.deepEqual(requests, ['GET /page']);
  });
});

test('browserSniff=false reaches the adapter as false and does not produce browser media', async () => {
  await withHttpFixture(async (origin) => {
    let observed;
    const browser = adapter('browser', { name: 'browser', canHandle: () => true,
      resolve: async (_input, resolverContext) => {
        observed = resolverContext.browserSniff;
        throw new ResolverNotApplicableError('browser sniff not requested');
      },
    });
    const registry = new MediaProviderRegistry([adapter('generic-web', new GenericWebResolver()), browser]);
    await assert.rejects(registry.resolveProvider(`${origin}/page`, context(false), {}),
      (error) => error instanceof MediaResolutionError && error.code === 'NO_MEDIA_FOUND');
    assert.equal(observed, false);
  });
});

test('cancellation and expired deadline stop fallback before Browser', async () => {
  let browserCalls = 0;
  const generic = adapter('generic-web', { name: 'generic-web', canHandle: () => true,
    resolve: async (_input, resolverContext) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (resolverContext.signal.aborted) throw new Error('generic cancelled');
      throw new ResolverNotApplicableError('no static media');
    },
  });
  const browser = adapter('browser', { name: 'browser', canHandle: () => true,
    resolve: async () => { browserCalls++; throw new Error('should not run'); },
  });
  const registry = new MediaProviderRegistry([generic, browser]);
  const controller = new AbortController();
  const cancelled = registry.resolveProvider('https://example.com/page', context(true, { signal: controller.signal }), {});
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(cancelled, (error) => error instanceof MediaResolutionError && error.code === 'CANCELLED');
  await assert.rejects(registry.resolveProvider('https://example.com/page', context(true, { deadline: Date.now() + 1 }), {}),
    (error) => error instanceof MediaResolutionError && error.code === 'TIMEOUT');
  assert.equal(browserCalls, 0);
});

test('known access and safety failures stop fallback with stable codes', async () => {
  await withHttpFixture(async (origin) => {
    let browserCalls = 0;
    const browser = adapter('browser', { name: 'browser', canHandle: () => true,
      resolve: async () => { browserCalls++; throw new Error('unexpected browser'); },
    });
    const registry = new MediaProviderRegistry([adapter('generic-web', new GenericWebResolver()), browser]);
    await assert.rejects(registry.resolveProvider(`${origin}/denied`, context(true), {}),
      (error) => error instanceof MediaResolutionError && error.code === 'ACCESS_DENIED' && !error.retryable);
    assert.equal(browserCalls, 0);
    const blocked = adapter('generic-web', { name: 'generic-web', canHandle: () => true,
      resolve: async () => { throw new ProxyTargetError('blocked fixture'); },
    });
    await assert.rejects(new MediaProviderRegistry([blocked, browser]).resolveProvider(`${origin}/page`, context(true), {}),
      (error) => error instanceof MediaResolutionError && error.code === 'TARGET_BLOCKED' && !error.retryable);
    assert.equal(browserCalls, 0);
  });
});

test('existing direct media succeeds without invoking GenericWeb or Browser', async () => {
  await withHttpFixture(async (origin, requests) => {
    let fallbackCalls = 0;
    const unwanted = (name) => adapter(name, { name, canHandle: () => true,
      resolve: async () => { fallbackCalls++; throw new Error('unexpected fallback'); },
    });
    const registry = new MediaProviderRegistry([
      adapter('direct-url', new DirectUrlResolver()), unwanted('generic-web'), unwanted('browser'),
    ]);
    const result = await registry.resolveProvider(`${origin}/movie.mp4`, context(true), {});
    assert.equal(result.descriptor.resolver, 'direct-url');
    assert.equal(fallbackCalls, 0);
    assert.ok(requests.some((request) => request.endsWith('/movie.mp4')));
  });
});
