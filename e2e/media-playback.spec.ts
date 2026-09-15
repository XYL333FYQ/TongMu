import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  await page.getByRole("button", { name: "开始共享", exact: true }).click();
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
  const input = page.getByPlaceholder(/影片网页、MP4\/MKV/).last();
  await input.fill(url);
  await page.getByRole("button", { name: "添加", exact: true }).last().click();
  await expect(page.getByText(/Resolver: (?:direct-url|live)/).last()).toBeVisible();
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
