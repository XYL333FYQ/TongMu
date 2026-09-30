import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_ORIGIN = "http://127.0.0.1:3456";
let resolveBudget: { remaining: number; resetAt: number } | undefined;

async function persistedMovieContains(value: string): Promise<boolean> {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const database = new SQL.Database(await readFile(path.resolve('.e2e-runtime', 'test.sqlite')));
  try {
    const persisted = [
      database.exec('SELECT "url", "sourceInput", "audioUrl", "mediaDescriptor" FROM "movie"'),
      database.exec('SELECT "sourceUrl", "audioUrl", "headers" FROM "playback_states"'),
    ];
    return JSON.stringify(persisted).includes(value);
  } finally { database.close(); }
}

function safeRequestUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.startsWith('/api/stream/media/')
      ? '/api/stream/media/<redacted>'
      : url.pathname;
    const queryKeys = [...url.searchParams.keys()].sort();
    return `${url.origin}${path}${queryKeys.length ? `?keys=${queryKeys.join(',')}` : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

function redactLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`]+/gi, (rawUrl) => {
      const trimmed = rawUrl.replace(/[),.;]+$/g, '');
      return safeRequestUrl(trimmed);
    })
    .replace(/\b(?=[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<jwt-redacted>')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer <redacted>');
}

function isMediaRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === FIXTURE_ORIGIN || url.pathname.includes('/api/stream/media/');
  } catch {
    return false;
  }
}

function installMediaDiagnostics(page: Page, title: string): void {
  page.on('request', (request) => {
    if (!isMediaRequest(request.url())) return;
    console.log('[e2e request]', JSON.stringify({
      test: title,
      method: request.method(),
      url: safeRequestUrl(request.url()),
      resourceType: request.resourceType(),
    }));
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/stream/media/resolve')) {
      const header = response.headers()['ratelimit'];
      const remaining = header?.match(/remaining=(\d+)/)?.[1];
      const reset = header?.match(/reset=(\d+)/)?.[1];
      if (remaining !== undefined && reset !== undefined) resolveBudget = { remaining: Number(remaining), resetAt: Date.now() + Number(reset) * 1000 };
    }
    if (!isMediaRequest(response.url())) return;
    console.log('[e2e response]', JSON.stringify({
      test: title,
      status: response.status(),
      url: safeRequestUrl(response.url()),
      contentType: response.headers()['content-type'] ?? '',
    }));
  });
  page.on('requestfailed', (request) => {
    if (!isMediaRequest(request.url())) return;
    console.log('[e2e requestfailed]', JSON.stringify({
      test: title,
      url: safeRequestUrl(request.url()),
      failure: request.failure()?.errorText ?? 'unknown',
    }));
  });
  page.on('pageerror', (error) => {
    console.log('[e2e pageerror]', JSON.stringify({
      test: title,
      message: redactLogText(error.message),
    }));
  });
  page.on('console', (message) => {
    const messageText = message.text();
    if (!/hls|dash|media|mse|sourcebuffer|codec|error|failed/i.test(messageText)) return;
    console.log('[e2e console]', JSON.stringify({
      test: title,
      type: message.type(),
      text: redactLogText(messageText),
    }));
  });
}

async function installMseDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (typeof MediaSource !== 'undefined') {
      const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mimeType: string): SourceBuffer {
        try {
          const sourceBuffer = addSourceBuffer.call(this, mimeType);
          sourceBuffer.addEventListener('error', () => {
            console.log('[e2e mse sourcebuffer error]', JSON.stringify({ mimeType }));
          });
          return sourceBuffer;
        } catch (error) {
          console.log('[e2e mse addSourceBuffer failed]', JSON.stringify({
            mimeType,
            error: String(error),
          }));
          throw error;
        }
      };
    }
    if (typeof SourceBuffer !== 'undefined') {
      const appendBuffer = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data: ArrayBuffer | ArrayBufferView): void {
        try {
          return appendBuffer.call(this, data);
        } catch (error) {
          console.log('[e2e mse appendBuffer failed]', JSON.stringify({ error: String(error) }));
          throw error;
        }
      };
    }
  });
}

async function logMediaDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const fixtureDiagnostics = await (await page.request.get(`${FIXTURE_ORIGIN}/diagnostics`)).json();
    const actualVideoCodecs = [fixtureDiagnostics.actualMuxedVideoCodec, fixtureDiagnostics.actualDashVideoCodec]
      .filter((codec): codec is string => typeof codec === 'string' && codec.length > 0);
    const capability = await page.evaluate((videoCodecs) => {
      const mimeTypes = [
        'video/mp4; codecs="avc1.42001e"',
        'video/mp4; codecs="avc1.42001e,mp4a.40.2"',
        'audio/mp4; codecs="mp4a.40.2"',
        'video/iso.segment; codecs="avc1.42001e"',
        ...new Set(videoCodecs.flatMap((codec) => [
          `video/mp4; codecs="${codec}"`,
          `video/mp4; codecs="${codec},mp4a.40.2"`,
          `video/iso.segment; codecs="${codec}"`,
        ])),
      ];
      const mediaSource = typeof MediaSource === 'undefined' ? undefined : MediaSource;
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        mediaSourceType: typeof MediaSource,
        mediaSourceIsTypeSupported: mediaSource
          ? Object.fromEntries(mimeTypes.map((mime) => [mime, mediaSource.isTypeSupported(mime)]))
          : null,
        videoCanPlay: Object.fromEntries(mimeTypes.map((mime) => [mime, document.createElement('video').canPlayType(mime)])),
      };
    }, actualVideoCodecs);
    const video = await page.locator('video').first().evaluate((element: HTMLVideoElement) => ({
      currentSrc: element.currentSrc,
      src: element.src,
      dataset: { ...element.dataset },
      readyState: element.readyState,
      networkState: element.networkState,
      paused: element.paused,
      currentTime: element.currentTime,
      buffered: Array.from({ length: element.buffered.length }, (_, index) => [
        element.buffered.start(index),
        element.buffered.end(index),
      ]),
      error: element.error ? { code: element.error.code, message: element.error.message } : null,
    }));
    const fixtureStats = await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json();
    const safeVideo = {
      ...video,
      currentSrc: safeRequestUrl(video.currentSrc),
      src: safeRequestUrl(video.src),
      dataset: {
        ...video.dataset,
        mediaSource: video.dataset.mediaSource ? safeRequestUrl(video.dataset.mediaSource) : undefined,
      },
      error: video.error ? { ...video.error, message: redactLogText(video.error.message) } : null,
    };
    console.log('[e2e media diagnostics]', JSON.stringify({ label, capability, video: safeVideo, fixtureDiagnostics, fixtureStats }));
  } catch (error) {
    console.log('[e2e media diagnostics unavailable]', JSON.stringify({ label, error: redactLogText(String(error)) }));
  }
}

