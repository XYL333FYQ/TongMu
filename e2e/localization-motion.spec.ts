import { expect, test, type Locator, type Page } from "@playwright/test";
import { configureGeneratedMedia } from "./helpers/generated-media";

const fixtureOrigin = "http://127.0.0.1:3456";
const languageLabel = "Language / 语言";

type Motion = {
  name: string;
  duration: string;
  easing: string;
  children: { name: string; duration: string; delay: string }[];
};

async function chooseEnglish(page: Page) {
  await expect(
    page.getByRole("heading", { name: "房间大厅", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: languageLabel, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Room hall", exact: true }),
  ).toBeVisible();
}

async function loginRoot(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("你的用户名", { exact: true }).fill("root");
  await page.getByPlaceholder("你的密码", { exact: true }).fill("root");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).__debugSocket?.connected)),
    )
    .toBe(true);
  await chooseEnglish(page);
}

async function roomState(page: Page) {
  return page.evaluate(async () => {
    // @ts-ignore Import the development app's actual state, not a test double.
    const { useRoomStore } = await import("/src/store/roomStore.ts");
    // @ts-ignore The room snapshot is maintained by real Socket.IO events.
    const { useRoomExperienceStore } =
      await import("/src/store/roomExperienceStore.ts");
    const state = useRoomStore.getState();
    return {
      activeRoomId: state.activeRoomId,
      sourceUrl: state.watchTogether.sourceUrl,
      snapshot: useRoomExperienceStore.getState().snapshot,
      hostMarker: sessionStorage.getItem("zcontrol-host-room"),
    };
  });
}

async function motionOf(menu: Locator): Promise<Motion> {
  return menu.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      easing: style.animationTimingFunction,
      children: [...element.querySelectorAll(".zen-dropdown-item")].map(
        (child) => {
          const style = getComputedStyle(child);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            delay: style.animationDelay,
          };
        },
      ),
    };
  });
}

function expectStagger(motion: Motion) {
  expect(motion.children.length).toBeGreaterThan(1);
  for (const [index, child] of motion.children.entries()) {
    expect(child.name).toBe("zen-dropdown-item-enter");
    expect(child.duration).toBe(motion.duration);
    if (index === 0) expect(parseFloat(child.delay)).toBe(0);
    else
      expect(parseFloat(child.delay)).toBeGreaterThan(
        parseFloat(motion.children[index - 1].delay),
      );
  }
}

