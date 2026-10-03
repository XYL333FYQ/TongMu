import { configureGeneratedMedia } from "./helpers/generated-media";
import { expect, test, type Browser, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:3456";
test.setTimeout(60000);

test.beforeAll(async ({ browser, browserName }) => {
  if (browserName !== "chromium") return;
  const page = await browser.newPage();
  try {
    await configureGeneratedMedia(page);
  } finally {
    await page.close();
  }
});

async function login(page: Page, username = "root", password = "root") {
  await page.goto("/login");
  await page.getByPlaceholder("Your username").fill(username);
  await page.getByPlaceholder("Your password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).__debugSocket?.connected)),
    )
    .toBe(true);
}

async function createRoom(
  page: Page,
  name: string,
  options: {
    private?: boolean;
    fixed?: boolean;
    shared?: boolean;
    password?: string;
    approval?: boolean;
    limit?: number;
    guests?: boolean;
  } = {},
) {
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Room name", exact: true })
    .fill(name);
  if (options.private)
    await page.getByRole("button", { name: /^Private/ }).click();
  if (options.fixed) await page.getByRole("button", { name: /^Fixed/ }).click();
  if (options.shared)
    await page.getByRole("button", { name: /^Together/ }).click();
  if (options.guests === false) {
    await page.getByText("Allow guests", { exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Allow guests", exact: true }),
    ).not.toBeChecked();
  }
  if (options.password || options.approval || options.limit) {
    await page
      .getByRole("button", { name: "Joining rules & permissions", exact: true })
      .click();
    if (options.password)
      await page
        .getByLabel("Password (optional)", { exact: true })
        .fill(options.password);
    if (options.approval) {
      await page
        .getByText("Ask the host to approve new members", { exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", {
          name: "Ask the host to approve new members",
          exact: true,
        }),
      ).toBeChecked();
    }
    if (options.limit)
      await page
        .getByRole("spinbutton", { name: "Member limit", exact: true })
        .fill(String(options.limit));
  }
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/room\/[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(
    page.getByRole("button", { name: "Watch", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  return id;
}

async function newGuest(
  browser: Browser,
  roomId: string,
  nickname: string,
  password = "",
) {
  const page = await browser.newPage();
  await page.goto(`/room/${roomId}`);
  await page
    .getByRole("textbox", { name: "Your nickname", exact: true })
    .fill(nickname);
  if (password)
    await page
      .getByLabel("Password (if required)", { exact: true })
      .fill(password);
  await page.getByRole("button", { name: /^(Join room|Try again)$/ }).click();
  return page;
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    // @ts-ignore The development server exposes the same modules the UI consumes.
    const { useRoomExperienceStore } =
      await import("/src/store/roomExperienceStore.ts");
    return useRoomExperienceStore.getState().snapshot;
  });
}

async function openContent(page: Page) {
  await page
    .getByRole("button", { name: "Choose content", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Choose content", exact: true });
}

test("private fixed room stays out of discovery and guest retry keeps the nickname", async ({
  browser,
}) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();
  try {
    await login(host);
    const roomId = await createRoom(host, "Private invitation room", {
      private: true,
      fixed: true,
      password: "correct-secret",
    });
    const settingsTrigger = host.getByRole("button", {
      name: "Room settings",
      exact: true,
    });
    await settingsTrigger.click();
    const settings = host.getByRole("dialog", {
      name: "Room settings",
      exact: true,
    });
    const nameField = settings.getByRole("textbox", {
      name: "Room name",
      exact: true,
    });
    await expect(nameField).toHaveValue("Private invitation room");
    await nameField.fill("");
    await settings
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toContainText(
      "Enter a room name.",
    );
    await nameField.fill("Private invitation room");
    await settings
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    await expect(settingsTrigger).toBeFocused();
    await host.getByRole("button", { name: "Hall", exact: true }).click();
    await expect(
      host.getByRole("complementary", { name: "Active room" }),
    ).toBeVisible();
    await host
      .getByRole("button", { name: "Return to room", exact: true })
      .click();
    await expect(host).toHaveURL(new RegExp(`/room/${roomId}$`));
    await guest.goto("/");
    await guest.getByRole("textbox", { name: "Search rooms" }).fill(roomId);
    await expect(
      guest.getByRole("heading", { name: "No matching rooms" }),
    ).toBeVisible();
    expect(await guest.locator(".tm-room-card").count()).toBe(0);

    await guest.goto(`/room/${roomId}`);
    const nickname = guest.getByRole("textbox", {
      name: "Your nickname",
      exact: true,
    });
    await nickname.fill("River guest");
    await guest
      .getByLabel("Password (if required)", { exact: true })
      .fill("incorrect-secret");
    await guest.getByRole("button", { name: "Join room", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText("Incorrect password");
    await expect(nickname).toHaveValue("River guest");
    await guest
      .getByLabel("Password (if required)", { exact: true })
      .fill("correct-secret");
    await guest.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      guest.getByRole("button", { name: "Watch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await snapshot(guest))?.policy?.lifetime)
      .toBe("persistent");
    await expect
      .poll(async () => (await snapshot(guest))?.permissions?.settings)
      .toBe(false);
    await guest.getByRole("tab", { name: "Members", exact: true }).click();
    await expect(
      guest.getByText("River guest (you)", { exact: true }),
    ).toBeVisible();
    await guest
      .getByRole("button", { name: "Leave room", exact: true })
      .click();
    await expect(guest).toHaveURL(/\/$/);
    await guest.goto(`/room/${roomId}`);
    await expect(
      guest.getByRole("textbox", { name: "Your nickname", exact: true }),
    ).toHaveValue("River guest");
  } finally {
    await guest.close();
    await host.close();
  }
});

test("approval, full capacity and cancellation give a clear recoverable join flow", async ({
  browser,
}) => {
  const host = await browser.newPage();
  let first: Page | undefined;
  let second: Page | undefined;
  try {
    await login(host);
    const roomId = await createRoom(host, "Approval room", {
      approval: true,
      limit: 1,
    });
    first = await newGuest(browser, roomId, "First guest");
    await expect(
      first.getByText("Your request is waiting.", { exact: false }),
    ).toBeVisible();
    await host.getByRole("tab", { name: "Members", exact: true }).click();
    const waiting = host.getByRole("region", { name: "Waiting to join" });
    // The admission list is a labelled section, exposed as a region by browsers.
    await expect(
      waiting.getByText("First guest", { exact: true }),
    ).toBeVisible();
    await waiting.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(
      first.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();

    second = await newGuest(browser, roomId, "Second guest");
    await expect(second.getByRole("alert")).toContainText("This room is full");
    await expect(
      second.getByRole("textbox", { name: "Your nickname", exact: true }),
    ).toHaveValue("Second guest");
    await first
      .getByRole("button", { name: "Leave room", exact: true })
      .click();
    await second
      .getByRole("button", { name: /^(Join room|Try again)$/ })
      .click();
    await expect(
      second.getByText("Your request is waiting.", { exact: false }),
    ).toBeVisible();
    await expect(
      waiting.getByText("Second guest", { exact: true }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "Cancel request and return", exact: true })
      .click();
    await expect(second).toHaveURL(/\/$/);
    await expect(
      waiting.getByText("Second guest", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await snapshot(host))?.joinRequests?.length)
      .toBe(0);
  } finally {
    await second?.close();
    await first?.close();
    await host.close();
  }
});

test("a guest requests an activity, can revise one advisory vote, and never switches by voting", async ({
  browser,
}) => {
  const host = await browser.newPage();
  let guest: Page | undefined;
  try {
    await login(host);
    const roomId = await createRoom(host, "Activity decisions");
    guest = await newGuest(browser, roomId, "Voting guest");
    await expect(
      guest.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    await guest.getByRole("button", { name: "Listen", exact: true }).click();
    await expect(guest.getByRole("status")).toContainText(
      "Your request was sent to the host.",
    );
    await expect(
      host.getByRole("region", { name: "Activity requests and poll" }),
    ).toContainText("Voting guest");
    await host
      .getByRole("button", { name: "Ask everyone", exact: true })
      .click();
    const vote = guest.getByRole("region", {
      name: "Activity requests and poll",
    });
    await expect(vote).toContainText("Switch to Listen?");
    await vote.getByRole("button", { name: "Yes", exact: true }).click();
    await expect
      .poll(async () => [
        (await snapshot(guest))?.poll?.yes,
        (await snapshot(guest))?.poll?.no,
      ])
      .toEqual([1, 0]);
    await vote.getByRole("button", { name: "No", exact: true }).click();
    await expect
      .poll(async () => [
        (await snapshot(guest))?.poll?.yes,
        (await snapshot(guest))?.poll?.no,
      ])
      .toEqual([0, 1]);
    await expect(
      guest.getByRole("button", { name: "Watch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      host.getByRole("button", { name: "Watch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await host.getByRole("button", { name: "Listen", exact: true }).click();
    await expect(
      guest.getByRole("button", { name: "Listen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await snapshot(guest))?.poll).toBeNull();
    await expect
      .poll(async () => (await snapshot(guest))?.requests?.length)
      .toBe(0);
    await guest.getByRole("button", { name: "Screen", exact: true }).click();
    await expect(
      host.getByRole("button", { name: "Decline", exact: true }),
    ).toBeVisible();
    await host.getByRole("button", { name: "Decline", exact: true }).click();
    await expect
      .poll(async () => (await snapshot(guest))?.requests?.length)
      .toBe(0);
    await expect(
      guest.getByRole("button", { name: "Listen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await guest.getByRole("button", { name: "Watch", exact: true }).click();
    await host.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(
      guest.getByRole("button", { name: "Watch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await snapshot(guest))?.requests?.length)
      .toBe(0);
  } finally {
    await guest?.close();
    await host.close();
  }
});

test("queue-only selection stays paused, play-now starts, and navigation keeps the room and video mounted", async ({
  browser,
}) => {
  const host = await browser.newPage();
  try {
    await login(host);
    const roomId = await createRoom(host, "Continuous room session");
    const picker = await openContent(host);
    const input = picker.getByPlaceholder(
      "Paste a video, playlist or webpage URL",
    );
    await input.fill(`${fixtureOrigin}/normal.mp4`);
    await picker.getByRole("button", { name: "Resolve", exact: true }).click();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      host.getByText("Added to the queue.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        host.evaluate(async () => {
          // @ts-ignore App module under test.
          const { useRoomStore } = await import("/src/store/roomStore.ts");
          const state = useRoomStore.getState();
          return {
            count: state.movies.length,
            selected: state.currentMovieId,
            playing: state.watchTogether.isPlaying,
          };
        }),
      )
      .toMatchObject({ count: 1, playing: false });
    // Choosing a queue entry does not replace the current activity until explicitly played.
    expect(
      await host
        .locator("video")
        .first()
        .evaluate((video: HTMLVideoElement) => video.paused),
    ).toBe(true);

    await picker
      .getByRole("radio", { name: "Play the first selection now", exact: true })
      .check();
    await input.fill(`${fixtureOrigin}/normal.mp4?selection=play-now`);
    await picker.getByRole("button", { name: "Resolve", exact: true }).click();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .poll(
        () =>
          host
            .locator("video")
            .first()
            .evaluate((video: HTMLVideoElement) => video.currentTime),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await picker
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const retained = await host.locator("video").first().elementHandle();
    expect(retained).not.toBeNull();
    const previousMuted = await retained!.evaluate(
      (video: HTMLVideoElement) => {
        // Extend the two-second real fixture so navigation can observe ongoing playback.
        video.loop = true;
        return video.muted;
      },
    );
    const socketId = await host.evaluate(
      () => (window as any).__debugSocket.id,
    );
    await host.getByRole("button", { name: "Hall", exact: true }).click();
    await expect(host).toHaveURL(/\/$/);
    await expect(
      host.getByRole("complementary", { name: "Active room" }),
    ).toBeVisible();
    expect(
      await retained!.evaluate((video: HTMLVideoElement) => video.isConnected),
    ).toBe(true);
    expect(
      await retained!.evaluate((video: HTMLVideoElement) => video.paused),
    ).toBe(false);
    expect(await host.evaluate(() => (window as any).__debugSocket.id)).toBe(
      socketId,
    );
    await host.getByRole("button", { name: "Mute sound", exact: true }).click();
    await expect
      .poll(() => retained!.evaluate((video: HTMLVideoElement) => video.muted))
      .toBe(true);
    await host
      .getByRole("button", { name: "Unmute sound", exact: true })
      .click();
    await expect
      .poll(() => retained!.evaluate((video: HTMLVideoElement) => video.muted))
      .toBe(previousMuted);
    await host
      .getByRole("button", { name: "Return to room", exact: true })
      .click();
    await expect(host).toHaveURL(new RegExp(`/room/${roomId}$`));
    expect(
      await host
        .locator("video")
        .first()
        .evaluate((video, previous) => video === previous, retained),
    ).toBe(true);
    await host.getByRole("button", { name: "Listen", exact: true }).click();
    await expect
      .poll(() => retained!.evaluate((video: HTMLVideoElement) => video.paused))
      .toBe(true);
    const pausedTime = await retained!.evaluate(
      (video: HTMLVideoElement) => video.currentTime,
    );
    await host.getByRole("button", { name: "Watch", exact: true }).click();
    expect(
      await host
        .locator("video")
        .first()
        .evaluate((video, previous) => video === previous, retained),
    ).toBe(true);
    expect(
      await retained!.evaluate((video: HTMLVideoElement) => video.paused),
    ).toBe(true);
    expect(
      Math.abs(
        (await retained!.evaluate(
          (video: HTMLVideoElement) => video.currentTime,
        )) - pausedTime,
      ),
    ).toBeLessThan(0.25);
    await host.getByRole("button", { name: "Leave room", exact: true }).click();
    await expect(host).toHaveURL(/\/$/);
    await expect
      .poll(() =>
        retained!.evaluate((video: HTMLVideoElement) => video.isConnected),
      )
      .toBe(false);
    await expect(
      host.getByRole("complementary", { name: "Active room" }),
    ).toHaveCount(0);
    await retained!.dispose();
  } finally {
    await host.close();
  }
});

test("login-only room rejects guests while keeping their join form available", async ({
  browser,
}) => {
  const host = await browser.newPage();
  let guest: Page | undefined;
  try {
    await login(host);
    const roomId = await createRoom(host, "Members only", { guests: false });
    guest = await newGuest(browser, roomId, "Visitor");
    await expect(guest.getByRole("alert")).toContainText(
      "Sign in to join this room.",
    );
    await expect(
      guest.getByRole("textbox", { name: "Your nickname", exact: true }),
    ).toHaveValue("Visitor");
    await expect(
      guest.getByRole("button", { name: "Join room", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(async () => (await snapshot(host))?.joinRequests?.length)
      .toBe(0);
  } finally {
    await guest?.close();
    await host.close();
  }
});

test("shared room grants a signed-in member content and playback control but keeps guest collaboration closed", async ({
  browser,
}) => {
  const host = await browser.newPage();
  const member = await browser.newPage();
  let guest: Page | undefined;
  const username = `member_${Date.now()}`;
  const password = "room-member-test-password";
  try {
    await login(host);
    await host.evaluate(async () => {
      // @ts-ignore App authentication path used by the actual settings page.
      const { apiFetch } = await import("/src/lib/api.ts");
      const response = await apiFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoDeleteInactiveRooms: true,
          autoDeleteAfterHours: 24,
          registrationMode: "open",
        }),
      });
      if (!response.ok)
        throw new Error("Could not enable fixture registration");
    });
    const registered = await host.request.post("/api/auth/register", {
      data: { username, password },
    });
    expect(registered.ok()).toBe(true);
    const roomId = await createRoom(host, "Shared participation", {
      shared: true,
    });
    await login(member, username, password);
    await member.goto(`/room/${roomId}`);
    await expect
      .poll(async () => (await snapshot(member))?.permissions)
      .toMatchObject({
        selectContent: true,
        playback: true,
        settings: false,
        switchActivity: false,
        screenShare: false,
      });
    const picker = await openContent(member);
    await picker
      .getByPlaceholder("Paste a video, playlist or webpage URL")
      .fill(`${fixtureOrigin}/normal.mp4`);
    await picker
      .getByRole("radio", { name: "Play the first selection now", exact: true })
      .check();
    await picker.getByRole("button", { name: "Resolve", exact: true }).click();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .poll(
        () =>
          member
            .locator("video")
            .first()
            .evaluate((video: HTMLVideoElement) => video.readyState),
        { timeout: 20000 },
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        () =>
          host
            .locator("video")
            .first()
            .evaluate((video: HTMLVideoElement) => video.readyState),
        { timeout: 20000 },
      )
      .toBeGreaterThanOrEqual(1);
    await picker
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Room settings", exact: true }),
    ).toHaveCount(0);
    guest = await newGuest(browser, roomId, "Unprivileged guest");
    await expect
      .poll(async () => (await snapshot(guest!))?.permissions)
      .toMatchObject({
        selectContent: false,
        playback: false,
        settings: false,
        switchActivity: false,
        screenShare: false,
      });
    await expect(
      guest.getByRole("button", { name: "Suggest content", exact: true }),
    ).toBeVisible();
    await guest.getByRole("tab", { name: "Queue", exact: true }).click();
    await expect(
      guest
        .getByRole("tabpanel", { name: "Queue", exact: true })
        .getByRole("button", { name: "Play", exact: true }),
    ).toHaveCount(0);
  } finally {
    await host
      .evaluate(async () => {
        // @ts-ignore Restore the isolated test platform's registration policy.
        const { apiFetch } = await import("/src/lib/api.ts");
        await apiFetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoDeleteInactiveRooms: true,
            autoDeleteAfterHours: 24,
            registrationMode: "approval",
          }),
        });
      })
      .catch(() => undefined);
    await guest?.close();
    await member.close();
    await host.close();
  }
});

test("a connected member takes activity hosting after 30 seconds and formal ownership does not revert", async ({
  browser,
}) => {
  test.setTimeout(90000);
  let owner: Page | undefined = await browser.newPage();
  const member = await browser.newPage();
  let guest: Page | undefined;
  const username = `delegate_${Date.now()}`;
  const password = "delegate-test-password";
  try {
    await login(owner);
    await owner.evaluate(async () => {
      // @ts-ignore Actual application authentication helper.
      const { apiFetch } = await import("/src/lib/api.ts");
      const response = await apiFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoDeleteInactiveRooms: true,
          autoDeleteAfterHours: 24,
          registrationMode: "open",
        }),
      });
      if (!response.ok)
        throw new Error("Could not enable fixture registration");
    });
    expect(
      (
        await owner.request.post("/api/auth/register", {
          data: { username, password },
        })
      ).ok(),
    ).toBe(true);
    const roomId = await createRoom(owner, "Hosting handover", {
      shared: true,
      fixed: true,
    });
    await login(member, username, password);
    await member.goto(`/room/${roomId}`);
    await expect(
      member.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    guest = await newGuest(browser, roomId, "Handover guest");
    await expect(
      guest.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    const memberSocketId = await member.evaluate(
      () => (window as any).__debugSocket.id,
    );
    await owner.close();
    owner = undefined;
    await expect
      .poll(async () => (await snapshot(member))?.host?.socketId, {
        timeout: 45000,
        intervals: [500, 1000],
      })
      .toBe(memberSocketId);
    await expect
      .poll(async () => (await snapshot(member))?.isDelegate)
      .toBe(true);
    await expect
      .poll(async () => (await snapshot(guest!))?.isDelegate)
      .toBe(false);
    await expect
      .poll(async () => (await snapshot(guest!))?.permissions?.settings)
      .toBe(false);

    owner = await browser.newPage();
    await login(owner);
    await owner.goto(`/room/${roomId}`);
    // Returning through an invite restores ownership and reloads once. Wait
    // for that actual socket registration before comparing the host identity.
    await expect
      .poll(
        async () => {
          try {
            return await owner!.evaluate(async () => {
              // Read both identities in the same document. The expected
              // ownership restoration reload may interrupt this attempt.
              // @ts-ignore Vite module import for the live room snapshot.
              const { useRoomExperienceStore } =
                await import("/src/store/roomExperienceStore.ts");
              const state = useRoomExperienceStore.getState().snapshot;
              const socketId = (window as any).__debugSocket?.id;
              return Boolean(
                socketId &&
                state?.host?.socketId === socketId &&
                state?.permissions.settings,
              );
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("Execution context was destroyed")
            ) {
              return false;
            }
            throw error;
          }
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const ownerSocketId = await owner.evaluate(
      () => (window as any).__debugSocket.id,
    );
    await expect
      .poll(async () => (await snapshot(member))?.host?.socketId)
      .toBe(ownerSocketId);
    await expect
      .poll(async () => (await snapshot(member))?.isDelegate)
      .toBe(false);
    await owner.getByRole("tab", { name: "Members", exact: true }).click();
    await owner
      .getByRole("button", {
        name: `Transfer ownership to ${username}`,
        exact: true,
      })
      .click();
    const confirmation = owner.getByRole("dialog", {
      name: "Transfer room ownership?",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Transfer ownership", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot(member))?.host?.socketId)
      .toBe(memberSocketId);
    const permanentOwnerId = (await snapshot(member))?.host?.userId;
    expect(permanentOwnerId).toBeGreaterThan(1);
    await owner.close();
    owner = undefined;
    owner = await browser.newPage();
    await login(owner);
    await owner.goto(`/room/${roomId}`);
    await expect(
      owner.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await snapshot(owner!))?.host?.userId)
      .toBe(permanentOwnerId);
    expect((await snapshot(owner))?.host?.socketId).toBe(memberSocketId);
  } finally {
    await owner
      ?.evaluate(async () => {
        // @ts-ignore Restore test platform registration policy.
        const { apiFetch } = await import("/src/lib/api.ts");
        await apiFetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autoDeleteInactiveRooms: true,
            autoDeleteAfterHours: 24,
            registrationMode: "approval",
          }),
        });
      })
      .catch(() => undefined);
    await guest?.close();
    await member.close();
    await owner?.close();
  }
});
