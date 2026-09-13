import { expect, test, type Page } from "@playwright/test";

const FIXTURE_ORIGIN = "http://127.0.0.1:3456";

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
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<jwt-redacted>')
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

async function logMediaDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const capability = await page.evaluate(() => {
      const mimeTypes = [
        'video/mp4; codecs="avc1.42001e"',
        'video/mp4; codecs="avc1.42001e,mp4a.40.2"',
        'audio/mp4; codecs="mp4a.40.2"',
        'video/iso.segment; codecs="avc1.42001e"',
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
    });
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
    const fixtureDiagnostics = await (await page.request.get(`${FIXTURE_ORIGIN}/diagnostics`)).json();
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
  await page.getByRole("button", { name: "开始共享", exact: true }).click();
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(page).toHaveURL(/\/room\//);
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
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/).last();
  await input.fill(url);
  await page.getByRole("button", { name: "添加", exact: true }).last().click();
  await expect(page.getByText(/Resolver: direct-url/).last()).toBeVisible();
  await expect(page.getByText(engine).last()).toBeVisible();
  const title = decodeURIComponent(new URL(url).pathname.split('/').pop()!);
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
  installMediaDiagnostics(page, testInfo.title);
});

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
  await page.getByRole("button", { name: "切换到添加影片" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

for (const [asset, engine] of [['/hls/master.m3u8', /Engine: hls/], ['/dash/manifest.mpd', /Engine: dash/], ['/normal.mp4?signature=public-playback&expires=9999999999', /Engine: direct/]] as const) {
  test(`public ${asset} plays Direct without gateway media requests`, async ({ page }) => {
    const gateway: string[] = [];
    page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/stream/media/')) gateway.push(request.url()); });
    await loginAndCreateRoom(page);
    await addAndPlay(page, `${FIXTURE_ORIGIN}${asset}`, engine);
    expect(gateway).toEqual([]);
    expect(await page.locator('video').first().evaluate((v: HTMLVideoElement) => v.dataset.mediaTransport)).toBe('DIRECT');
  });
}

test('AES key CORS failure uses PARTIAL_PROXY while segment bytes remain Direct', async ({ page }) => {
  await loginAndCreateRoom(page);
  await page.route(`${FIXTURE_ORIGIN}/hls/key`, route => route.abort('blockedbyclient'));
  const segmentRequests: string[] = [];
  page.on('request', request => { if (request.url() === `${FIXTURE_ORIGIN}/hls/segment`) segmentRequests.push(request.url()); });
  await addAndPlay(page, `${FIXTURE_ORIGIN}/hls/master.m3u8`, /Engine: hls/);
  expect(await page.locator('video').first().evaluate((v: HTMLVideoElement) => v.dataset.mediaTransport)).toBe('PARTIAL_PROXY');
  expect(segmentRequests.length).toBeGreaterThan(0);
});

test('private source token stays out of media resolve and Socket movie-list; host refresh uses movie reference', async ({ page }) => {
  const lists: string[] = [];
  page.on('websocket', ws => ws.on('framereceived', frame => { const payload = String(frame.payload); if (payload.includes('movie-list')) lists.push(payload); }));
  await loginAndCreateRoom(page);
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/stream/media/resolve'));
  await page.getByPlaceholder(/影片网页、MP4\/MKV/).last().fill(`${FIXTURE_ORIGIN}/normal.mp4?token=private-source-secret`);
  await page.getByRole('button', { name: '添加', exact: true }).last().click();
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBe(true);
  expect(JSON.stringify(payload)).not.toContain('private-source-secret');
  await expect.poll(() => lists.some(value => value.includes('media-movie:'))).toBe(true);
  expect(lists.join('')).not.toContain('private-source-secret');
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
