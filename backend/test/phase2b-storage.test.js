const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const test = require('node:test');

const { legacyPlaybackClientProfile } = require('../dist/services/media/playback-profile');
const { toPublicDescriptor } = require('../dist/routes/stream/media');
const {
  FtpProvider,
  LocalFileProvider,
  OpenListProvider,
  WebDavProvider,
} = require('../dist/services/media/providers/storage-providers');
const {
  buildStorageReference,
  canPublishStorageDirectUrl,
  classifyPlaybackUrl,
  parseStorageReference,
} = require('../dist/services/media/providers/storage-reference');
const { pipeProviderMediaHandle } = require('../dist/services/media/provider-gateway');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function context(overrides = {}) {
  return {
    actor: { kind: 'user', userId: '1' },
    userId: '1',
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    profile: legacyPlaybackClientProfile(),
    credentialOwnerPolicy: 'source-creator',
    safeFetch: global.fetch,
    ...overrides,
  };
}

function fakeMount(overrides = {}) {
  return {
    id: 7,
    userId: 1,
    type: 'webdav',
    serverUrl: 'https://media.example/dav',
    port: null,
    username: null,
    password: null,
    ...overrides,
  };
}

function storageDeps(overrides = {}) {
  return {
    loadMount: async () => fakeMount(),
    statWebDAV: async (_params, signal) => {
      assert.ok(signal instanceof AbortSignal);
      return { name: 'movie.mp4', path: '/movie.mp4', size: 10, lastModified: new Date(1) };
    },
    statFTP: async (_params, signal) => {
      assert.ok(signal instanceof AbortSignal);
      return { name: 'movie.mkv', path: '/movie.mkv', size: 10, lastModified: new Date(1) };
    },
    fetchOpenList: async (_server, _user, _password, _path, signal) => {
      assert.ok(signal instanceof AbortSignal);
      return { rawUrl: 'https://cdn.example/movie.mp4?sign=short&expires=9999999999', name: 'movie.mp4', size: 10, subtitles: [] };
    },
    assertPublicUrl: async (value) => new URL(value),
    ...overrides,
  };
}

test('storage references are credential-free and signed URL visibility is explicit', () => {
  const reference = buildStorageReference({ provider: 'webdav', mountId: 7, path: '/movies/a.mp4' });
  assert.match(reference, /^storage:\/\/webdav\?/);
  assert.equal(reference.includes('password'), false);
  assert.deepEqual(parseStorageReference(reference), { provider: 'webdav', mountId: 7, path: '/movies/a.mp4', rootKey: undefined });
  assert.equal(parseStorageReference('storage://webdav?path=%2e%2e%2fsecret')?.path, '/../secret');
  assert.equal(classifyPlaybackUrl('https://cdn.example/movie.mp4'), 'public');
  assert.equal(classifyPlaybackUrl('https://cdn.example/movie.mp4?sign=x&expires=123'), 'short-lived-bearer');
  assert.equal(classifyPlaybackUrl('https://cdn.example/movie.mp4?access_token=long-secret'), 'credentialed');
  assert.equal(classifyPlaybackUrl('http://192.168.1.10/movie.mp4'), 'private-network');
  assert.equal(canPublishStorageDirectUrl('https://cdn.example/movie.mp4?access_token=long-secret'), false);
});

