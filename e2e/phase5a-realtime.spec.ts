import { expect, test, type Browser, type Page } from "@playwright/test";

async function loginAndCreateRoom(
  page: Page,
  credentials: { username: string; password: string } = { username: "root", password: "root" },
): Promise<string> {
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill(credentials.username);
  await page.getByPlaceholder("请输入密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  const room = await page.evaluate(() => new Promise<{ success?: boolean; data?: { roomId?: string } }>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("create-room", { mode: "watch-together", requireApproval: false }, resolve);
  }));
  if (!room.success || !room.data?.roomId) throw new Error("create-room failed");
  await page.evaluate((roomId) => sessionStorage.setItem("zcontrol-host-room", roomId), room.data.roomId);
  await page.goto(`/room/${room.data.roomId}`);
  await expect(page).toHaveURL(/\/room\/[^/]+$/);
  return room.data.roomId;
}

async function waitForSocket(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __debugSocket?: { connected?: boolean } }).__debugSocket?.connected))).toBe(true);
}

async function createOpenRegistrationUser(browser: Browser, page: Page): Promise<{ username: string; password: string }> {
  await page.evaluate(async () => {
    // @ts-ignore Vite serves application modules for the browser integration test.
    const { apiFetch } = await import("/src/lib/api.ts");
    const response = await apiFetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autoDeleteInactiveRooms: true,
        autoDeleteAfterHours: 24,
        registrationMode: "open",
        roomCreationMode: "all-users",
      }),
    });
    if (!response.ok) throw new Error("failed to enable test registration");
  });
  const username = `phase5a_${Date.now()}`;
  const password = "phase5a-pass";
  const registrationContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const response = await registrationContext.request.post("/api/auth/register", {
      data: { username, password },
    });
    if (!response.ok()) throw new Error(`test user registration failed: ${response.status()}`);
  } finally {
    await registrationContext.close();
  }
  return { username, password };
}

async function restoreRegistrationMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-ignore Vite serves application modules for the browser integration test.
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
  });
}

function state(sourceUrl: string, sourceGeneration: number) {
  return {
    sourceUrl,
    sourceType: "url",
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1,
    duration: 1,
    sourceGeneration,
  };
}