async function loginAndCreateRoom(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill("root");
  await page.getByPlaceholder("请输入密码").fill("root");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(page).toHaveURL(/\/room\//);
}

async function loginRoot(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill("root");
  await page.getByPlaceholder("请输入密码").fill("root");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
}

async function configureAnimeFixture(page: Page): Promise<string> {
  return page.evaluate(async (fixtureOrigin) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    const response = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoDeleteInactiveRooms: true,
        autoDeleteAfterHours: 24,
        dataSourceConfig: {
          rssSources: [{
            id: 'phase2c2-fixture',
            name: 'Phase 2C-2 Fixture RSS',
            url: `${fixtureOrigin}/anime/feed.xml`,
          }],
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(JSON.stringify(payload));
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { buildAnimeProviderReference } = await import('/src/modules/media/animeReference.ts');
    const episodeId = `${fixtureOrigin}/anime/episode-1`;
    return buildAnimeProviderReference('anime', 'rss_phase2c2-fixture', {
      id: episodeId,
      title: 'Fixture Anime 01',
      episodeNumber: 1,
      playbackParams: { episodeUrl: episodeId },
    });
  }, FIXTURE_ORIGIN);
}

type MediaServerProvider = 'emby' | 'jellyfin';

async function createMediaServerMount(
  page: Page,
  provider: MediaServerProvider,
): Promise<{ mountId: number; reference: string }> {
  return page.evaluate(async ({ provider, fixtureOrigin }) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { buildMediaServerReference } = await import('/src/modules/media/mediaServerReference.ts');
    const response = await apiFetch(`/api/${provider}/mounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `phase2c1-${provider}`,
        serverUrl: fixtureOrigin,
        apiKey: 'fixture-api-key',
        directLink: false,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success || !payload.mount?.id) {
      throw new Error(JSON.stringify(payload));
    }
    if (JSON.stringify(payload).includes('fixture-api-key')) {
      throw new Error('media-server credential leaked from mount response');
    }
    const mountId = Number(payload.mount.id);
    return {
      mountId,
      reference: buildMediaServerReference({
        provider,
        mountId,
        itemId: 'fixture-movie',
        mediaSourceId: 'source-1',
      }),
    };
  }, { provider, fixtureOrigin: FIXTURE_ORIGIN });
}

async function configureGeneratedMedia(page: Page): Promise<void> {
  await page.goto("about:blank");
  const payload = await page.evaluate(async () => {
    const toBase64 = async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 0x8000),
        );
      }
      return btoa(binary);
    };

    const record = async (
      kind: "muxed" | "video" | "audio",
    ): Promise<string> => {
      const streams: MediaStream[] = [];
      let animation = 0;
      let audioContext: AudioContext | undefined;
      let oscillator: OscillatorNode | undefined;
      const tracks: MediaStreamTrack[] = [];
      if (kind !== "audio") {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          context.fillStyle = frame % 2 ? "#14532d" : "#1d4ed8";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#fff";
          context.font = "20px sans-serif";
          context.fillText(`TongMu ${frame}`, 12, 50);
          frame += 1;
          animation = requestAnimationFrame(draw);
        };
        draw();
        const stream = canvas.captureStream(24);
        streams.push(stream);
        tracks.push(...stream.getVideoTracks());
      }
      if (kind !== "video") {
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
      const preferred =
        kind === "audio"
          ? ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"]
          : kind === "video"
            ? ["video/mp4;codecs=avc1.42001E", "video/mp4"]
            : ["video/mp4;codecs=avc1.42001E,mp4a.40.2", "video/mp4"];
      const mimeType = preferred.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      if (!mimeType) throw new Error(`Chromium cannot record ${kind} MP4`);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 400_000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
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
      muxed: await record("muxed"),
      video: await record("video"),
      audio: await record("audio"),
    };
  });
  const response = await page.request.post(`${FIXTURE_ORIGIN}/configure`, {
    data: payload,
  });
  expect(response.status(), await response.text()).toBe(204);
}

async function addAndPlay(
  page: Page,
  url: string,
  engine: RegExp,
): Promise<void> {
  await page.getByRole("tab", { name: "添加影片", exact: true }).click();
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/).last();
  await input.fill(url);
  await page.getByRole("button", { name: "解析", exact: true }).last().click();
  await page.getByText('技术详情').last().click();
  await expect(page.getByText(/Resolver: (?:direct-url|live)/).last()).toBeVisible();
  await expect(page.getByText(engine).last()).toBeVisible();
  await page.getByRole("button", { name: "添加", exact: true }).last().click();
  const title = decodeURIComponent(new URL(url).pathname.split('/').pop()!);
  await page.getByRole("tab", { name: "影片列表", exact: true }).click();
  await page.getByText(title, { exact: true }).last().locator('../..').getByRole('button', { name: '播放', exact: true }).click();
  const video = page.locator("video").first();
  try {
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.dataset.mediaSource), { timeout: 90000 }).toBe(url);
  } catch (error) {
    await logMediaDiagnostics(page, `attach failed: ${url}`);
    throw error;
  }
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  const playError = await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    return Promise.race([
      element.play().then(
        () => null,
        (error) => String(error),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
  });
  expect(playError).toBeNull();
  try {
    await expect
      .poll(
        () =>
          video.evaluate((element: HTMLVideoElement) => element.currentTime),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const state = await video.evaluate((element: HTMLVideoElement) => ({
      buffered: Array.from({ length: element.buffered.length }, (_, index) => [
        element.buffered.start(index),
        element.buffered.end(index),
      ]),
      currentTime: element.currentTime,
      error: element.error
        ? { code: element.error.code, message: element.error.message }
        : null,
      networkState: element.networkState,
      paused: element.paused,
      readyState: element.readyState,
    }));
    throw new Error(`media did not advance: ${JSON.stringify(state)}`, {
      cause: error,
    });
  }
}

async function assertRoomMediaOutlivesAccessJwt(
  page: Page,
  mediaRequests: string[],
  match: (url: string) => boolean,
): Promise<void> {
  await expect.poll(() => mediaRequests.some(match)).toBe(true);
  const target = [...mediaRequests].reverse().find(match);
  expect(target, "expected a signed child media request").toBeTruthy();
  await page.waitForTimeout(2500);
  const response = await page.request.get(target!);
  expect(response.status(), await response.text()).toBe(200);
}

async function forceSocketReconnect(page: Page): Promise<{
  oldSocketId: string;
  newSocketId: string;
}> {
  const oldSocketId = await page.evaluate(() => {
    const socket = (window as unknown as {
      __debugSocket?: { id?: string; disconnect: () => void; connect: () => void };
    }).__debugSocket;
    if (!socket?.id) throw new Error("debug socket is not connected");
    socket.disconnect();
    setTimeout(() => socket.connect(), 100);
    return socket.id;
  });
  const socketId = () =>
    page.evaluate(
      () =>
        (window as unknown as { __debugSocket?: { id?: string } }).__debugSocket
          ?.id ?? "",
    );
  await expect.poll(socketId, { timeout: 15_000 }).not.toBe("");
  await expect.poll(socketId, { timeout: 15_000 }).not.toBe(oldSocketId);
  const newSocketId = await page.evaluate(
    () =>
      (window as unknown as { __debugSocket?: { id?: string } }).__debugSocket
        ?.id ?? "",
  );
  expect(newSocketId).not.toBe("");
  return { oldSocketId, newSocketId };
}

async function assertRoomGrantRefreshesAfterReconnect(
  page: Page,
  mediaUrl: string,
  engine: RegExp,
): Promise<void> {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/stream/media/")) {
      mediaRequests.push(request.url());
    }
  });
  await page.route(`${FIXTURE_ORIGIN}/**`, route => route.abort('blockedbyclient'));
  await addAndPlay(page, mediaUrl, engine);
  await expect.poll(() => mediaRequests.some((url) => url.includes("roomGrant="))).toBe(true);
  const oldGrantUrl = mediaRequests.find((url) => url.includes("roomGrant="));
  expect(oldGrantUrl).toBeTruthy();
  const oldGrant = new URL(oldGrantUrl!).searchParams.get("roomGrant");
  expect(oldGrant).toBeTruthy();
  const video = page.locator("video").first();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  const beforeReconnect = await video.evaluate((element: HTMLVideoElement) => element.currentTime);

  await forceSocketReconnect(page);
  const staleResponse = await page.request.get(oldGrantUrl!);
  expect(staleResponse.status(), await staleResponse.text()).toBe(403);

  await expect
    .poll(
      () =>
        mediaRequests.some((url) => {
          const grant = new URL(url).searchParams.get("roomGrant");
          return !!grant && grant !== oldGrant;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(beforeReconnect + 0.05);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await configureGeneratedMedia(page);
  await page.close();
});

test.beforeEach(async ({ page }, testInfo) => {
  // Respect the real server budget instead of making a long suite trigger 429.
  if (resolveBudget && resolveBudget.remaining < 8 && resolveBudget.resetAt > Date.now()) {
    await new Promise(resolve => setTimeout(resolve, resolveBudget!.resetAt - Date.now() + 100));
    resolveBudget = undefined;
  }
  await installMseDiagnostics(page);
  installMediaDiagnostics(page, testInfo.title);
});

test('Chromium capability collector emits a bounded deterministic V1 profile', async ({ page }) => {
  await page.goto('/login');
  const profile = await page.evaluate(async () => {
    // Vite serves this module for the browser integration test so the check
    // exercises the real DOM/MediaSource/ManagedMediaSource feature probes.
    const module = await import('/src/modules/media/playbackProfile.ts');
    return module.collectPlaybackClientProfile();
  });
  expect(profile.profileVersion).toBe(1);
  expect(profile.environment).toBe('web');
  expect(profile.mediaCapabilities.length).toBeLessThanOrEqual(64);
  expect(profile.mediaCapabilities.every((capability: { exactCodecStrings?: string[] }) =>
    (capability.exactCodecStrings ?? []).every((value) => value.length <= 128))).toBe(true);
  expect(profile.mediaCapabilities.some((capability: { transport: string }) =>
    capability.transport === 'progressive')).toBe(true);
});

test('movie input A to B to A keeps only the newest Bilibili preview', async ({ page }) => {
  test.setTimeout(45_000);
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片' }).click();
  const input = page.getByPlaceholder('视频 Url 或 bv 号');
  await page.getByRole('group', { name: '内容来源' }).getByRole('button', { name: '哔哩哔哩' }).click();
  const oldA = 'https://www.bilibili.com/video/BV1xx411c7mD';
  const b = 'https://www.bilibili.com/video/BV1yy411c7mD';
  let requestCount = 0;
  let addedTitle = '';
  const pending: Array<() => Promise<void>> = [];
  await page.route('**/api/rooms/*/movies', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    addedTitle = (route.request().postDataJSON() as { title: string }).title;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/api/stream/media/resolve', async (route) => {
    const body = route.request().postDataJSON() as { input: string };
    requestCount += 1;
    const order = requestCount;
    const complete = () => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      success: true,
      descriptor: {
        input: body.input, originalUrl: body.input, finalUrl: `${FIXTURE_ORIGIN}/normal.mp4`,
        title: order === 1 ? 'Old A' : order === 2 ? 'Old B' : 'Newest A',
        sourceType: 'bilibili', resolver: 'bilibili', transport: 'direct', container: 'mp4',
        headers: {}, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
        transportPlan: { candidates: [{ mode: 'DIRECT', url: `${FIXTURE_ORIGIN}/normal.mp4`, transport: 'progressive', container: 'mp4', requiredPipelines: ['native'] }], reason: 'fixture' },
      },
    }) });
    if (order < 3) pending.push(complete);
    else await complete();
  });
  await input.fill(oldA);
  await input.press('Enter');
  await expect.poll(() => requestCount).toBe(1);
  await input.fill(b);
  await input.press('Enter');
  await expect.poll(() => requestCount).toBe(2);
  await input.fill(oldA);
  await input.press('Enter');
  await expect.poll(() => requestCount).toBe(3);
  await expect(page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '添加', exact: true })).toBeVisible();
  await pending[1]();
  await pending[0]();
  await page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '添加', exact: true }).click();
  await expect.poll(() => addedTitle).toBe('Newest A');
});

test('repeated Enter while a movie POST is pending sends one add request', async ({ page }) => {
  test.setTimeout(45_000);
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片' }).click();
  let postCount = 0;
  let releasePost: (() => Promise<void>) | undefined;
  await page.route('**/api/rooms/*/movies', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    postCount += 1;
    await new Promise<void>((resolve) => { releasePost = async () => { await route.continue(); resolve(); }; });
  });
  const input = page.getByPlaceholder('影片网页、MP4/MKV、M3U8、MPD、FLV 或无后缀媒体 URL');
  await input.fill(`${FIXTURE_ORIGIN}/normal.mp4`);
  await input.press('Enter');
  await expect(page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '添加', exact: true })).toBeVisible();
  expect(postCount).toBe(0);
  await input.press('Enter');
  await expect.poll(() => postCount).toBe(1);
  await input.press('Enter');
  await input.press('Enter');
  expect(postCount).toBe(1);
  await releasePost?.();
  await expect(page.getByText('影片已添加')).toBeVisible();
  await input.press('Enter');
  expect(postCount).toBe(1);
});

test('a lost movie POST response retries the durable key without creating a duplicate', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '添加影片' });
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/);
  const keys: string[] = [];
  const movieIds: number[] = [];
  await page.route('**/api/rooms/*/movies', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    if ([401, 403].includes(response.status())) return route.fulfill({ response });
    expect(response.status(), (await response.json()).message).toBe(201);
    keys.push(route.request().headers()['idempotency-key']);
    movieIds.push((await response.json()).movie.id);
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await input.fill(`${FIXTURE_ORIGIN}/normal.mp4`);
  await input.press('Enter');
  const add = panel.getByRole('button', { name: '添加', exact: true });
  await expect(add).toBeVisible();
  await add.click();
  await expect.poll(() => keys.length).toBe(1);
  await expect(panel.getByText('添加结果尚未确认，请再次点击添加；重试不会重复创建影片')).toBeVisible();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByText('影片已添加')).toBeVisible();
  expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(movieIds).toEqual([movieIds[0], movieIds[0]]);
  const movieCount = await page.evaluate(async id => {
    const { useRoomStore } = await import('/src/store/roomStore.ts');
    return useRoomStore.getState().movies.filter(movie => movie.id === id).length;
  }, movieIds[0]);
  expect(movieCount).toBe(1);
});

test('unified link preview recognizes Bilibili and confirms the selected page and quality', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '添加影片' });
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/);
  let added: { source: string; currentQn: number; cid: number; currentPage: number } | undefined;
  let releaseQuality: (() => Promise<void>) | undefined;
  await page.route('**/api/rooms/*/movies', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    added = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/api/stream/media/resolve', async route => {
    const body = route.request().postDataJSON();
    const currentPage = body.page ?? (body.cid === 22 ? 2 : 1);
    const qn = body.requestedQn ?? 80;
    const fulfill = () => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, descriptor: {
      input: body.input, originalUrl: body.input, finalUrl: `${FIXTURE_ORIGIN}/normal.mp4`, title: 'Bilibili fixture',
      sourceType: 'bilibili', resolver: 'bilibili', transport: 'direct', container: 'mp4', headers: {}, drm: { protected: false },
      probe: { method: 'resolver', bytesRead: 0, warnings: [] },
      sourceMetadata: { bilibili: { cid: currentPage === 2 ? 22 : 11, currentPage, actualQn: qn, qualityLabel: qn === 64 ? '720P' : '1080P',
        availableQualities: [{ id: 80, label: '1080P' }, { id: 64, label: '720P' }],
        pages: [{ page: 1, cid: 11, part: '第一集', duration: 10 }, { page: 2, cid: 22, part: '第二集', duration: 10 }] } },
      transportPlan: { candidates: [{ mode: 'DIRECT', url: `${FIXTURE_ORIGIN}/normal.mp4`, transport: 'progressive', container: 'mp4', requiredPipelines: ['native'] }], reason: 'fixture' },
    } }) });
    if (qn === 64) releaseQuality = fulfill;
    else await fulfill();
  });
  await input.fill('https://b23.tv/fixture');
  await input.press('Enter');
  await page.getByRole('dialog', { name: /选择分集/ }).getByText('第二集', { exact: true }).click();
  await expect(panel.getByRole('button', { name: /P2 第二集/ })).toBeVisible();
  expect(added).toBeUndefined();
  await panel.locator('button[aria-haspopup="listbox"]').click();
  await page.getByRole('option', { name: '720P', exact: true }).click();
  await expect.poll(() => Boolean(releaseQuality)).toBe(true);
  await expect(panel.getByRole('button', { name: '添加', exact: true })).toBeDisabled();
  await input.press('Enter');
  expect(added).toBeUndefined();
  await releaseQuality!();
  await expect(panel.getByRole('button', { name: '添加', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '添加', exact: true }).click();
  await expect.poll(() => added?.source).toBe('bilibili');
  expect(added).toMatchObject({ cid: 22, currentQn: 64, currentPage: 2 });
  await expect(input).toHaveValue('');
});

test('cancelled link recognition cannot publish a late preview or add a movie', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '添加影片' });
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/stream/media/resolve', async route => {
    await new Promise<void>(resolve => { release = async () => {
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'NO_MEDIA_FOUND' }) }).catch(() => undefined);
      resolve();
    }; });
  });
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/);
  await input.fill(`${FIXTURE_ORIGIN}/normal.mp4`);
  await input.press('Enter');
  await expect.poll(() => Boolean(release)).toBe(true);
  await panel.getByRole('button', { name: '取消解析', exact: true }).click();
  await release!();
  await expect(panel.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '解析', exact: true })).toBeEnabled();
});

test('movie diagnostics never render a media capability or raw resolver error', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片' }).click();
  const secret = 'private-fixture-token-123';
  let failMode: 'none' | 'unknown' | 'denied' = 'none';
  await page.route('**/api/stream/media/resolve', async (route) => {
    if (failMode !== 'none') {
      if (failMode === 'denied') {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({
          success: false, code: 'ACCESS_DENIED', retryable: false, requestId: 'fixture-request-id',
          message: `failed https://cdn.example/video.mp4?token=${secret}`,
        }) });
        return;
      }
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ success: false, message: `failed https://cdn.example/video.mp4?token=${secret}` }) });
      return;
    }
    const input = (route.request().postDataJSON() as { input: string }).input;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, descriptor: {
      input, originalUrl: input, finalUrl: `https://cdn.example/video.mp4?token=${secret}`,
      title: 'Fixture', sourceType: 'url', resolver: 'direct-url', transport: 'direct', container: 'mp4',
      headers: {}, drm: { protected: false }, probe: { method: 'resolver', bytesRead: 0, warnings: [] },
      transportPlan: { candidates: [{ mode: 'DIRECT', url: `https://cdn.example/video.mp4?token=${secret}`, transport: 'progressive', container: 'mp4', requiredPipelines: ['native'] }], reason: 'fixture' },
    } }) });
  });
  await page.route('**/api/rooms/*/movies', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  const input = page.getByPlaceholder('影片网页、MP4/MKV、M3U8、MPD、FLV 或无后缀媒体 URL');
  await input.fill(`${FIXTURE_ORIGIN}/normal.mp4`);
  await page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '解析', exact: true }).click();
  await expect(page.getByText(/已识别 MP4/)).toBeVisible();
  await page.getByText('技术详情').click();
  expect(await page.locator('body').textContent()).not.toContain(secret);
  failMode = 'unknown';
  await input.fill(`${FIXTURE_ORIGIN}/extensionless`);
  await page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '解析', exact: true }).click();
  await expect(page.getByText('暂时无法解析此链接，请确认链接可访问后重试').first()).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(secret);
  failMode = 'denied';
  await input.fill(`${FIXTURE_ORIGIN}/denied`);
  await page.getByRole('tabpanel', { name: '添加影片' }).getByRole('button', { name: '解析', exact: true }).click();
  await expect(page.getByText('源站拒绝访问该页面，请确认你有访问权限').first()).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(secret);
  const apiErrorMessage = await page.evaluate(async (sourceInput) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    try { await resolveMediaInput(sourceInput); return ''; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, `${FIXTURE_ORIGIN}/denied`);
  expect(apiErrorMessage).not.toContain(secret);
});

