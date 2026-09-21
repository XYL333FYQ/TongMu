const test = require('node:test');
const assert = require('node:assert/strict');

test('anonymous WBI accepts nav -101 after buvid bootstrap without affecting login cookies', async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), headers: options.headers || {} });
    if (String(url).includes('/x/frontend/finger/spi')) {
      return Response.json({
        code: 0,
        message: '0',
        data: { b_3: 'anon-buvid3', b_4: 'anon-buvid4' },
      });
    }
    if (String(url).includes('/x/web-interface/nav')) {
      return Response.json({
        code: -101,
        message: '账号未登录',
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/img-key.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/sub-key.png',
          },
        },
      });
    }
    return Response.json({ code: 0, message: '0', data: {} });
  };

  try {
    const client = require('../dist/services/bilibili/client');
    const wbi = require('../dist/services/bilibili/wbi');
    wbi.clearWbiKeyCache();

    const keys = await wbi.fetchWbiKeys();
    assert.deepEqual(keys.imgKey, 'img-key');
    assert.deepEqual(keys.subKey, 'sub-key');
    const navRequest = requests.find((request) =>
      request.url.includes('/x/web-interface/nav'),
    );
    assert.match(navRequest.headers.Cookie, /buvid3=anon-buvid3/);
    assert.match(navRequest.headers.Cookie, /buvid4=anon-buvid4/);

    await client.bilibiliFetch('https://api.bilibili.com/test', {
      cookie: 'SESSDATA=logged-in',
    });
    assert.equal(requests.at(-1).headers.Cookie, 'SESSDATA=logged-in');
  } finally {
    global.fetch = previousFetch;
  }
});
