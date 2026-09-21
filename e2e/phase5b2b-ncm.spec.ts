import { expect, test, type Page } from "@playwright/test";

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
  const result = await host.evaluate(
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
  if (!result.success || !result.data?.roomId)
    throw new Error("create-room failed");
  await host.evaluate(
    (roomId) => sessionStorage.setItem("zcontrol-host-room", roomId),
    result.data.roomId,
  );
  await host.goto(`/room/${result.data.roomId}`);
  return result.data.roomId;
}

async function musicState(
  page: Page,
): Promise<{ sourceRef: string | null; queueLength: number }> {
  return page.evaluate(async () => {
    const { useMusicStore } = await import("/src/modules/music/store.ts");
    const state = useMusicStore.getState();
    return {
      sourceRef: state.currentSourceRef,
      queueLength: state.queue.length,
    };
  });
}

test("Phase 5B-2B NCM catalog, stable queue add, lyrics/comments, private library, and narrow layout work in Chromium", async ({
  browser,
}) => {
  const page = await browser.newPage();
  const username = `phase5b2b_${Date.now()}`;
  try {
    await login(page, "root", "root");
    const settings = await page.evaluate(async () => {
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
    const registration = await page.request.post("/api/auth/register", {
      data: { username, password: "phase5b2b-pass" },
    });
    expect(registration.ok()).toBe(true);
    const roomId = await createRoom(page);
    const panel = page
      .locator(".glass-card")
      .filter({ has: page.getByRole("heading", { name: "一起听" }) });

    // The Chromium project reuses one backend for the serial suite, so the
    // root user may already have the fixture credential from the 5B-2A test.
    const ncmStatus = panel.getByTestId("ncm-status");
    await expect
      .poll(async () => (await ncmStatus.textContent()) || "")
      .toMatch(/网易云：(?:未登录|已登录)/);
    const resolvedNcmStatus = (await ncmStatus.textContent()) || "";
    if (resolvedNcmStatus.includes("未登录")) {
      await expect(
        panel.getByRole("button", { name: "扫码登录", exact: true }),
      ).toBeEnabled();
      await panel
        .getByRole("button", { name: "扫码登录", exact: true })
        .click();
      await expect(panel.getByAltText("网易云登录二维码")).toBeVisible();
      await expect(ncmStatus).toContainText("网易云：已登录", {
        timeout: 15_000,
      });
    } else {
      await expect(ncmStatus).toContainText("网易云：已登录");
      await expect(
        panel.getByRole("button", { name: "退出", exact: true }),
      ).toBeVisible();
    }

    const search = panel.getByRole("textbox", { name: "音乐目录搜索" });
    await search.fill("fixture");
    await expect(
      panel.getByText("Catalog Fixture Song", { exact: true }),
    ).toBeVisible();
    const quality = panel.getByRole("combobox", {
      name: "Catalog Fixture Song 音质",
    });
    await expect(quality).toHaveValue("exhigh");
    await quality.selectOption("standard");
    await panel
      .getByRole("button", { name: "添加 Catalog Fixture Song 到队列" })
      .click();
    await expect
      .poll(async () => (await musicState(page)).sourceRef)
      .toBe("music://ncm/track/7001");
    await expect.poll(async () => (await musicState(page)).queueLength).toBe(1);

    await panel
      .getByRole("button", { name: "查看 Catalog Fixture Song 歌词" })
      .click();
    await expect(panel.getByText("原文第一行", { exact: true })).toBeVisible();
    await expect(
      panel.getByText("Translated line", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "查看 Catalog Fixture Song 评论" })
      .click();
    await expect(
      panel.getByText("<b>text-only fixture</b>", { exact: true }),
    ).toBeVisible();

    const searchType = panel.getByRole("combobox", {
      name: "音乐目录类型",
    });
    await searchType.selectOption("playlist");
    await expect(
      panel.getByRole("button", { name: /NCM Fixture Playlist/ }),
    ).toBeVisible();
    await panel.getByRole("button", { name: /NCM Fixture Playlist/ }).click();
    await expect(
      panel.getByText("NCM Catalog 7001", { exact: true }).first(),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "添加 NCM Catalog 7001 到队列" })
      .first()
      .click();
    await expect.poll(async () => (await musicState(page)).queueLength).toBe(2);
    await panel.getByRole("button", { name: "返回", exact: true }).click();

    await searchType.selectOption("album");
    await expect(panel.getByRole("button", { name: /打开专辑/ })).toBeVisible();
    await panel.getByRole("button", { name: /打开专辑/ }).click();
    await expect(
      panel.getByText("NCM Catalog 7001", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "返回", exact: true }).click();

    await searchType.selectOption("artist");
    await expect(panel.getByRole("button", { name: /打开歌手/ })).toBeVisible();
    await panel.getByRole("button", { name: /打开歌手/ }).click();
    await expect(
      panel.getByText("NCM Catalog 7001", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "返回", exact: true }).click();

    await panel.getByRole("tab", { name: "我喜欢" }).click();
    await expect(
      panel.getByText("NCM Catalog 7001", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("tab", { name: "私人 FM" }).click();
    await expect(
      panel.getByText("Private FM Fixture", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "添加 Private FM Fixture 到队列" })
      .click();
    await expect.poll(async () => (await musicState(page)).queueLength).toBe(3);
    await panel.getByRole("tab", { name: "云盘" }).click();
    await expect(
      panel.getByText("Cloud Fixture", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "添加 Cloud Fixture 到队列" })
      .click();
    await expect.poll(async () => (await musicState(page)).queueLength).toBe(4);

    await panel.getByRole("button", { name: "退出", exact: true }).click();
    await expect(ncmStatus).toContainText("网易云：未登录");
    await expect(
      panel.getByText("Cloud Fixture", { exact: true }),
    ).not.toBeVisible();

    // Switch the application account in the same browser context. The new
    // account must not inherit the old account's private catalog state.
    await page.goto("/login");
    await login(page, username, "phase5b2b-pass");
    await page.goto(`/room/${roomId}`);
    const switchedPanel = page
      .locator(".glass-card")
      .filter({ has: page.getByRole("heading", { name: "一起听" }) });
    await switchedPanel.getByRole("tab", { name: "云盘" }).click();
    await expect(
      switchedPanel.getByText("Cloud Fixture", { exact: true }),
    ).not.toBeVisible();
    await expect(
      switchedPanel.getByText(/请先在上方扫码登录网易云音乐/),
    ).toBeVisible();

    await page.setViewportSize({ width: 320, height: 760 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(overflow).toBe(true);
  } finally {
    await page.close();
  }
});
