const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');
const test = require('node:test');

const {
  SecretVault,
  SecretVaultError,
} = require('../dist/services/secret-vault');
const {
  parseByteRangeHeader,
  resolveByteRange,
  parseContentRangeHeader,
} = require('../dist/services/proxy/byte-range');
const { parseRangeHeader, pipeRangeStream, sendRangeNotSatisfiable } = require('../dist/services/proxy');
const { proxyHttpUpstream } = require('../dist/services/proxy/http-proxy');
const {
  classifyDatabaseTables,
  MigrationFoundationError,
  runMigrationFoundation,
} = require('../dist/migrations/foundation');
const {
  UpdateNotConfiguredError,
  getUpdateInfo,
} = require('../dist/services/updater');
const { redactMediaError } = require('../dist/services/media/redact');
const {
  __setCredentialVaultForTests,
  clearCredential,
  getCredential,
  getCredentialStatus,
  saveCredential,
} = require('../dist/services/bilibili/credential');
const { AppDataSource } = require('../dist/data-source');
const bilibiliAuthRouter = require('../dist/routes/stream/bilibili-auth').default;
const {
  __setRevocationRepositoryForTests,
  TokenRevocationError,
  authenticateToken,
  generateTokens,
  getTokenRevocationState,
  invalidateUserTokens,
} = require('../dist/middleware/auth');

