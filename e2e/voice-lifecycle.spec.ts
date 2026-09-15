import { expect, test } from "@playwright/test";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test("Voice fake-media join, socket replacement, and unmount release resources", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const storageKey = "__voice_resource_stats";
    let stored: { streams: number; stoppedTracks: number } = {
      streams: 0,
      stoppedTracks: 0,
    };
    try {
      stored = JSON.parse(
        localStorage.getItem(storageKey) ?? JSON.stringify(stored),
      );
    } catch {
      // use a fresh in-memory counter
    }
    const stats = {
      streams: stored.streams ?? 0,
      stoppedTracks: stored.stoppedTracks ?? 0,
    };
    const persist = () =>
      localStorage.setItem(storageKey, JSON.stringify(stats));
    Object.defineProperty(window, "__voiceResourceStats", {
      value: stats,
      configurable: true,
    });
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) return;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);
        stats.streams += 1;
        persist();
        stream.getTracks().forEach((track) => {
          const stop = track.stop.bind(track);
          Object.defineProperty(track, "stop", {
            configurable: true,
            value: () => {
              stats.stoppedTracks += 1;
              persist();
              stop();
            },
          });
        });
        return stream;
      },
    });
  });

  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill("root");
  await page.getByPlaceholder("请输入密码").fill("root");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始共享", exact: true }).click();
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(page).toHaveURL(/\/room\//);

  await page.getByTitle("语音聊天").click();
  await page.getByRole("button", { name: "加入语音", exact: true }).click();
  await expect(page.getByText("1 人在线", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { streams: number };
            }
          ).__voiceResourceStats.streams,
      ),
    )
    .toBe(1);

  const oldSocketId = await page.evaluate(() => {
    const socket = (
      window as unknown as {
        __debugSocket?: {
          id?: string;
          disconnect: () => void;
          connect: () => void;
        };
      }
    ).__debugSocket;
    if (!socket?.id) throw new Error("debug socket unavailable");
    const id = socket.id;
    socket.disconnect();
    setTimeout(() => socket.connect(), 100);
    return id;
  });
  await expect
    .poll(
      () =>
        page.evaluate((previousSocketId) => {
          const socket = (
            window as unknown as {
              __debugSocket?: { id?: string; connected?: boolean };
            }
          ).__debugSocket;
          return socket?.connected && socket.id !== previousSocketId
            ? (socket.id ?? "")
            : "";
        }, oldSocketId),
      { timeout: 20_000 },
    )
    .toMatch(/.+/);
  await expect(page.getByText("1 人在线", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { streams: number; stoppedTracks: number };
            }
          ).__voiceResourceStats,
      ),
    )
    .toEqual({ streams: 2, stoppedTracks: 1 });

  await page.getByRole("button", { name: "断开", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { stoppedTracks: number };
            }
          ).__voiceResourceStats.stoppedTracks,
      ),
    )
    .toBe(2);

  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceResourceStats: { stoppedTracks: number };
            }
          ).__voiceResourceStats.stoppedTracks,
      ),
    )
    .toBe(2);
});
