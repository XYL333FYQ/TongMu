import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill(username);
  await page.getByPlaceholder("请输入密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
}

async function createRoom(host: Page): Promise<string> {
  const room = await host.evaluate(
    () =>
      new Promise<{ success?: boolean; data?: { roomId?: string } }>(
        (resolve) => {
          const socket = (
            window as unknown as { __debugSocket: { emit: Function } }
          ).__debugSocket;
          socket.emit(
            "create-room",
            { mode: "watch-together", requireApproval: false },
            resolve,
          );
        },
      ),
  );
  if (!room.success || !room.data?.roomId)
    throw new Error("create-room failed");
  await host.evaluate(
    (roomId) => sessionStorage.setItem("zcontrol-host-room", roomId),
    room.data.roomId,
  );
  await host.goto(`/room/${room.data.roomId}`);
  return room.data.roomId;
}

async function musicStore(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const { useMusicStore } = await import("/src/modules/music/store.ts");
    const state = useMusicStore.getState();
    return {
      roomId: state.roomId,
      queueLength: state.queue.length,
      queueIds: state.queue.map((item) => item.queueItemId),
      currentQueueItemId: state.currentQueueItemId,
      currentSourceRef: state.currentSourceRef,
      version: state.version,
      musicGeneration: state.musicGeneration,
      isPlaying: state.isPlaying,
      pendingHostRequests: state.pendingHostRequests.length,
    };
  });
}

async function addFixture(
  page: Page,
  roomId: string,
  title: string,
  sourceRef: string,
): Promise<unknown> {
  return page.evaluate(
    async ({ roomId, title, sourceRef }) => {
      const { useMusicStore } = await import("/src/modules/music/store.ts");
      const current = useMusicStore.getState();
      return new Promise<unknown>((resolve) => {
        const socket = (
          window as unknown as { __debugSocket: { emit: Function } }
        ).__debugSocket;
        socket.emit(
          "music:queue-add",
          {
            roomId,
            item: { sourceRef, title, artist: "E2E", durationMs: 4_000 },
            baseVersion: current.version,
            musicGeneration: current.musicGeneration,
            mutationId: `e2e-${title}-${Date.now()}`,
          },
          resolve,
        );
      });
    },
    { roomId, title, sourceRef },
  );
}

async function emitMusic(
  page: Page,
  event: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(
    ({ event, payload }) =>
      new Promise<unknown>((resolve) => {
        const socket = (
          window as unknown as { __debugSocket: { emit: Function } }
        ).__debugSocket;
        socket.emit(event, payload, resolve);
      }),
    { event, payload },
  );
}