function tamperVaultEnvelope(value) {
  const parts = value.split(':');
  const original = parts[1][0];
  parts[1] = (original === 'A' ? 'B' : 'A') + parts[1].slice(1);
  return parts.join(':');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('SecretVault uses authenticated, nondeterministic envelopes and persists its key', (t) => {
  const dir = tempDir('tongmu-vault-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = new SecretVault({ configDir: dir });
  const first = vault.encrypt('SESSDATA=top-secret; bili_jct=csrf');
  const second = vault.encrypt('SESSDATA=top-secret; bili_jct=csrf');
  assert.match(first, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.notEqual(first, second);
  assert.equal(vault.decrypt(first), 'SESSDATA=top-secret; bili_jct=csrf');
  assert.equal(new SecretVault({ configDir: dir }).decrypt(first), 'SESSDATA=top-secret; bili_jct=csrf');
  assert.ok(fs.existsSync(path.join(dir, 'secret-vault.json')));
  assert.throws(() => vault.decrypt(tamperVaultEnvelope(first)), SecretVaultError);
  assert.throws(() => new SecretVault({ configDir: dir, masterKey: Buffer.alloc(32, 7) }).decrypt(first), SecretVaultError);
  assert.throws(() => vault.decrypt('v1:not-valid'), SecretVaultError);
});

test('Bilibili legacy credentials read through and migrate without exposing the secret', async (t) => {
  const dir = tempDir('tongmu-credential-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = new SecretVault({ configDir: dir });
  __setCredentialVaultForTests(vault);
  const originalGetRepository = AppDataSource.getRepository;
  let row = {
    id: 1,
    userId: 'user-1',
    cookie: Buffer.from('SESSDATA=legacy-secret; bili_jct=csrf').toString('base64'),
    refreshToken: null,
    updatedAt: new Date(),
  };
  let saves = 0;
  let deleted = false;
  const repository = {
    async findOneBy() { return deleted ? null : row; },
    async save(value) { saves += 1; row = value; return value; },
    create(value) { return { ...value, id: 2, updatedAt: new Date() }; },
    async delete() { deleted = true; },
  };
  AppDataSource.getRepository = () => repository;
  t.after(() => {
    AppDataSource.getRepository = originalGetRepository;
    __setCredentialVaultForTests();
  });

  const legacy = await getCredential('user-1');
  assert.equal(legacy.cookie, 'SESSDATA=legacy-secret; bili_jct=csrf');
  assert.match(row.cookie, /^v1:/);
  assert.equal(saves, 1);
  const status = await getCredentialStatus('user-1');
  assert.deepEqual(status.credentialSource, 'vault');
  assert.equal(status.loggedIn, true);

  await saveCredential('user-1', 'SESSDATA=new-secret; bili_jct=new-csrf');
  assert.match(row.cookie, /^v1:/);
  assert.equal((await getCredential('user-1')).cookie, 'SESSDATA=new-secret; bili_jct=new-csrf');
  await clearCredential('user-1');
  assert.equal((await getCredentialStatus('user-1')).credentialSource, 'none');
});

test('Bilibili legacy migration failure leaves the original value readable', async (t) => {
  const dir = tempDir('tongmu-credential-failure-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  __setCredentialVaultForTests(new SecretVault({ configDir: dir }));
  const originalGetRepository = AppDataSource.getRepository;
  const original = Buffer.from('SESSDATA=keep-me').toString('base64');
  const row = { id: 3, userId: 'user-2', cookie: original, refreshToken: null, updatedAt: new Date() };
  AppDataSource.getRepository = () => ({
    async findOneBy() { return row; },
    async save() { throw new Error('simulated write failure'); },
  });
  t.after(() => {
    AppDataSource.getRepository = originalGetRepository;
    __setCredentialVaultForTests();
  });
  assert.equal((await getCredential('user-2')).cookie, 'SESSDATA=keep-me');
  assert.equal(row.cookie, original);
});

test('Bilibili credential status endpoint never returns the raw cookie', async (t) => {
  const dir = tempDir('tongmu-cookie-api-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = new SecretVault({ configDir: dir });
  __setCredentialVaultForTests(vault);
  const originalGetRepository = AppDataSource.getRepository;
  const rawCookie = 'SESSDATA=api-secret; bili_jct=csrf';
  const row = {
    id: 4,
    userId: 'api-user',
    cookie: vault.encrypt(rawCookie),
    refreshToken: null,
    updatedAt: new Date(),
  };
  AppDataSource.getRepository = () => ({ async findOneBy() { return row; } });
  t.after(() => {
    AppDataSource.getRepository = originalGetRepository;
    __setCredentialVaultForTests();
  });

  const app = express();
  app.use((req, _res, next) => { req.user = { userId: 'api-user', role: 'user' }; next(); });
  app.use(bilibiliAuthRouter);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());
  const response = await request(port, '/bilibili/cookie');
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body.toString());
  assert.equal(body.loggedIn, true);
  assert.equal(body.cookie, undefined);
  assert.equal(response.body.toString().includes(rawCookie), false);
});

test('ByteRange parses before resolving and preserves suffix/open-ended/multi semantics', () => {
  assert.deepEqual(parseByteRangeHeader('bytes=0-99'), { kind: 'explicit', start: 0, end: 99 });
  assert.deepEqual(parseByteRangeHeader(' Bytes = 100- '), { kind: 'open-ended', start: 100 });
  assert.deepEqual(parseByteRangeHeader('bytes=-500'), { kind: 'suffix', length: 500 });
  assert.deepEqual(parseByteRangeHeader('bytes=0-10,20-30').kind, 'multi');
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=-500'), 1000).range.start, 500);
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=-500'), 100).range.start, 0);
  assert.deepEqual(resolveByteRange(parseByteRangeHeader('bytes=100-'), 150), {
    kind: 'single',
    range: { start: 100, end: 149, total: 150, length: 50 },
  });
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=150-'), 150).kind, 'unsatisfiable');
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=-0'), 150).kind, 'unsatisfiable');
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=0-'), 0).kind, 'unsatisfiable');
  assert.equal(parseByteRangeHeader('bytes=999999999999999999999-').reason, 'overflow');
  assert.equal(parseByteRangeHeader('bytes=wat').reason, 'malformed');
  assert.equal(resolveByteRange(parseByteRangeHeader('bytes=0-10,20-30'), 100).kind, 'multi');
  assert.deepEqual(parseContentRangeHeader('bytes 2-4/10'), { start: 2, end: 4, total: 10 });
  assert.equal(parseContentRangeHeader('bytes 2-4/*'), null);
});

test('HTTP proxy validates suffix 206 and never collapses multi-range or bad Content-Range', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/suffix') {
      assert.equal(req.headers.range, 'bytes=-3');
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 7-9/10',
        'Content-Length': '3',
      });
      res.end('789');
      return;
    }
    if (req.url === '/bad') {
      res.writeHead(206, { 'Content-Range': 'bytes 2-9/10', 'Content-Length': '8' });
      res.end('bad-range');
      return;
    }
    if (req.url === '/multi') {
      res.writeHead(206, {
        'Content-Type': 'multipart/byteranges; boundary=x',
        'Content-Length': '5',
      });
      res.end('multi');
      return;
    }
    res.writeHead(200, { 'Content-Length': '10' });
    res.end('0123456789');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const app = express();
  app.get('/proxy', (req, res) => proxyHttpUpstream(req, res, {
    url: `http://127.0.0.1:${upstreamPort}${req.query.target}`,
    targetPolicy: 'trusted-private',
    trustedPrivateHosts: ['127.0.0.1'],
    logTag: 'phase1-range-test',
    errorMessage: 'proxy failed',
  }));
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());

  const suffix = await request(gatewayPort, '/proxy?target=%2Fsuffix', { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], 'bytes 7-9/10');
  assert.equal(suffix.headers['content-length'], '3');
  assert.equal(suffix.body.toString(), '789');

  const bad = await request(gatewayPort, '/proxy?target=%2Fbad', { headers: { Range: 'bytes=2-3' } });
  assert.equal(bad.status, 502);
  assert.match(bad.body.toString(), /Content-Range/);

  const multi = await request(gatewayPort, '/proxy?target=%2Fmulti', { headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(multi.status, 206);
  assert.match(multi.headers['content-type'], /multipart\/byteranges/);
  assert.equal(multi.body.toString(), 'multi');

  const ignored = await request(gatewayPort, '/proxy?target=%2Fignored', { headers: { Range: 'bytes=-3' } });
  assert.equal(ignored.status, 502);
});

test('shared local stream emits exact 200/206/416 and HEAD semantics', async (t) => {
  const body = Buffer.from('0123456789');
  const app = express();
  app.all('/file', (req, res) => {
    const parsed = parseRangeHeader(req.headers.range, body.length);
    if (parsed === 'invalid') {
      sendRangeNotSatisfiable(res, body.length);
      return;
    }
    const ranged = !!req.headers.range && !!parsed;
    const start = ranged ? parsed.start : 0;
    const end = ranged ? parsed.end : body.length - 1;
    pipeRangeStream(res, {
      stream: Readable.from([body.subarray(start, end + 1)]),
      contentType: 'video/mp4',
      fileSize: body.length,
      start,
      end,
      ranged,
      logTag: 'phase1-local-range-test',
      errorMessage: 'local stream failed',
    });
  });
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => server.close());

  const full = await request(port, '/file');
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-length'], '10');
  assert.equal(full.body.toString(), '0123456789');

  const suffix = await request(port, '/file', { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], 'bytes 7-9/10');
  assert.equal(suffix.headers['content-length'], '3');
  assert.equal(suffix.body.toString(), '789');

  const head = await request(port, '/file', { method: 'HEAD', headers: { Range: 'bytes=2-4' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], 'bytes 2-4/10');
  assert.equal(head.headers['content-length'], '3');
  assert.equal(head.body.length, 0);

  const multi = await request(port, '/file', { headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(multi.status, 416);
  assert.equal(multi.headers['content-range'], 'bytes */10');
});

test('token revocation and migration foundation fail closed and are retryable', async () => {
  assert.equal(classifyDatabaseTables([]), 'fresh');
  assert.equal(classifyDatabaseTables(['migrations', 'user']), 'existing');

  let tables = ['migrations'];
  let runs = 0;
  const dataSource = {
    createQueryRunner() {
      return {
        async getTables() { return tables.map((name) => ({ name })); },
        async query() { return []; },
        async release() {},
      };
    },
    async runMigrations() { runs += 1; tables = ['migrations', 'user']; return [{ name: 'm1' }]; },
  };
  const result = await runMigrationFoundation(dataSource);
  assert.equal(result.before.installState, 'fresh');
  assert.equal(result.after.installState, 'existing');
  assert.deepEqual(result.executed, ['m1']);
  assert.equal(runs, 1);

  const failing = {
    createQueryRunner: dataSource.createQueryRunner,
    async runMigrations() { throw new Error('migration interrupted'); },
  };
  await assert.rejects(runMigrationFoundation(failing), MigrationFoundationError);
});

test('token revocation waits for authoritative state, deduplicates cold lookups, and fails closed', async (t) => {
  let calls = 0;
  let mode = 'ok';
  const repository = {
    async findOneBy() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (mode === 'error') throw new Error('database unavailable');
      return { tokenInvalidBefore: mode === 'revoked' ? new Date(Date.now() + 5000) : null };
    },
    async update() {
      if (mode === 'error') throw new Error('database unavailable');
    },
  };
  __setRevocationRepositoryForTests(repository);
  t.after(() => __setRevocationRepositoryForTests());

  const states = await Promise.all([
    getTokenRevocationState(77),
    getTokenRevocationState(77),
    getTokenRevocationState(77),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(states[0], { exists: true, value: null });

  mode = 'error';
  await assert.rejects(getTokenRevocationState(78), TokenRevocationError);

  mode = 'revoked';
  const token = generateTokens(77, 'user').accessToken;
  __setRevocationRepositoryForTests(repository);
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  await authenticateToken({
    headers: { authorization: `Bearer ${token}` },
    query: {},
    cookies: {},
    secure: false,
  }, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);

  mode = 'error';
  __setRevocationRepositoryForTests(repository);
  const unavailable = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await authenticateToken({ headers: { authorization: `Bearer ${token}` }, query: {}, cookies: {}, secure: false }, unavailable, () => {});
  assert.equal(unavailable.statusCode, 503);
  await assert.rejects(invalidateUserTokens(77), TokenRevocationError);
});

test('token revocation does not return a stale in-flight lookup after invalidation', async (t) => {
  let releaseLookup;
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  const repository = {
    async findOneBy() {
      lookupStarted();
      await new Promise((resolve) => { releaseLookup = resolve; });
      return { tokenInvalidBefore: null };
    },
    async update() {
      return undefined;
    },
  };
  __setRevocationRepositoryForTests(repository);
  t.after(() => __setRevocationRepositoryForTests());

  const pending = getTokenRevocationState(88);
  await started;
  await invalidateUserTokens(88);
  releaseLookup();
  const state = await pending;
  assert.equal(state.exists, true);
  assert.equal(typeof state.value, 'number');
  assert.ok(state.value > 0);
});

test('automatic updater is disabled until an explicit non-ZViewer source exists', async () => {
  const previous = process.env.TONGMU_UPDATE_REPOSITORY;
  delete process.env.TONGMU_UPDATE_REPOSITORY;
  await assert.rejects(getUpdateInfo(), UpdateNotConfiguredError);
  process.env.TONGMU_UPDATE_REPOSITORY = 'Zero-wyc/ZViewer';
  await assert.rejects(getUpdateInfo(), UpdateNotConfiguredError);
  if (previous === undefined) delete process.env.TONGMU_UPDATE_REPOSITORY;
  else process.env.TONGMU_UPDATE_REPOSITORY = previous;
});

test('updater and release workflow have no implicit ZViewer or mutable latest path', () => {
  const updaterSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'services', 'updater', 'index.ts'),
    'utf8',
  );
  const releaseWorkflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'build.yml'),
    'utf8',
  );
  assert.match(updaterSource, /TONGMU_UPDATE_REPOSITORY/);
  assert.doesNotMatch(updaterSource, /const\s+REPO_(?:OWNER|NAME)\s*=/);
  assert.doesNotMatch(releaseWorkflow, /release-latest|Delete existing latest release/);
  assert.doesNotMatch(releaseWorkflow, /branches:\s*\[main\]/);
  assert.match(releaseWorkflow, /concurrency:/);
});

test('nested provider errors redact camelCase and header-style secret keys', () => {
  const error = new Error('provider request failed');
  error.cause = {
    accessToken: 'access-secret',
    nested: {
      'refresh-token': 'refresh-secret',
      cookie: 'cookie-secret',
      harmless: 'kept',
    },
  };
  error.response = { headers: { Cookie: 'response-cookie-secret' }, data: { password: 'response-password-secret' } };
  const output = redactMediaError(error);
  assert.equal(output.includes('access-secret'), false);
  assert.equal(output.includes('refresh-secret'), false);
  assert.equal(output.includes('cookie-secret'), false);
  assert.equal(output.includes('response-cookie-secret'), false);
  assert.equal(output.includes('response-password-secret'), false);
  assert.match(output, /harmless/);
});