test("Phase 5A realtime snapshot, ordering, source generation, and reconnect", async ({
  browser,
}) => {
  const setup = await browser.newPage();
  await setup.goto("/login");
  await setup.getByPlaceholder("请输入用户名").fill("root");
  await setup.getByPlaceholder("请输入密码").fill("root");
  await setup.getByRole("button", { name: "登录", exact: true }).click();
  await expect(setup).toHaveURL(/\/$/);
  const ownerCredentials = await createOpenRegistrationUser(browser, setup);
  const newHostCredentials = await createOpenRegistrationUser(browser, setup);

  const host = await browser.newPage();
  const roomId = await loginAndCreateRoom(host, ownerCredentials);
  await waitForSocket(host);

  const viewer = await browser.newPage();
  await viewer.goto(`/room/${roomId}`);
  await waitForSocket(viewer);
  // watch-together with requireApproval=false joins automatically. Give the
  // join handler a bounded opportunity to create the viewer session.
  await viewer.waitForTimeout(1_000);

  const sourceA = "http://127.0.0.1:3456/video.mp4";
  const firstAck = await host.evaluate(({ roomId, payload }) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("watch-together-state", { roomId, state: payload, clientTimestamp: Date.now() }, resolve);
  }), { roomId, payload: state(sourceA, 1) });
  expect((firstAck as { success?: boolean }).success).toBe(true);

  await expect.poll(() => viewer.evaluate(async () => {
    const { useRoomStore } = await import("/src/store/roomStore.ts");
    return useRoomStore.getState().watchTogether.version ?? 0;
  })).toBe(1);

  const secondAck = await host.evaluate(({ roomId, payload }) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("watch-together-state", {
      roomId,
      state: payload,
      baseVersion: 1,
      sourceGeneration: 2,
      mutationId: "phase5a-source-b",
      clientTimestamp: Date.now(),
    }, resolve);
  }), { roomId, payload: state("http://127.0.0.1:3456/video-b.mp4", 2) });
  expect((secondAck as { success?: boolean }).success).toBe(true);

  await expect.poll(() => viewer.evaluate(async () => {
    const { useRoomStore } = await import("/src/store/roomStore.ts");
    const current = useRoomStore.getState().watchTogether;
    return { version: current.version, sourceGeneration: current.sourceGeneration, sourceUrl: current.sourceUrl };
  })).toEqual({ version: 2, sourceGeneration: 2, sourceUrl: "http://127.0.0.1:3456/video-b.mp4" });

  // Directly invoke the registered consumer callbacks to model reordered
  // delivery. The lower version and the old generation must not win.
  const finalAuthority = await viewer.evaluate(async () => {
    const socket = (window as unknown as { __debugSocket: { listeners: (name: string) => Function[] } }).__debugSocket;
    const dispatch = (version: number, sourceGeneration: number, sourceUrl: string) => {
      for (const listener of socket.listeners("watch-together-state")) {
        listener({ version, sourceGeneration, state: { ...((window as unknown as { __lastPhase5State?: object }).__lastPhase5State ?? {
          sourceType: "url", isPlaying: false, currentTime: 0, playbackRate: 1, duration: 1,
        }), sourceUrl, sourceGeneration, version } });
      }
    };
    dispatch(12, 2, "http://127.0.0.1:3456/video-v12.mp4");
    dispatch(11, 2, "http://127.0.0.1:3456/video-v11.mp4");
    dispatch(99, 1, "http://127.0.0.1:3456/video-old.mp4");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { useRoomStore } = await import("/src/store/roomStore.ts");
    const current = useRoomStore.getState().watchTogether;
    return { version: current.version, sourceGeneration: current.sourceGeneration, sourceUrl: current.sourceUrl };
  });
  expect(finalAuthority).toEqual({ version: 12, sourceGeneration: 2, sourceUrl: "http://127.0.0.1:3456/video-v12.mp4" });

  const staleAck = await host.evaluate(({ roomId, payload }) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("watch-together-control", {
      roomId,
      action: "seek",
      value: 0,
      baseVersion: 1,
      sourceGeneration: 1,
      clientTimestamp: Date.now(),
    }, resolve);
  }), { roomId, payload: null });
  expect((staleAck as { success?: boolean; code?: string }).success).toBe(false);

  const newHost = await browser.newPage();
  await newHost.goto("/login");
  await newHost.getByPlaceholder("请输入用户名").fill(newHostCredentials.username);
  await newHost.getByPlaceholder("请输入密码").fill(newHostCredentials.password);
  await newHost.getByRole("button", { name: "登录", exact: true }).click();
  await expect(newHost).toHaveURL(/\/$/);
  await newHost.goto(`/room/${roomId}`);
  await waitForSocket(newHost);
  await newHost.waitForTimeout(1_000);
  const newHostSocketId = await newHost.evaluate(() => (window as unknown as { __debugSocket: { id: string } }).__debugSocket.id);

  const transferAck = await host.evaluate(({ roomId, viewerSocketId }) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("transfer-host", { roomId, viewerSocketId }, resolve);
  }), { roomId, viewerSocketId: newHostSocketId });
  expect((transferAck as { success?: boolean }).success).toBe(true);

  const oldHostAck = await host.evaluate((roomId) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("watch-together-control", {
      roomId,
      action: "pause",
      baseVersion: 2,
      sourceGeneration: 2,
      mutationId: "phase5a-old-host-late-command",
      clientTimestamp: Date.now(),
    }, resolve);
  }), roomId);
  expect((oldHostAck as { success?: boolean; code?: string }).success).toBe(false);

  const newHostAck = await newHost.evaluate((roomId) => new Promise<unknown>((resolve) => {
    const socket = (window as unknown as { __debugSocket: { emit: Function } }).__debugSocket;
    socket.emit("watch-together-control", {
      roomId,
      action: "pause",
      baseVersion: 2,
      sourceGeneration: 2,
      mutationId: "phase5a-new-host-command",
      clientTimestamp: Date.now(),
    }, resolve);
  }), roomId);
  expect((newHostAck as { success?: boolean }).success).toBe(true);

  await restoreRegistrationMode(setup);
  await newHost.close();

  await viewer.evaluate(() => {
    const socket = (window as unknown as { __debugSocket: { disconnect: () => void; connect: () => void } }).__debugSocket;
    socket.disconnect();
    setTimeout(() => socket.connect(), 100);
  });
  await waitForSocket(viewer);
  await viewer.waitForTimeout(1_000);
  const afterReconnect = await viewer.evaluate(async () => {
    const { useRoomStore } = await import("/src/store/roomStore.ts");
    const current = useRoomStore.getState().watchTogether;
    return { version: current.version, sourceGeneration: current.sourceGeneration };
  });
  expect(afterReconnect).toEqual({ version: 12, sourceGeneration: 2 });

  await viewer.close();
  await host.close();
  await setup.close();
});