async function escapeMenu(
  page: Page,
  menu: Locator,
  trigger: Locator,
  observeExit = false,
) {
  const retained = await menu.elementHandle();
  expect(retained).not.toBeNull();
  if (observeExit) {
    // Observe the real exit animation before the menu unmounts. An event is
    // reliable even when a slow engine misses a brief CSS-class snapshot.
    await menu.evaluate((element) => {
      element.addEventListener("animationstart", (event) => {
        const animation = event as AnimationEvent;
        if (
          event.target !== element ||
          animation.animationName !== "zen-dropdown-exit"
        )
          return;
        const style = getComputedStyle(element);
        (
          element as HTMLElement & { __exitMotion?: Omit<Motion, "children"> }
        ).__exitMotion = {
          name: style.animationName,
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
        };
      });
    });
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const exit = observeExit
    ? await retained!.evaluate(
        (element) =>
          (element as HTMLElement & { __exitMotion?: Omit<Motion, "children"> })
            .__exitMotion ?? null,
      )
    : null;
  await retained!.dispose();
  if (observeExit) expect(exit?.name).toBe("zen-dropdown-exit");
  return exit;
}

test.describe("localized UI and shared disclosure motion", () => {
  // Legacy regressions deliberately start in English. These tests must prove
  // the production default instead of inheriting that fixture preference.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async ({ browser, browserName }) => {
    if (browserName !== "chromium") return;
    const recorder = await browser.newPage();
    try {
      await configureGeneratedMedia(recorder);
    } finally {
      await recorder.close();
    }
  });

  test("default Chinese, immediate English, persisted preference and unchanged login inputs", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("TongMu");
    const brand = page.getByRole("button", {
      name: "TongMu 大厅",
      exact: true,
    });
    await expect(brand).toHaveText("TongMu");
    await expect(
      page.getByRole("img", { name: "TongMu", exact: true }),
    ).toBeVisible();
    await chooseEnglish(page);
    await expect(
      page.getByRole("button", { name: "Join by ID", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("tongmu-locale")),
    ).toBe("en");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Room hall", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle("TongMu");

    await page.goto("/login");
    await page
      .getByPlaceholder("Your username", { exact: true })
      .fill("朋友 Alice");
    await page
      .getByPlaceholder("Your password", { exact: true })
      .fill("unchanged-password-42");
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "欢迎来到 TongMu", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("你的用户名", { exact: true }),
    ).toHaveValue("朋友 Alice");
    await expect(
      page.getByPlaceholder("你的密码", { exact: true }),
    ).toHaveValue("unchanged-password-42");
    await expect(
      page.getByPlaceholder("你的密码", { exact: true }),
    ).toHaveAttribute("type", "password");
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(
      page.getByPlaceholder("Your username", { exact: true }),
    ).toHaveValue("朋友 Alice");
    await expect(
      page.getByPlaceholder("Your password", { exact: true }),
    ).toHaveValue("unchanged-password-42");
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "欢迎来到 TongMu", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("tongmu-locale")),
    ).toBe("zh");
    await expect(page).toHaveTitle("TongMu");
  });

  test("language changes keep picker drafts, real playback and the room session until explicit exit", async ({
    page,
  }) => {
    await loginRoot(page);
    const roomName = "朋友 Alice · Locale continuity";
    await page
      .getByRole("button", { name: "Create room", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Room name", exact: true })
      .fill(roomName);
    await page
      .getByRole("button", { name: "Create room", exact: true })
      .click();
    await expect(page).toHaveURL(/\/room\/[^/]+$/);
    const roomId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(
      page.getByRole("button", { name: "Watch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await roomState(page)).activeRoomId)
      .toBe(roomId);
    await page
      .getByRole("button", { name: "Choose content", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Choose content",
      exact: true,
    });
    const draftUrl = `${fixtureOrigin}/normal.mp4?locale-session=recorded`;
    const input = picker.getByPlaceholder(
      "Paste a video, playlist or webpage URL",
      { exact: true },
    );
    await input.fill(draftUrl);
    await picker
      .getByRole("radio", { name: "Play the first selection now", exact: true })
      .check();
    const retainedInput = await input.elementHandle();
    expect(retainedInput).not.toBeNull();
    await picker
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    const chinesePicker = page.getByRole("dialog", {
      name: "选择内容",
      exact: true,
    });
    await expect(chinesePicker).toBeVisible();
    expect(
      await retainedInput!.evaluate((input: HTMLInputElement) => ({
        connected: input.isConnected,
        value: input.value,
      })),
    ).toEqual({ connected: true, value: draftUrl });
    await expect(
      chinesePicker.getByRole("radio", {
        name: "立即播放第一个所选内容",
        exact: true,
      }),
    ).toBeChecked();
    await chinesePicker
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(input).toHaveValue(draftUrl);
    expect(
      await input.evaluate(
        (input, original) => input === original,
        retainedInput,
      ),
    ).toBe(true);
    await retainedInput!.dispose();
    await picker.getByRole("button", { name: "Resolve", exact: true }).click();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .first()
            .evaluate((video: HTMLVideoElement) => video.currentTime),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await picker
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(picker).toHaveCount(0);

    const retainedVideo = await page.locator("video").first().elementHandle();
    expect(retainedVideo).not.toBeNull();
    // The generated clip is short. Loop it to observe continued real decoding
    // throughout interaction without replacing the source or seeking manually.
    await retainedVideo!.evaluate((video: HTMLVideoElement) => {
      video.loop = true;
    });
    const retainedSocket = await page.evaluateHandle(
      () => (window as any).__debugSocket,
    );
    const socketId = await page.evaluate(
      () => (window as any).__debugSocket.id,
    );
    const documentBefore = await page.evaluateHandle(() => document);
    const checkSession = async () => {
      expect(
        await page.evaluate(
          (socket) => (window as any).__debugSocket === socket,
          retainedSocket,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => (window as any).__debugSocket.id)).toBe(
        socketId,
      );
      expect(
        await retainedVideo!.evaluate(
          (video: HTMLVideoElement) => video.isConnected,
        ),
      ).toBe(true);
      expect((await roomState(page)).activeRoomId).toBe(roomId);
      await expect
        .poll(() =>
          retainedVideo!.evaluate((video: HTMLVideoElement) => video.paused),
        )
        .toBe(false);
      const position = await retainedVideo!.evaluate(
        (video: HTMLVideoElement) => video.currentTime,
      );
      await expect
        .poll(() =>
          retainedVideo!.evaluate(
            (video: HTMLVideoElement) => video.currentTime,
          ),
        )
        .not.toBe(position);
    };
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "一起看", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".tm-room-title strong")).toHaveText(roomName);
    await checkSession();
    await page.getByRole("button", { name: "大厅", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("complementary", { name: "当前房间", exact: true }),
    ).toBeVisible();
    await checkSession();
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Room hall", exact: true }),
    ).toBeVisible();
    await checkSession();
    await page
      .getByRole("button", { name: "Return to room", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`));
    expect(
      await page
        .locator("video")
        .first()
        .evaluate((video, original) => video === original, retainedVideo),
    ).toBe(true);
    await expect(page.locator(".tm-room-title strong")).toHaveText(roomName);
    await checkSession();
    await page.getByRole("button", { name: "Leave room", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(() =>
        retainedVideo!.evaluate((video: HTMLVideoElement) => ({
          connected: video.isConnected,
          paused: video.paused,
          src: video.getAttribute("src"),
          sourceObjectCleared: video.srcObject === null,
        })),
      )
      .toEqual({
        connected: false,
        paused: true,
        src: null,
        sourceObjectCleared: true,
      });
    await expect
      .poll(() => roomState(page))
      .toMatchObject({
        activeRoomId: null,
        sourceUrl: "",
        snapshot: null,
        hostMarker: null,
      });
    await expect(
      page.getByRole("complementary", { name: "Active room", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate((original) => document === original, documentBefore),
    ).toBe(true);
    await page
      .getByRole("button", { name: languageLabel, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "房间大厅", exact: true }),
    ).toBeVisible();
    expect((await roomState(page)).activeRoomId).toBeNull();
    expect(
      await retainedVideo!.evaluate(
        (video: HTMLVideoElement) => video.isConnected,
      ),
    ).toBe(false);
    await retainedVideo!.dispose();
    await retainedSocket.dispose();
    await documentBefore.dispose();
  });

  test("account and appearance menus share enter, stagger and exit motion with keyboard and reduced-motion support", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await loginRoot(page);
    const accountTrigger = page.getByRole("button", {
      name: "Account menu",
      exact: true,
    });
    const account = page.getByRole("dialog", {
      name: "Account menu",
      exact: true,
    });
    const appearanceTrigger = page.getByRole("button", {
      name: "Appearance",
      exact: true,
    });
    const appearance = page.getByRole("dialog", {
      name: "Appearance",
      exact: true,
    });
    await accountTrigger.click();
    await expect(account).toBeVisible();
    const accountMotion = await motionOf(account);
    expect(accountMotion.name).toBe("zen-dropdown-enter");
    expect(parseFloat(accountMotion.duration)).toBeGreaterThan(0.001);
    expectStagger(accountMotion);
    await account
      .getByRole("button", { name: "Your account", exact: true })
      .focus();
    const accountExit = await escapeMenu(page, account, accountTrigger, true);
    await appearanceTrigger.click();
    await expect(appearance).toBeVisible();
    const appearanceMotion = await motionOf(appearance);
    expect({
      name: appearanceMotion.name,
      duration: appearanceMotion.duration,
      easing: appearanceMotion.easing,
    }).toEqual({
      name: accountMotion.name,
      duration: accountMotion.duration,
      easing: accountMotion.easing,
    });
    expectStagger(appearanceMotion);
    await appearance
      .getByRole("button", { name: /^(Dark|Light)$/, exact: true })
      .focus();
    const appearanceExit = await escapeMenu(
      page,
      appearance,
      appearanceTrigger,
      true,
    );
    expect(appearanceExit).toEqual(accountExit);

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    for (const [trigger, menu] of [
      [accountTrigger, account],
      [appearanceTrigger, appearance],
    ]) {
      await trigger.click();
      await expect(menu).toBeVisible();
      const reduced = await motionOf(menu);
      expect(parseFloat(reduced.duration)).toBeLessThanOrEqual(0.001);
      for (const child of reduced.children) {
        expect(parseFloat(child.duration)).toBeLessThanOrEqual(0.001);
        expect(parseFloat(child.delay)).toBe(0);
      }
      await escapeMenu(page, menu, trigger);
    }

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await appearanceTrigger.click();
    const reduceMotion = appearance.getByRole("checkbox", {
      name: "Reduce motion",
      exact: true,
    });
    await expect(reduceMotion).not.toBeChecked();
    await reduceMotion.focus();
    await page.keyboard.press("Space");
    await expect(reduceMotion).toBeChecked();
    await expect(page.locator("body")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    const preference = await motionOf(appearance);
    expect(parseFloat(preference.duration)).toBeLessThan(
      parseFloat(appearanceMotion.duration),
    );
    for (const child of preference.children)
      expect(parseFloat(child.delay)).toBe(0);
    await escapeMenu(page, appearance, appearanceTrigger);
    await page.reload();
    await appearanceTrigger.click();
    await expect(
      appearance.getByRole("checkbox", { name: "Reduce motion", exact: true }),
    ).toBeChecked();
    await expect(page.locator("body")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    await escapeMenu(page, appearance, appearanceTrigger);
  });
});