test("Phase 5B-1 Together Listen covers fixture playback, queue identity, viewer request, and range", async ({
  browser,
}) => {
  const host = await browser.newPage();
  let viewerContext: BrowserContext | null = null;
  let viewer: Page | null = null;
  let viewerContext2: BrowserContext | null = null;
  let viewer2: Page | null = null;
  const username = `phase5b_${Date.now()}`;
  const username2 = `${username}_b`;
  const password = "phase5b-pass";
  try {
    await login(host, "root", "root");
    const settings = await host.evaluate(async () => {
      const { apiFetch } = await import("/src/lib/api.ts");
      const response = await apiFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoDeleteInactiveRooms: true,
          autoDeleteAfterHours: 24,
          registrationMode: "open",
          roomCreationMode: "admin-only",
        }),
      });
      return response.ok;
    });
    expect(settings).toBe(true);
    const registration = await host.request.post("/api/auth/register", {
      data: { username, password },
    });
    expect(registration.ok()).toBe(true);
    const registration2 = await host.request.post("/api/auth/register", {
      data: { username: username2, password },
    });
    expect(registration2.ok()).toBe(true);

    const roomId = await createRoom(host);
    await expect(host.getByRole("heading", { name: "一起听" })).toBeVisible();

    viewerContext = await browser.newContext({
      baseURL: "http://127.0.0.1:5173",
    });
    viewer = await viewerContext.newPage();
    await login(viewer, username, password);
    await viewer.goto(`/room/${roomId}`);
    await expect(viewer.getByRole("heading", { name: "一起听" })).toBeVisible();

    viewerContext2 = await browser.newContext({
      baseURL: "http://127.0.0.1:5173",
    });
    viewer2 = await viewerContext2.newPage();
    await login(viewer2, username2, password);
    await viewer2.goto(`/room/${roomId}`);
    await expect(
      viewer2.getByRole("heading", { name: "一起听" }),
    ).toBeVisible();

    const viewerPanel = viewer
      .locator(".glass-card")
      .filter({ has: viewer.getByRole("heading", { name: "一起听" }) });
    const viewerPanel2 = viewer2
      .locator(".glass-card")
      .filter({ has: viewer2.getByRole("heading", { name: "一起听" }) });

    await host.evaluate(() => {
      const socket = (
        window as unknown as {
          __debugSocket: {
            on: (event: string, listener: (value: unknown) => void) => void;
          };
          __phase5bAcks: unknown[];
        }
      ).__debugSocket;
      const acks: unknown[] = [];
      socket.on("music:track-ack", (value) => acks.push(value));
      (window as unknown as { __phase5bAcks: unknown[] }).__phase5bAcks = acks;
    });

    const firstAck = await addFixture(
      host,
      roomId,
      "蓝色时刻",
      "music://fixture/blue-hour",
    );
    expect((firstAck as { success?: boolean }).success).toBe(true);
    await expect
      .poll(async () => (await musicStore(viewer!)).queueLength)
      .toBe(1);
    const firstState = await musicStore(viewer);
    expect(firstState.currentSourceRef).toBe("music://fixture/blue-hour");
    expect((firstState.currentQueueItemId as number) > 0).toBe(true);

    await expect
      .poll(async () => viewerPanel.locator("audio").getAttribute("src"))
      .toContain("/api/music/fixture/blue-hour");
    await expect
      .poll(async () =>
        viewerPanel.locator("audio").evaluate((audio) => audio.readyState),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        viewerPanel2.locator("audio").evaluate((audio) => audio.readyState),
      )
      .toBeGreaterThan(0);

    const secondAck = await addFixture(
      host,
      roomId,
      "蓝色时刻（重复）",
      "music://fixture/blue-hour",
    );
    expect((secondAck as { success?: boolean }).success).toBe(true);
    await expect
      .poll(async () => (await musicStore(viewer!)).queueLength)
      .toBe(2);
    const duplicateIds = (await musicStore(viewer)).queueIds as number[];
    expect(new Set(duplicateIds).size).toBe(2);

    await viewerPanel.locator('button[aria-label="播放"]').click();
    await expect
      .poll(async () => (await musicStore(host)).pendingHostRequests)
      .toBe(1);
    const hostPanel = host
      .locator(".glass-card")
      .filter({ has: host.getByRole("heading", { name: "一起听" }) });
    await hostPanel.getByRole("button", { name: "同意", exact: true }).click();
    await expect
      .poll(async () => (await musicStore(viewer!)).isPlaying)
      .toBe(true);
    await expect
      .poll(async () => (await musicStore(viewer2!)).isPlaying)
      .toBe(true);

    const oldGeneration = firstState.musicGeneration as number;
    const oldVersion = firstState.version as number;
    const oldQueueItemId = firstState.currentQueueItemId as number;
    await hostPanel.locator('button[aria-label="下一首"]').click();
    await expect
      .poll(async () => {
        const state = await musicStore(viewer!);
        return [state.currentQueueItemId, state.musicGeneration];
      })
      .toEqual([duplicateIds[1], oldGeneration + 1]);
    await expect
      .poll(async () => {
        const state = await musicStore(viewer2!);
        return [state.currentQueueItemId, state.musicGeneration];
      })
      .toEqual([duplicateIds[1], oldGeneration + 1]);
    await expect
      .poll(async () =>
        host.evaluate(
          (generation) =>
            (
              window as unknown as { __phase5bAcks: unknown[] }
            ).__phase5bAcks.filter((value) => {
              const ack = value as {
                musicGeneration?: unknown;
                ready?: unknown;
              };
              return ack.musicGeneration === generation && ack.ready === true;
            }).length,
          oldGeneration + 1,
        ),
      )
      .toBeGreaterThanOrEqual(2);

    const staleEnded = await emitMusic(host, "music:ended", {
      roomId,
      queueItemId: oldQueueItemId,
      musicGeneration: oldGeneration,
      baseVersion: oldVersion,
      mutationId: `e2e-stale-ended-${Date.now()}`,
    });
    expect((staleEnded as { success?: boolean; code?: string }).success).toBe(
      false,
    );
    expect((staleEnded as { code?: string }).code).toBe("STALE_GENERATION");
    expect((await musicStore(viewer)).currentQueueItemId).toBe(duplicateIds[1]);

    await viewer2.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = (
            window as unknown as {
              __debugSocket: {
                connected: boolean;
                once: (event: string, listener: () => void) => void;
                disconnect: () => void;
                connect: () => void;
              };
            }
          ).__debugSocket;
          const timeout = window.setTimeout(
            () => reject(new Error("music socket reconnect timeout")),
            10_000,
          );
          socket.once("connect", () => {
            window.clearTimeout(timeout);
            resolve();
          });
          socket.disconnect();
          window.setTimeout(() => socket.connect(), 100);
        }),
    );
    await expect
      .poll(async () => (await musicStore(viewer2!)).queueLength)
      .toBe(2);
    await expect
      .poll(async () => (await musicStore(viewer2!)).currentQueueItemId)
      .toBe(duplicateIds[1]);

    const range = await host.request.get("/api/music/fixture/blue-hour", {
      headers: { Range: "bytes=0-3" },
    });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toMatch(/^bytes 0-3\//);
  } finally {
    if (viewer) await viewer.close();
    if (viewerContext) await viewerContext.close();
    if (viewer2) await viewer2.close();
    if (viewerContext2) await viewerContext2.close();
    await host
      .evaluate(async () => {
        const { apiFetch } = await import("/src/lib/api.ts");
        await apiFetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoDeleteInactiveRooms: true,
            autoDeleteAfterHours: 24,
            registrationMode: "approval",
            roomCreationMode: "admin-only",
          }),
        });
      })
      .catch(() => undefined);
    await host.close();
  }
});