test('real media resolve failure exposes a safe code and request ID to the API client', async ({ page }) => {
  await loginRoot(page);
  const failure = await page.evaluate(async (input) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    try {
      await resolveMediaInput(input);
      return { success: true };
    } catch (error) {
      const resolved = error as { name?: string; code?: string; retryable?: boolean; requestId?: string; message?: string };
      return { success: false, name: resolved.name, code: resolved.code,
        retryable: resolved.retryable, requestId: resolved.requestId, message: resolved.message };
    }
  }, `${FIXTURE_ORIGIN}/not-a-media-page`);
  expect(failure).toMatchObject({ success: false, name: 'MediaResolveError', code: 'RESOLVE_FAILED', retryable: true });
  expect(failure.requestId).toMatch(/^[a-zA-Z0-9-]+$/);
  expect(failure.message).not.toContain(FIXTURE_ORIGIN);
});

for (const [label, url] of [
  ['direct', 'https://abr-streaming.ondemandchina.com/v1/202503/korea/movies/ip-man-1/ip-man-1-2025-03-13-22-30-01.mp4/HLS/playlist_1080p.m3u8'],
  ['page', 'https://www.ondemandchina.com/zh-Hans/watch/ip-man-1-main-1/movie-1'],
]) {
  test(`authorized real ODC ${label} preserves 1080p playback`, async ({ page }) => {
    test.skip(process.env.TONGMU_REAL_MEDIA_SMOKE !== 'true', 'Explicit external-site smoke only');
    test.setTimeout(180_000);
    await loginAndCreateRoom(page);
    await page.getByRole('tab', { name: '添加影片', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '添加影片' });
    await page.getByPlaceholder(/影片网页、MP4\/MKV/).fill(url);
    const responsePromise = page.waitForResponse(response => response.status() !== 403 && response.url().endsWith('/api/stream/media/resolve') && response.request().postDataJSON().input === url);
    await panel.getByRole('button', { name: '解析', exact: true }).click();
    const response = await responsePromise;
    const result = await response.json();
    console.log('[real ODC resolve]', JSON.stringify({ label, status: response.status(), code: result.code, resolver: result.descriptor?.resolver, container: result.descriptor?.container }));
    expect(response.ok(), `Resolution failed: ${result.code ?? response.status()}`).toBe(true);
    expect(result.descriptor.container).toBe('hls');
    await panel.getByRole('button', { name: '添加', exact: true }).click();
    await page.getByRole('tab', { name: '影片列表', exact: true }).click();
    await page.getByRole('tabpanel', { name: '影片列表' }).getByRole('button', { name: '播放', exact: true }).last().click();
    const video = page.locator('video').first();
    await expect.poll(() => video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      if (element.readyState && element.paused) await element.play().catch(() => undefined);
      return element.videoHeight;
    }), { timeout: 90_000 }).toBe(1080);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 30_000 }).toBeGreaterThan(2);
    expect(await video.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBe(1080);
    console.log('[real ODC decoded]', await video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth, height: element.videoHeight, time: element.currentTime })));
    await video.evaluate((element: HTMLVideoElement) => element.pause());
  });
}

