import { expect, test } from '@playwright/test';

async function loginAndCreateRoom(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill('root');
  await page.getByPlaceholder('请输入密码').fill('root');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始共享', exact: true }).click();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page).toHaveURL(/\/room\//);
}

test('unified media input stores the descriptor and shows the playback plan', async ({ page }) => {
  await loginAndCreateRoom(page);

  let resolutionCalls = 0;
  await page.route('**/api/stream/media/resolve', async (route) => {
    resolutionCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        descriptor: {
          title: 'Fixture Movie', sourceType: 'url', resolver: 'direct-url',
          input: 'https://media.example/play?id=fixture',
          originalUrl: 'https://media.example/play?id=fixture',
          finalUrl: '/api/stream/media/encrypted-fixture', transport: 'direct',
          container: 'mp4', contentType: 'video/mp4', rangeSupported: true,
          videoCodec: 'h264', audioCodec: 'aac', drm: { protected: false },
          expiresAt: Date.now() - 1,
          probe: { method: 'range-get', bytesRead: 16, magic: 'ISO BMFF ftyp', warnings: [] },
        },
        plan: {
          engine: 'direct', mode: 'direct', proxy: true,
          videoAction: 'direct', audioAction: 'direct', reasons: ['浏览器原生 Direct Play'],
        },
      }),
    });
  });

  await page.getByPlaceholder(/影片网页、MP4\/MKV/).last().fill('https://media.example/play?id=fixture');
  await page.getByRole('button', { name: '添加', exact: true }).last().click();

  await expect(page.getByText('Fixture Movie').last()).toBeVisible();
  await expect(page.getByText(/Resolver: direct-url/)).toBeVisible();
  await expect(page.getByText(/Engine: direct/)).toBeVisible();

  // Playback must refresh an expired signed handle from sourceInput instead of
  // treating it as a permanent direct URL.
  await page.getByRole('button', { name: '播放', exact: true }).last().click();
  await expect.poll(() => resolutionCalls).toBe(2);
});

test('unified media panel has no horizontal overflow at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndCreateRoom(page);
  await page.getByRole('button', { name: '切换到添加影片' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
