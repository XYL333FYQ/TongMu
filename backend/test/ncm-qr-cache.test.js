const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NcmApiClient } = require('../dist/modules/music/ncm/ncm-client');

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