for (const [pathname, resolver] of [['static-video-page', 'generic-web'], ['dynamic-video-page', 'browser']]) {
test(`one HTTP request resolves ${resolver} page into a playable movie`, async ({ page }) => {
  test.setTimeout(60_000);
  await loginAndCreateRoom(page);
  if (resolver === 'browser') {
    const disabled = await page.evaluate(async input => {
    // @ts-ignore Vite integration entry.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    try { await resolveMediaInput(input, { browserSniff: false }); return 'unexpected success'; }
    catch (error) { return (error as { code?: string }).code; }
  }, `${FIXTURE_ORIGIN}/dynamic-video-page`);
    expect(disabled).toBe('NO_MEDIA_FOUND');
  }
    await page.getByRole('tab', { name: '添加影片', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '添加影片' });
    const input = page.getByPlaceholder(/影片网页、MP4\/MKV/);
    await input.fill(`${FIXTURE_ORIGIN}/${pathname}`);
    const responsePromise = page.waitForResponse(response => response.ok() && response.url().endsWith('/api/stream/media/resolve') && response.request().postDataJSON().input === `${FIXTURE_ORIGIN}/${pathname}`);
    await panel.getByRole('button', { name: '解析', exact: true }).click();
    const response = await responsePromise;
    const result = await response.json();
    expect(response.ok(), JSON.stringify(result)).toBe(true);
    expect(result.descriptor.resolver).toBe(resolver);
    await panel.getByRole('button', { name: '添加', exact: true }).click();
    await expect(input).toHaveValue('');
    await page.getByRole('tab', { name: '影片列表', exact: true }).click();
    const video = page.locator('video').first();
    await page.getByRole('tabpanel', { name: '影片列表' }).getByRole('button', { name: '播放', exact: true }).last().click();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      if (element.paused) {
        try { await element.play(); }
        catch (error) { if ((error as Error).name === 'AbortError') return 0; throw error; }
      }
      return element.currentTime;
    })).toBeGreaterThan(0);
});
}