test('all four storage providers satisfy the common resolution contract without public secrets', async () => {
  const directory = tempDir('tongmu-phase2b-local-');
  fs.writeFileSync(path.join(directory, 'movie.mp4'), Buffer.from('0123456789'));
  const roots = new Map([['uploads', { key: 'uploads', absPath: directory, readonly: false }]]);
  const local = new LocalFileProvider({ loadRoots: async () => roots });
  const webdav = new WebDavProvider(storageDeps());
  const ftp = new FtpProvider(storageDeps({ loadMount: async () => fakeMount({ type: 'ftp', serverUrl: 'ftp://ftp.example', username: 'ftp-user', password: 'ftp-secret' }) }));
  const openlist = new OpenListProvider(storageDeps({ loadMount: async () => fakeMount({ type: 'openlist', serverUrl: 'https://alist.example' }) }));
  const cases = [
    [local, buildStorageReference({ provider: 'local-file', rootKey: 'uploads', path: '/movie.mp4' })],
    [webdav, buildStorageReference({ provider: 'webdav', mountId: 7, path: '/movie.mp4' })],
    [ftp, buildStorageReference({ provider: 'ftp', mountId: 7, path: '/movie.mkv' })],
    [openlist, buildStorageReference({ provider: 'openlist', mountId: 7, path: '/movie.mp4' })],
  ];
  try {
    for (const [provider, input] of cases) {
      const result = await provider.resolve(context({ sourceGeneration: 12 }), input, {});
      assert.equal(result.privateSource.providerId, provider.id);
      assert.equal(result.descriptor.resolver, provider.id);
      assert.equal(result.descriptor.candidates, undefined);
      const publicDescriptor = toPublicDescriptor(
        result.descriptor,
        result.candidates[0]?.url || '/api/stream/media/opaque',
      );
      const serialized = JSON.stringify(publicDescriptor);
      assert.equal(serialized.includes('ftp-secret'), false);
      assert.equal(serialized.includes('ftp-user'), false);
      assert.equal(serialized.includes(directory), false);
      assert.equal(serialized.includes('access_token=long-secret'), false);
      assert.ok(Array.isArray(result.candidates));
    }
    assert.equal((await webdav.resolve(context(), cases[1][1], {})).candidates.length, 1);
    assert.equal((await ftp.resolve(context(), cases[2][1], {})).candidates.length, 0);
    assert.equal((await openlist.resolve(context(), cases[3][1], {})).candidates.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('credentialed/private storage candidates stay proxy-only', async () => {
  const webdav = new WebDavProvider(storageDeps({
    loadMount: async () => fakeMount({ username: 'alice', password: 'webdav-secret' }),
  }));
  const openlist = new OpenListProvider(storageDeps({
    loadMount: async () => fakeMount({ type: 'openlist', serverUrl: 'https://alist.example' }),
    fetchOpenList: async () => ({ rawUrl: 'https://cdn.example/movie.mp4?access_token=long-secret', name: 'movie.mp4', size: 1, subtitles: [] }),
  }));
  const webdavResult = await webdav.resolve(context(), buildStorageReference({ provider: 'webdav', mountId: 7, path: '/movie.mp4' }), {});
  const openlistResult = await openlist.resolve(context(), buildStorageReference({ provider: 'openlist', mountId: 7, path: '/movie.mp4' }), {});
  assert.equal(webdavResult.candidates.length, 0);
  assert.equal(openlistResult.candidates.length, 0);
  assert.equal(JSON.stringify(toPublicDescriptor(webdavResult.descriptor, '/api/stream/media/webdav')).includes('webdav-secret'), false);
  assert.equal(JSON.stringify(toPublicDescriptor(openlistResult.descriptor, '/api/stream/media/openlist')).includes('long-secret'), false);
});

test('provider cancellation reaches storage dependencies', async () => {
  const controller = new AbortController();
  let seenSignal;
  const provider = new OpenListProvider(storageDeps({
    loadMount: async () => fakeMount({ type: 'openlist', serverUrl: 'https://alist.example' }),
    fetchOpenList: async (_server, _user, _password, _path, signal) => {
      seenSignal = signal;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  }));
  const pending = provider.resolve(context({ signal: controller.signal }), buildStorageReference({ provider: 'openlist', mountId: 7, path: '/movie.mp4' }), {});
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(seenSignal, controller.signal);
});

test('Local File gateway preserves full, explicit/open/suffix ranges, HEAD and 416', async (t) => {
  const directory = tempDir('tongmu-phase2b-gateway-');
  const filePath = path.join(directory, 'movie.mp4');
  fs.writeFileSync(filePath, Buffer.from('0123456789'));
  const stat = fs.statSync(filePath);
  const app = express();
  app.all('/media', async (req, res) => pipeProviderMediaHandle(req, res, {
    url: 'storage://local-file?path=%2Fmovie.mp4',
    scope: 'user:1',
    providerId: 'local-file',
    providerData: { filePath, rootPath: directory, fileSize: stat.size, mtimeMs: stat.mtimeMs, contentType: 'video/mp4' },
    expiresAt: Date.now() + 60_000,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/media', method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  t.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const full = await request();
  assert.equal(full.status, 200);
  assert.equal(full.body.toString(), '0123456789');
  const explicit = await request({ Range: 'bytes=2-4' });
  assert.equal(explicit.status, 206);
  assert.equal(explicit.headers['content-range'], 'bytes 2-4/10');
  assert.equal(explicit.body.toString(), '234');
  const open = await request({ Range: 'bytes=7-' });
  assert.equal(open.status, 206);
  assert.equal(open.body.toString(), '789');
  const suffix = await request({ Range: 'bytes=-3' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.toString(), '789');
  const head = await request({ Range: 'bytes=2-4' }, 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.body.length, 0);
  const invalid = await request({ Range: 'bytes=99-100' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['content-range'], 'bytes */10');
});

test('Local File provider rejects traversal and symlink escape', async (t) => {
  const root = tempDir('tongmu-phase2b-root-');
  const outside = tempDir('tongmu-phase2b-outside-');
  fs.writeFileSync(path.join(outside, 'secret.mp4'), 'secret');
  const roots = new Map([['uploads', { key: 'uploads', absPath: root, readonly: false }]]);
  const provider = new LocalFileProvider({ loadRoots: async () => roots });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  await assert.rejects(provider.resolve(context(), buildStorageReference({ provider: 'local-file', path: '/../secret.mp4' }), {}), /越权/);
  try {
    fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(root, 'link.mp4'));
  } catch {
    t.skip('当前 Windows 环境不允许创建测试 symlink');
    return;
  }
  await assert.rejects(provider.resolve(context(), buildStorageReference({ provider: 'local-file', path: '/link.mp4' }), {}), /越权/);
});
