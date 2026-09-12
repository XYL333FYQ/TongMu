import { expect, test, type Page } from '@playwright/test';

const FIXTURE_ORIGIN = 'http://127.0.0.1:3456';

async function loginAndCreateRoom(page: Page): Promise<void> {
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

async function configureGeneratedMedia(page: Page): Promise<void> {
  await page.goto('about:blank');
  const payload = await page.evaluate(async () => {
    const toBase64 = async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    };

    const record = async (kind: 'muxed' | 'video' | 'audio'): Promise<string> => {
      const streams: MediaStream[] = [];
      let animation = 0;
      let audioContext: AudioContext | undefined;
      let oscillator: OscillatorNode | undefined;
      const tracks: MediaStreamTrack[] = [];
      if (kind !== 'audio') {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext('2d')!;
        let frame = 0;
        const draw = () => {
          context.fillStyle = frame % 2 ? '#14532d' : '#1d4ed8';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#fff';
          context.font = '20px sans-serif';
          context.fillText(`ZViewer ${frame}`, 12, 50);
          frame += 1;
          animation = requestAnimationFrame(draw);
        };
        draw();
        const stream = canvas.captureStream(24);
        streams.push(stream);
        tracks.push(...stream.getVideoTracks());
      }
      if (kind !== 'video') {
        audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        oscillator = audioContext.createOscillator();
        oscillator.frequency.value = 440;
        oscillator.connect(destination);
        oscillator.start();
        streams.push(destination.stream);
        tracks.push(...destination.stream.getAudioTracks());
      }

      const stream = new MediaStream(tracks);
      const preferred = kind === 'audio'
        ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
        : kind === 'video'
          ? ['video/mp4;codecs=avc1.42001E', 'video/mp4']
          : ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/mp4'];
      const mimeType = preferred.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) throw new Error(`Chromium cannot record ${kind} MP4`);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 400_000 });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(recorder.error);
      });
      recorder.start(500);
      await new Promise((resolve) => setTimeout(resolve, 2600));
      recorder.stop();
      await stopped;
      cancelAnimationFrame(animation);
      oscillator?.stop();
      tracks.forEach((track) => track.stop());
      await audioContext?.close();
      return toBase64(new Blob(chunks, { type: mimeType }));
    };

    return {
      muxed: await record('muxed'),
      video: await record('video'),
      audio: await record('audio'),
    };
  });
  const response = await page.request.post(`${FIXTURE_ORIGIN}/configure`, { data: payload });
  expect(response.status(), await response.text()).toBe(204);
}

async function addAndPlay(page: Page, url: string, engine: RegExp): Promise<void> {
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/).last();
  await input.fill(url);
  await page.getByRole('button', { name: '添加', exact: true }).last().click();
  await expect(page.getByText(/Resolver: direct-url/).last()).toBeVisible();
  await expect(page.getByText(engine).last()).toBeVisible();
  await page.getByRole('button', { name: '播放', exact: true }).last().click();
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  const playError = await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    return Promise.race([
      element.play().then(() => null, (error) => String(error)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
  });
  expect(playError).toBeNull();
  try {
    await expect.poll(
      () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
      { timeout: 20_000 }
    ).toBeGreaterThan(0);
  } catch (error) {
    const state = await video.evaluate((element: HTMLVideoElement) => ({
      buffered: Array.from({ length: element.buffered.length }, (_, index) => [
        element.buffered.start(index),
        element.buffered.end(index),
      ]),
      currentTime: element.currentTime,
      error: element.error ? { code: element.error.code, message: element.error.message } : null,
      networkState: element.networkState,
      paused: element.paused,
      readyState: element.readyState,
    }));
    throw new Error(`media did not advance: ${JSON.stringify(state)}`, { cause: error });
  }
}

async function assertRoomMediaOutlivesAccessJwt(
  page: Page,
  mediaRequests: string[],
  match: (url: string) => boolean
): Promise<void> {
  await expect.poll(() => mediaRequests.some(match)).toBe(true);
  const target = [...mediaRequests].reverse().find(match);
  expect(target, 'expected a signed child media request').toBeTruthy();
  await page.waitForTimeout(2500);
  const response = await page.request.get(target!);
  expect(response.status(), await response.text()).toBe(200);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await configureGeneratedMedia(page);
  await page.close();
});

test('real MP4 and extensionless sources load, play, and seek through the signed gateway', async ({ page }) => {
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const video = page.locator('video').first();
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 1; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.7);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/extensionless`, /Engine: direct/);

  const stats = await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json() as Array<{ path: string; range: string }>;
  expect(stats.some((entry) => entry.path === '/normal.mp4' && entry.range.startsWith('bytes='))).toBeTruthy();
  expect(stats.some((entry) => entry.path === '/extensionless')).toBeTruthy();
});

test('real HLS master, extensionless child playlist, AES key, and fMP4 segment play', async ({ page }) => {
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/stream/media/')) mediaRequests.push(request.url());
  });
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/hls/master.m3u8`, /Engine: hls/);
  const stats = await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json() as Array<{ path: string }>;
  for (const path of ['/hls/master.m3u8', '/hls/variant', '/hls/init.mp4', '/hls/key', '/hls/segment']) {
    expect(stats.some((entry) => entry.path === path), `missing upstream request ${path}`).toBeTruthy();
  }
  await assertRoomMediaOutlivesAccessJwt(page, mediaRequests, (url) => url.includes('roomGrant='));
});

test('real DASH nested BaseURL requests video/audio init and relative segments', async ({ page }) => {
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/stream/media/')) mediaRequests.push(request.url());
  });
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/dash/manifest.mpd`, /Engine: dash/);
  const stats = await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json() as Array<{ path: string }>;
  for (const path of [
    '/dash/manifest.mpd',
    '/dash/media/video/init.mp4',
    '/dash/media/video/chunk-1.m4s',
    '/dash/media/audio/init.mp4',
    '/dash/media/audio/chunk-1.m4s',
  ]) {
    expect(stats.some((entry) => entry.path === path), `missing upstream request ${path}`).toBeTruthy();
  }
  await assertRoomMediaOutlivesAccessJwt(page, mediaRequests, (url) => url.includes('/asset?path=chunk-1.m4s'));
});

test('unified media panel has no horizontal overflow at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndCreateRoom(page);
  await page.getByRole('button', { name: '切换到添加影片' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