test("real MP4 and extensionless sources load, play, and seek directly without gateway bytes", async ({
  page,
}) => {
  await loginAndCreateRoom(page);
  const gatewayBytes: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/stream/media/')) gatewayBytes.push(request.url()); });
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const video = page.locator("video").first();
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 1;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.7);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/extensionless`, /Engine: direct/);

  const stats = (await (
    await page.request.get(`${FIXTURE_ORIGIN}/stats`)
  ).json()) as Array<{ path: string; range: string }>;
  expect(
    stats.some(
      (entry) =>
        entry.path === "/normal.mp4" && entry.range.startsWith("bytes="),
    ),
  ).toBeTruthy();
  expect(stats.some((entry) => entry.path === "/extensionless")).toBeTruthy();
  expect(gatewayBytes).toEqual([]);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentSrc)).toContain('/extensionless');
});

test("real HLS master, extensionless child playlist, AES key, and fMP4 segment play", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/stream/media/"))
      mediaRequests.push(request.url());
  });
  await loginAndCreateRoom(page);
  await page.route(`${FIXTURE_ORIGIN}/**`, route => route.abort('blockedbyclient'));
  await addAndPlay(page, `${FIXTURE_ORIGIN}/hls/master.m3u8`, /Engine: hls/);
  const stats = (await (
    await page.request.get(`${FIXTURE_ORIGIN}/stats`)
  ).json()) as Array<{ path: string }>;
  for (const path of [
    "/hls/master.m3u8",
    "/hls/variant",
    "/hls/init.mp4",
    "/hls/key",
    "/hls/segment",
  ]) {
    expect(
      stats.some((entry) => entry.path === path),
      `missing upstream request ${path}`,
    ).toBeTruthy();
  }
  await assertRoomMediaOutlivesAccessJwt(page, mediaRequests, (url) =>
    url.includes("roomGrant="),
  );
});

test('anime provider reference resolves through Media Core and plays through its proxy candidate', async ({ page }) => {
  await loginRoot(page);
  const reference = await configureAnimeFixture(page);
  const episodeDto = await page.evaluate(async ({ fixtureOrigin }) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    const response = await apiFetch(
      `/api/stream/anime/episodes?source=rss_phase2c2-fixture&identifier=${encodeURIComponent(`${fixtureOrigin}/anime/episode-1`)}`,
    );
    return response.json();
  }, { fixtureOrigin: FIXTURE_ORIGIN });
  expect(JSON.stringify(episodeDto)).not.toContain('fixture-anime-token');
  const resolved = await page.evaluate(async (sourceInput) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    const result = await resolveMediaInput(sourceInput);
    return {
      descriptor: result.descriptor,
      plan: result.plan,
      sourceReference: result.sourceReference,
    };
  }, reference);

  expect(resolved.descriptor.resolver).toBe('anime');
  expect(resolved.descriptor.sourceType).toBe('anime');
  expect(resolved.sourceReference).toBe(reference);
  expect(resolved.plan.engine).toBe('direct');
  expect(resolved.plan.candidateMode).toBe('FULL_PROXY');
  expect(resolved.plan.proxy).toBe(true);
  expect(JSON.stringify(resolved)).not.toContain('fixture-anime-token');

  const playbackUrl = await page.evaluate(async (candidateUrl) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    await apiFetch('/api/auth/me');
    const token = localStorage.getItem('zviewer-access-token');
    if (!token) throw new Error('missing E2E access token');
    return `${candidateUrl}${candidateUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }, resolved.plan.candidateUrl ?? resolved.descriptor.finalUrl);
  await page.evaluate((url) => {
    const video = document.createElement('video');
    video.id = 'phase2c2-anime-video';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    document.body.appendChild(video);
    video.load();
    void video.play();
  }, playbackUrl);
  const video = page.locator('#phase2c2-anime-video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);

  const stats = (await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json()) as Array<{ path: string; queryKeys?: string[] }>;
  expect(stats.some((entry) => entry.path === '/anime/feed.xml')).toBe(true);
  expect(stats.some((entry) => entry.path === '/normal.mp4' && (entry.queryKeys ?? []).includes('token'))).toBe(true);
});

test('credentialed Live HLS resolves as live and attaches through the existing HLS gateway', async ({ page }) => {
  await loginRoot(page);
  const liveInput = `live://hls?url=${encodeURIComponent(`${FIXTURE_ORIGIN}/hls/master.m3u8?token=fixture-live-token`)}`;
  const resolved = await page.evaluate(async (sourceInput) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    const result = await resolveMediaInput(sourceInput);
    return { descriptor: result.descriptor, plan: result.plan };
  }, liveInput);

  expect(resolved.descriptor.resolver).toBe('live');
  expect(resolved.descriptor.sourceType).toBe('live');
  expect(resolved.descriptor.isLive).toBe(true);
  expect(resolved.descriptor.liveKind).toBe('hls');
  expect(resolved.descriptor.duration).toBeUndefined();
  expect(resolved.descriptor.seekable).toBe(false);
  expect(resolved.descriptor.reconnect).toBe('same-source');
  expect(resolved.plan.engine).toBe('hls');
  expect(resolved.plan.candidateMode).toBe('FULL_PROXY');
  expect(resolved.plan.proxy).toBe(true);
  expect(JSON.stringify(resolved)).not.toContain('fixture-live-token');

  const playbackUrl = await page.evaluate(async (candidateUrl) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    await apiFetch('/api/auth/me');
    const token = localStorage.getItem('zviewer-access-token');
    if (!token) throw new Error('missing E2E access token');
    return `${candidateUrl}${candidateUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }, resolved.plan.candidateUrl ?? resolved.descriptor.finalUrl);
  await page.evaluate(() => {
    const video = document.createElement('video');
    video.id = 'phase2c2-live-video';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
  });
  await page.evaluate(async (url) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { hlsEngine } = await import('/src/modules/player/engines/hls-engine.ts');
    const video = document.querySelector('#phase2c2-live-video') as HTMLVideoElement;
    const attached = await hlsEngine.attach(video, { url, format: 'hls', isLive: true });
    (window as unknown as { phase2c2LiveCleanup?: () => void }).phase2c2LiveCleanup = attached.cleanup;
    video.muted = true;
    await video.play();
  }, playbackUrl);
  const video = page.locator('#phase2c2-live-video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as { phase2c2LiveCleanup?: () => void }).phase2c2LiveCleanup?.();
  });

  const stats = (await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json()) as Array<{ path: string }>;
  for (const path of ['/hls/master.m3u8', '/hls/variant', '/hls/init.mp4', '/hls/key', '/hls/segment']) {
    expect(stats.some((entry) => entry.path === path), `missing upstream request ${path}`).toBe(true);
  }
});

test("HLS reattaches with a new room grant after Socket.IO reconnect", async ({ page }) => {
  await loginAndCreateRoom(page);
  await assertRoomGrantRefreshesAfterReconnect(
    page,
    `${FIXTURE_ORIGIN}/hls/master.m3u8`,
    /Engine: hls/,
  );
});

test("real DASH nested BaseURL requests video/audio init and relative segments", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/stream/media/"))
      mediaRequests.push(request.url());
  });
  await loginAndCreateRoom(page);
  await page.route(`${FIXTURE_ORIGIN}/**`, route => route.abort('blockedbyclient'));
  await addAndPlay(page, `${FIXTURE_ORIGIN}/dash/manifest.mpd`, /Engine: dash/);
  const stats = (await (
    await page.request.get(`${FIXTURE_ORIGIN}/stats`)
  ).json()) as Array<{ path: string }>;
  for (const path of [
    "/dash/manifest.mpd",
    "/dash/media/video/init.mp4",
    "/dash/media/video/chunk-1.m4s",
    "/dash/media/audio/init.mp4",
    "/dash/media/audio/chunk-1.m4s",
  ]) {
    expect(
      stats.some((entry) => entry.path === path),
      `missing upstream request ${path}`,
    ).toBeTruthy();
  }
  await assertRoomMediaOutlivesAccessJwt(page, mediaRequests, (url) =>
    url.includes("/asset?path=chunk-1.m4s"),
  );
});

test("DASH reattaches with a new room grant after Socket.IO reconnect", async ({ page }) => {
  await loginAndCreateRoom(page);
  await assertRoomGrantRefreshesAfterReconnect(
    page,
    `${FIXTURE_ORIGIN}/dash/manifest.mpd`,
    /Engine: dash/,
  );
});

test("unified media panel has no horizontal overflow at a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndCreateRoom(page);
  await page.getByRole("tab", { name: "添加影片", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test('unconnected media libraries remain discoverable with a profile connection path', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '添加影片' });
  await panel.getByRole('button', { name: 'Emby', exact: true }).click();
  await expect(panel.getByText('尚未连接此来源')).toBeVisible();
  const connectionLink = panel.getByRole('link', { name: '到个人空间添加挂载' });
  await expect(connectionLink).toHaveAttribute('href', '/profile');
  const popupPromise = page.waitForEvent('popup');
  await connectionLink.click();
  const profile = await popupPromise;
  await expect(profile).toHaveURL(/\/profile$/);
  await expect(page.getByRole('tabpanel', { name: '添加影片' })).toBeVisible();
  await profile.close();
  await panel.getByRole('button', { name: 'WebDAV', exact: true }).click();
  await expect(panel.getByText('可以在下方手动填写')).toBeVisible();
});

test('movie workspace remains usable across phone widths and landscape', async ({ page }, testInfo) => {
  await loginAndCreateRoom(page);
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('tab', { name: '添加影片', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '添加影片' });
    await panel.getByRole('button', { name: '视频链接 / 网页', exact: true }).click();
    const input = page.getByPlaceholder('影片网页、MP4/MKV、M3U8、MPD、FLV 或无后缀媒体 URL');
    await input.fill(`${FIXTURE_ORIGIN}/normal.mp4`);
    await input.focus();
    await expect(input).toBeFocused();
    await panel.getByRole('button', { name: '解析', exact: true }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole('button', { name: '解析', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`movie-workspace-${viewport.width}x${viewport.height}.png`), fullPage: true });
  }
});

test('host phone shortcut opens add panel without remounting the playing video', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const video = page.locator('video').first();
  await video.evaluate((element: HTMLVideoElement) => { (element as HTMLVideoElement & { shortcutProbe?: boolean }).shortcutProbe = true; });
  await page.getByRole('tab', { name: '影片列表', exact: true }).click();
  await expect(page.getByRole('tab', { name: '影片列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '添加影片', exact: true }).click();
  await expect(page.getByRole('tab', { name: '添加影片', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await video.evaluate((element: HTMLVideoElement) => (element as HTMLVideoElement & { shortcutProbe?: boolean }).shortcutProbe)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('host can seek with keyboard on the playback slider', async ({ page }) => {
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const video = page.locator('video').first();
  await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = 0; });
  await video.hover();
  const slider = page.getByRole('slider', { name: '播放进度', exact: true });
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
  await slider.focus();
  await slider.press('ArrowRight');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await slider.press('Home');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeLessThan(0.2);
  await slider.press('End');
  await expect.poll(async () => {
    const { currentTime, duration } = await video.evaluate((element: HTMLVideoElement) => ({ currentTime: element.currentTime, duration: element.duration }));
    return duration - currentTime;
  }).toBeLessThan(0.2);
});

test('room modal traps keyboard focus and restores its trigger on close', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '影片列表', exact: true }).click();
  const trigger = page.getByRole('button', { name: '展开查看完整影片列表' });
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: /影片列表/ });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const close = dialog.getByRole('button', { name: '关闭弹窗' });
  await expect(close).toBeFocused();
  await close.press('Tab');
  await expect(dialog).toContainText('影片列表');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('source dropdown and mount input expose keyboard and error semantics', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.getByRole('tab', { name: '添加影片', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '添加影片' });
  await panel.getByRole('button', { name: 'WebDAV', exact: true }).click();
  const mode = panel.locator('button[aria-haspopup="listbox"]').last();
  await mode.focus();
  await mode.press('ArrowDown');
  const listbox = page.getByRole('listbox');
  await expect(listbox.getByRole('option', { name: '服务器转发' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const direct = listbox.getByRole('option', { name: '直链直连' });
  await expect(direct).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(mode).toHaveAttribute('aria-expanded', 'false');
  await expect(mode).toContainText('直链直连');

  await page.goto('/profile');
  await page.getByRole('button', { name: '添加挂载' }).click();
  const name = page.getByRole('textbox', { name: '挂载名称' });
  await page.getByText('挂载名称', { exact: true }).click();
  await expect(name).toBeFocused();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(await name.getAttribute('aria-describedby')).toBeTruthy();
});

test('movie deletion requires confirmation and cancellation keeps the movie', async ({ page }) => {
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const panel = page.getByRole('tabpanel', { name: '影片列表' });
  await expect(panel.getByText('视频直链', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除影片', exact: true });
  await expect(confirmation).toContainText('normal.mp4');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(panel.getByText('normal.mp4', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '删除', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(panel.getByText('normal.mp4', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('暂无影片，请切换到“添加影片”')).toBeVisible();
});

test('nested delete confirmation keeps the list dialog open and restores focus', async ({ page }) => {
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  await page.getByRole('button', { name: '展开查看完整影片列表' }).click();
  const list = page.getByRole('dialog', { name: /影片列表/ });
  const remove = list.getByRole('button', { name: '删除', exact: true });
  await remove.click();
  const confirmation = page.getByRole('dialog', { name: '删除影片', exact: true });
  await expect(confirmation.getByRole('button', { name: '关闭弹窗' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(list).toBeVisible();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

for (const [asset, engine] of [['/hls/master.m3u8', /Engine: hls/], ['/dash/manifest.mpd', /Engine: dash/], ['/normal.mp4?signature=public-playback&expires=9999999999', /Engine: direct/]] as const) {
  test(`public ${asset} plays Direct without gateway media requests`, async ({ page }) => {
    const gateway: string[] = [];
    page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/stream/media/')) gateway.push(request.url()); });
    await loginAndCreateRoom(page);
    await addAndPlay(page, `${FIXTURE_ORIGIN}${asset}`, engine);
    expect(gateway).toEqual([]);
    expect(await page.locator('video').first().evaluate((v: HTMLVideoElement) => v.dataset.mediaTransport)).toBe('DIRECT');
    if (asset.includes('signature=')) {
      await expect.poll(() => persistedMovieContains('public-playback')).toBe(false);
    }
  });
}

test('AES key CORS failure uses a manifest-assisted key proxy while segment bytes remain Direct', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.route(`${FIXTURE_ORIGIN}/hls/key`, route => route.abort('blockedbyclient'));
  const segmentRequests: string[] = [];
  page.on('request', request => { if (request.url() === `${FIXTURE_ORIGIN}/hls/segment`) segmentRequests.push(request.url()); });
  await addAndPlay(page, `${FIXTURE_ORIGIN}/hls/master.m3u8`, /Engine: hls/);
  const video = page.locator('video').first();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.dataset.mediaTransport), { timeout: 15_000 })
    .toBe('MANIFEST_ASSISTED');
  await expect.poll(() => segmentRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

test('private source token stays out of media resolve and Socket movie-list; host refresh uses movie reference', async ({ page }) => {
  const lists: string[] = [];
  page.on('websocket', ws => ws.on('framereceived', frame => { const payload = String(frame.payload); if (payload.includes('movie-list')) lists.push(payload); }));
  await loginAndCreateRoom(page);
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/api/stream/media/resolve') && response.ok(),
  );
  await page.getByRole("tab", { name: "添加影片", exact: true }).click();
  await page.getByPlaceholder(/影片网页、MP4\/MKV/).last().fill(`${FIXTURE_ORIGIN}/normal.mp4?token=private-source-secret`);
  await page.getByRole('button', { name: '解析', exact: true }).last().click();
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBe(true);
  expect(JSON.stringify(payload)).not.toContain('private-source-secret');
  await page.getByRole('button', { name: '添加', exact: true }).last().click();
  await expect.poll(() => lists.some(value => value.includes('media-movie:'))).toBe(true);
  expect(lists.join('')).not.toContain('private-source-secret');
  await expect.poll(() => persistedMovieContains('private-source-secret')).toBe(false);
  const refresh = await page.evaluate(async () => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    const stored = JSON.parse(sessionStorage.getItem('zviewer-room-media-grant')!);
    const movies = await (await apiFetch(`/api/rooms/${stored.roomId}/movies?roomGrant=${encodeURIComponent(stored.grant)}`)).json();
    const movie = (movies.data?.movies ?? movies.movies ?? movies.data)[0];
    const response = await apiFetch('/api/stream/media/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: movie.sourceInput, roomId: stored.roomId, roomGrant: stored.grant }) });
    return { status: response.status, body: await response.json() };
  });
  expect(refresh.status, JSON.stringify(refresh.body)).toBe(200);
  expect(JSON.stringify(refresh.body)).not.toContain('private-source-secret');
  await page.getByRole("tab", { name: "影片列表", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    // @ts-ignore application module
    const { useRoomStore } = await import('/src/store/roomStore.ts');
    return useRoomStore.getState().movies.length;
  })).toBe(1);
  await page.evaluate(async () => {
    // @ts-ignore application module
    const { useRoomStore } = await import('/src/store/roomStore.ts');
    const store = useRoomStore.getState(); const movie = store.movies[0];
    await store.updateMovie(store.roomId, movie.id, { mediaDescriptor: { ...movie.mediaDescriptor, expiresAt: 0 } });
  });
  await page.getByText('normal.mp4', { exact: true }).last().locator('../..').getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    // @ts-ignore application module
    const { useRoomStore } = await import('/src/store/roomStore.ts');
    return Number(useRoomStore.getState().movies[0]?.mediaDescriptor?.expiresAt ?? 0) > Date.now();
  })).toBe(true);
  await expect.poll(() => page.locator('video').first().evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);

});

test('runtime media error reattaches real MP4 through same-quality proxy and preserves position and pause', async ({ page }) => {
  await loginAndCreateRoom(page);
  await addAndPlay(page, `${FIXTURE_ORIGIN}/normal.mp4`, /Engine: direct/);
  const video = page.locator('video').first();
  const original = await video.evaluate((v: HTMLVideoElement) => {
    v.pause(); v.currentTime = 0.8; v.playbackRate = 1.5;
    return { width: v.videoWidth, height: v.videoHeight };
  });
  // Simulate the browser's runtime network error event after initial playback;
  // both the initial video and replacement gateway stream are real media.
  await video.evaluate((v: HTMLVideoElement) => v.dispatchEvent(new Event('error')));
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.dataset.mediaTransport)).toBe('FULL_PROXY');
  const restored = await video.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, paused: v.paused, rate: v.playbackRate, width: v.videoWidth, height: v.videoHeight, url: v.currentSrc }));
  expect(restored.time).toBeGreaterThan(0.6);
  expect(restored.paused).toBe(true);
  expect(restored.rate).toBe(1.5);
  expect(restored.width).toBe(original.width); expect(restored.height).toBe(original.height);
  expect(restored.url).toContain('/api/stream/media/');
});

test('storage providers resolve through mediaApi and play via scoped gateway fixtures', async ({ page }) => {
  await loginRoot(page);
  const storageDir = path.resolve('.e2e-runtime', 'phase2b-local-storage');
  await mkdir(storageDir, { recursive: true });
  const fixtureResponse = await page.request.get(`${FIXTURE_ORIGIN}/normal.mp4`);
  expect(fixtureResponse.ok(), await fixtureResponse.text()).toBe(true);
  await writeFile(path.join(storageDir, 'movie.mp4'), await fixtureResponse.body());

  const mounts = await page.evaluate(async (rootPath) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import('/src/lib/api.ts');
    const request = async (url: string, body: Record<string, unknown>) => {
      const response = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(JSON.stringify(payload));
      return payload;
    };
    const root = await request('/api/server-files/roots', {
      name: 'phase2b-e2e-local', absPath: rootPath, readonly: true,
    });
    const webdav = await request('/api/webdav/mounts', {
      name: 'phase2b-e2e-webdav', serverUrl: 'http://127.0.0.1:3456/dav', path: '/',
      username: 'fixture-user', password: 'fixture-pass', directLink: true,
    });
    const openlist = await request('/api/openlist/mounts', {
      name: 'phase2b-e2e-openlist', serverUrl: 'http://127.0.0.1:3456', path: '/',
      username: 'fixture-user', password: 'fixture-pass', directLink: true,
    });
    return {
      rootKey: root.root.key as string,
      rootId: Number(String(root.root.key).split(':')[1]),
      webdavId: Number(webdav.mount.id),
      openlistId: Number(openlist.mount.id),
    };
  }, storageDir);

  const localInput = `storage://local-file?path=${encodeURIComponent('/movie.mp4')}&rootKey=${encodeURIComponent(mounts.rootKey)}`;
  const webdavInput = `storage://webdav?path=${encodeURIComponent('/movie.mp4')}&mountId=${mounts.webdavId}`;
  const openlistInput = `storage://openlist?path=${encodeURIComponent('/movie.mp4')}&mountId=${mounts.openlistId}`;
  const video = page.locator('video').first();
  await page.evaluate(() => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
  });

  try {
    for (const [input, resolver] of [
      [localInput, 'local-file'],
      [webdavInput, 'webdav'],
      [openlistInput, 'openlist'],
    ] as const) {
      const resolved = await page.evaluate(async (sourceInput) => {
        // @ts-ignore Vite serves application modules for the browser integration test.
        const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
        const result = await resolveMediaInput(sourceInput);
        return {
          descriptor: result.descriptor,
          plan: result.plan,
        };
      }, input);
      expect(resolved.descriptor.resolver).toBe(resolver);
      expect(resolved.plan.candidateMode).toBe('FULL_PROXY');
      expect(resolved.descriptor.finalUrl).toContain('/api/stream/media/');
      expect(JSON.stringify(resolved)).not.toContain('fixture-pass');
      expect(JSON.stringify(resolved)).not.toContain('fixture-user');

      const playbackUrl = await page.evaluate(async (candidateUrl) => {
        // Refresh the short-lived E2E access token through the normal API path
        // before the media element requests the scoped gateway URL.
        // @ts-ignore Vite serves application modules for the browser integration test.
        const { apiFetch } = await import('/src/lib/api.ts');
        await apiFetch('/api/auth/me');
        const token = localStorage.getItem('zviewer-access-token');
        if (!token) throw new Error('missing E2E access token');
        return `${candidateUrl}${candidateUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      }, resolved.plan.candidateUrl ?? resolved.descriptor.finalUrl);
      await video.evaluate((element, url) => {
        element.src = url;
        element.load();
        void element.play();
      }, playbackUrl);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
      await video.evaluate((element: HTMLVideoElement) => element.pause());
    }
  } finally {
    await page.evaluate(async (ids) => {
      // @ts-ignore Vite serves application modules for the browser integration test.
      const { apiFetch } = await import('/src/lib/api.ts');
      await Promise.all([
        apiFetch(`/api/webdav/mounts/${ids.webdavId}`, { method: 'DELETE' }),
        apiFetch(`/api/openlist/mounts/${ids.openlistId}`, { method: 'DELETE' }),
        apiFetch(`/api/server-files/roots/${ids.rootId}`, { method: 'DELETE' }),
      ]);
    }, mounts).catch(() => undefined);
  }
});

for (const provider of ['emby', 'jellyfin'] as const) {
  test(`${provider} playback converges through mediaApi and provider session lifecycle`, async ({ page }) => {
    await loginRoot(page);
    const mount = await createMediaServerMount(page, provider);
    try {
      const resolved = await page.evaluate(async (sourceInput) => {
        // @ts-ignore Vite serves application modules for the browser integration test.
        const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
        const result = await resolveMediaInput(sourceInput);
        return {
          descriptor: result.descriptor,
          plan: result.plan,
          sourceReference: result.sourceReference,
        };
      }, mount.reference);

      expect(resolved.descriptor.resolver).toBe(provider);
      expect(resolved.descriptor.sourceMetadata?.[provider]?.providerReference).toBe(mount.reference);
      expect(resolved.descriptor.sourceMetadata?.[provider]?.representationId).toBe('source-1');
      expect(resolved.descriptor.sourceMetadata?.[provider]?.subtitles?.[0]).toMatchObject({
        index: 2,
        language: 'eng',
        codec: 'srt',
        embedded: false,
        external: true,
        default: true,
      });
      expect(resolved.sourceReference).toBe(mount.reference);
      expect(resolved.plan.engine).toBe('direct');
      expect(resolved.plan.candidateMode).toBe('FULL_PROXY');
      expect(resolved.plan.proxy).toBe(true);
      expect(resolved.plan.upstreamMode).toBe('direct-play');
      expect(resolved.plan.representationId).toBe('source-1');
      expect(resolved.plan.qualityChanged).toBe(false);
      expect(JSON.stringify(resolved)).not.toContain('fixture-api-key');
      expect(JSON.stringify(resolved)).not.toContain(FIXTURE_ORIGIN);

      const playbackUrl = await page.evaluate(async (candidateUrl) => {
        // Refresh the short-lived E2E access token through the normal API path
        // before the media element requests the scoped gateway URL.
        // @ts-ignore Vite serves application modules for the browser integration test.
        const { apiFetch } = await import('/src/lib/api.ts');
        await apiFetch('/api/auth/me');
        const token = localStorage.getItem('zviewer-access-token');
        if (!token) throw new Error('missing E2E access token');
        return `${candidateUrl}${candidateUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      }, resolved.plan.candidateUrl ?? resolved.descriptor.finalUrl);
      await page.evaluate((url) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.src = url;
        document.body.appendChild(video);
        video.load();
        void video.play();
      }, playbackUrl);
      const video = page.locator('video').last();
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);

      expect(resolved.plan.playbackSessionUrl).toBeTruthy();
      await page.evaluate(async (sessionUrl) => {
        // @ts-ignore Vite serves application modules for the browser integration test.
        const {
          startMediaPlaybackSession,
          reportMediaPlaybackProgress,
          stopMediaPlaybackSession,
          cleanupMediaPlaybackSession,
        } = await import('/src/modules/media/mediaApi.ts');
        await startMediaPlaybackSession(sessionUrl);
        await reportMediaPlaybackProgress(sessionUrl, 1.25, false);
        await stopMediaPlaybackSession(sessionUrl, 1.25);
        await cleanupMediaPlaybackSession(sessionUrl);
      }, resolved.plan.playbackSessionUrl!);

      const stats = (await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json()) as Array<{
        path: string;
        method: string;
        queryKeys?: string[];
        hasMediaServerToken?: boolean;
      }>;
      const relevant = stats.filter((entry) =>
        /\/Items\/fixture-movie\/PlaybackInfo|\/Videos\/fixture-movie\/stream|\/Sessions\/Playing|\/Videos\/ActiveEncodings/.test(entry.path));
      expect(relevant.some((entry) => /\/Items\/fixture-movie\/PlaybackInfo/.test(entry.path) && entry.method === 'POST')).toBe(true);
      expect(relevant.some((entry) => /\/Videos\/fixture-movie\/stream/.test(entry.path) && entry.method === 'GET')).toBe(true);
      expect(relevant.some((entry) => entry.path.endsWith('/Sessions/Playing') && entry.method === 'POST')).toBe(true);
      expect(relevant.some((entry) => entry.path.endsWith('/Sessions/Playing/Progress') && entry.method === 'POST')).toBe(true);
      expect(relevant.some((entry) => entry.path.endsWith('/Sessions/Playing/Stopped') && entry.method === 'POST')).toBe(true);
      expect(relevant.some((entry) => /\/Videos\/ActiveEncodings(?:\/Delete)?$/.test(entry.path))).toBe(true);
      expect(relevant.every((entry) => entry.hasMediaServerToken === true)).toBe(true);
      expect(relevant.every((entry) => !(entry.queryKeys ?? []).includes('api_key'))).toBe(true);
    } finally {
      await page.evaluate(async ({ provider, mountId }) => {
        // @ts-ignore Vite serves application modules for the browser integration test.
        const { apiFetch } = await import('/src/lib/api.ts');
        await apiFetch(`/api/${provider}/mounts/${mountId}`, { method: 'DELETE' });
      }, { provider, mountId: mount.mountId }).catch(() => undefined);
    }
  });
}

test('Phase 3B cache keeps authorized Range quality and bounds upstream reads', async ({ page }) => {
  test.skip(process.env.SLICE_CACHE_E2E !== 'true', 'run with SLICE_CACHE_E2E=true');
  await loginRoot(page);

  const resolved = await page.evaluate(async (fixtureOrigin) => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { resolveMediaInput } = await import('/src/modules/media/mediaApi.ts');
    const result = await resolveMediaInput(`${fixtureOrigin}/normal.mp4?token=phase3b-e2e-secret`);
    const candidate = result.descriptor.transportPlan?.candidates?.find((item) => item.mode === 'FULL_PROXY');
    const accessToken = localStorage.getItem('zviewer-access-token');
    if (!candidate?.url || !accessToken) throw new Error('missing FULL_PROXY candidate or access token');
    const playbackUrl = new URL(candidate.url, location.origin);
    playbackUrl.searchParams.set('token', accessToken);
    return { mode: candidate.mode, url: playbackUrl.toString() };
  }, FIXTURE_ORIGIN);

  expect(resolved.mode).toBe('FULL_PROXY');
  const before = (await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json()) as Array<{
    path: string;
    method?: string;
    range?: string;
  }>;
  const readRange = async () => page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-63' } });
    const body = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', body);
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      length: body.byteLength,
      digest: Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join(''),
    };
  }, resolved.url);

  const first = await readRange();
  const second = await readRange();
  expect(first).toEqual(second);
  expect(first.status).toBe(206);
  expect(first.contentRange).toMatch(/^bytes 0-63\/\d+$/);
  expect(first.length).toBe(64);

  const after = (await (await page.request.get(`${FIXTURE_ORIGIN}/stats`)).json()) as Array<{
    path: string;
    method?: string;
    range?: string;
  }>;
  const upstreamReads = after.slice(before.length).filter((entry) =>
    entry.path === '/normal.mp4' && entry.method === 'GET');
  expect(upstreamReads.length).toBe(process.env.SLICE_CACHE_ENABLED === 'true' ? 1 : 2);
});

test('Phase 4A rapid A to B to A keeps only the newest source generation active', async ({ page }) => {
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const {
      createPlayerGeneration,
      disposePlayerGeneration,
      isCurrentPlayerGeneration,
      getPlayerResourceSnapshot,
    } = await import('/src/modules/player/lifecycle.ts');
    const a1 = createPlayerGeneration(1, 401);
    let current = a1;
    const committed: string[] = [];
    const lateCommit = (generation: typeof a1, label: string, delay: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (isCurrentPlayerGeneration(current, generation)) committed.push(label);
          resolve();
        }, delay);
      });
    const first = lateCommit(a1, 'A1', 80);
    disposePlayerGeneration(a1);
    const b = createPlayerGeneration(2, 402);
    current = b;
    const second = lateCommit(b, 'B', 50);
    disposePlayerGeneration(b);
    const a2 = createPlayerGeneration(3, 403);
    current = a2;
    const third = lateCommit(a2, 'A2', 5);
    await Promise.all([first, second, third]);
    disposePlayerGeneration(a2);
    return { committed, resources: getPlayerResourceSnapshot() };
  });
  expect(result.committed).toEqual(['A2']);
  expect(result.resources.activePlayerFetchControllers).toBe(0);
});

test('Phase 4A HLS to DASH replacement retires the previous engine resources', async ({ page }) => {
  await loginAndCreateRoom(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const hls = `${FIXTURE_ORIGIN}/hls/master.m3u8?generation=phase4a-hls`;
  const dash = `${FIXTURE_ORIGIN}/dash/manifest.mpd?generation=phase4a-dash`;

  await page.route(`${FIXTURE_ORIGIN}/**`, route => route.abort('blockedbyclient'));
  await addAndPlay(page, hls, /Engine: hls/);
  const hlsRequestsBeforeReplacement = requests.filter((url) => /\/hls\//.test(url)).length;

  await addAndPlay(page, dash, /Engine: dash/);
  await page.waitForTimeout(1_000);
  expect(requests.filter((url) => /\/hls\//.test(url)).length).toBe(hlsRequestsBeforeReplacement);
});

test('Phase 4A external subtitle work cannot cross a source-generation switch', async ({ page }) => {
  await page.goto('/login');
  await page.route('**/phase4a-old.srt', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: '1\n00:00:00,000 --> 00:00:01,000\nold-generation\n',
    });
  });
  await page.route('**/phase4a-new.srt', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: '1\n00:00:00,000 --> 00:00:01,000\nnew-generation\n',
    });
  });
  const result = await page.evaluate(async () => {
    const { fetchGenerationBoundSubtitleText } = await import('/src/lib/subtitleLifecycle.ts');
    const { parseSubtitle, subtitleCueIdentity } = await import('/src/lib/subtitleParser.ts');
    const generation = { current: 421 };
    const oldTextPromise = fetchGenerationBoundSubtitleText({
      url: '/phase4a-old.srt',
      generation: generation.current,
      getCurrentGeneration: () => generation.current,
    });
    generation.current = 422;
    const newText = await fetchGenerationBoundSubtitleText({
      url: '/phase4a-new.srt',
      generation: generation.current,
      getCurrentGeneration: () => generation.current,
    });
    const oldText = await oldTextPromise;
    const oldCues = parseSubtitle(oldText ?? '', 'srt');
    const newCues = parseSubtitle(newText ?? '', 'srt');
    return {
      generation: generation.current,
      oldCommitted: oldText !== null,
      newCommitted: newText !== null,
      oldIdentity: oldCues[0] ? subtitleCueIdentity(oldCues[0], 'external:old') : null,
      newIdentity: newCues[0] ? subtitleCueIdentity(newCues[0], 'external:new') : null,
      oldText: oldCues[0]?.text,
      newText: newCues[0]?.text,
    };
  });
  expect(result.generation).toBe(422);
  expect(result.oldCommitted).toBe(false);
  expect(result.newCommitted).toBe(true);
  expect(result.oldIdentity).toBeNull();
  expect(result.newIdentity).toBeTruthy();
  expect(result.oldText).toBeUndefined();
  expect(result.newText).toBe('new-generation');
});
