const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NcmApiClient } = require('../dist/modules/music/ncm/ncm-client');

test('legacy audio fallback proves bitrate and never invents requested quality', async () => {
  const requests = [];
  let bitrate = 320000;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, br: url.searchParams.get('br') });
    assert.equal(req.headers.cookie, 'MUSIC_U=fixture-only');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/song/url/v1') {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404 }));
    } else {
      res.end(JSON.stringify({ code: 200, data: [{ id: 101, url: 'https://m7.music.126.net/fixture.mp3', type: 'mp3', br: bitrate, level: 'exhigh' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NCM_API_BASE_URL;
  process.env.NCM_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new NcmApiClient();
    const credential = { cookieHeader: 'MUSIC_U=fixture-only' };
    assert.equal((await client.resolveTrack('101', 'exhigh', credential)).actualQuality, 'exhigh');
    bitrate = 128000;
    assert.equal((await client.resolveTrack('101', 'exhigh', credential)).actualQuality, 'standard');
    bitrate = undefined;
    assert.equal((await client.resolveTrack('101', 'exhigh', credential)).actualQuality, null);
    const legacyCount = requests.filter(row => row.path === '/song/url').length;
    await assert.rejects(() => client.resolveTrack('101', 'lossless', credential), error => error.code === 'NCM_UPSTREAM_ERROR');
    assert.equal(requests.filter(row => row.path === '/song/url').length, legacyCount);
    assert.ok(requests.filter(row => row.path === '/song/url').every(row => row.br === '320000'));
  } finally {
    if (previous === undefined) delete process.env.NCM_API_BASE_URL;
    else process.env.NCM_API_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('QR polls bypass URL cache and observe phone authorization', async () => {
  const cache = new Map();
  const requests = [];
  let authorized = false;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    let body = cache.get(req.url);
    if (!body) {
      body = { code: authorized ? 803 : 801 };
      cache.set(req.url, body);
    }
    res.setHeader('Content-Type', 'application/json');
    if (body.code === 803) res.setHeader('Set-Cookie', 'MUSIC_U=fixture-only; Path=/');
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NCM_API_BASE_URL;
  process.env.NCM_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new NcmApiClient();
    assert.equal((await client.checkQr('fixture-key')).status, 'waiting');
    authorized = true;
    const result = await client.checkQr('fixture-key');
    assert.equal(result.status, 'authorized');
    assert.match(result.cookieHeader, /MUSIC_U=fixture-only/);
    assert.notEqual(requests[0], requests[1]);
    assert.ok(requests.every(url => new URL(url, 'http://fixture').searchParams.get('_tongmu_cache_bust')));
  } finally {
    if (previous === undefined) delete process.env.NCM_API_BASE_URL;
    else process.env.NCM_API_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('authorized QR credentials recover account identity from user/account', async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    paths.push(path);
    assert.equal(req.headers.cookie, 'MUSIC_U=fixture-only');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(path === '/login/status'
      ? { code: 200, data: { profile: null, account: null } }
      : { code: 200, profile: { userId: 12345, nickname: 'Fixture' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NCM_API_BASE_URL;
  process.env.NCM_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await new NcmApiClient().getStatus({ cookieHeader: 'MUSIC_U=fixture-only' });
    assert.equal(result.loggedIn, true);
    assert.equal(result.profile.accountId, '12345');
    assert.deepEqual(paths, ['/login/status', '/user/account']);
  } finally {
    if (previous === undefined) delete process.env.NCM_API_BASE_URL;
    else process.env.NCM_API_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
