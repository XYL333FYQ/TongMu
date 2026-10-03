import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

test.setTimeout(90_000);

async function createCoverRoom(page: Page, name: string) {
  await page.goto("/login");
  await page.getByPlaceholder("Your username").fill("root");
  await page.getByPlaceholder("Your password").fill("root");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Room name", exact: true })
    .fill(name);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/room\/[^/]+$/);
  await page
    .getByRole("button", { name: "Room settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Room settings", exact: true });
}

test("room covers upload and decode, preserve settings drafts, recover missing images and adapt in the hall", async ({
  page,
}) => {
  const settings = await createCoverRoom(page, "A room with a cover");
  const coverInput = settings.getByLabel("Choose a room cover image");
  const name = settings.getByRole("textbox", {
    name: "Room name",
    exact: true,
  });
  await name.fill("Cover room edited before upload");
  await coverInput.setInputFiles(
    path.join(process.cwd(), "frontend/public/room-covers/music.webp"),
  );
  await expect(settings.getByRole("status")).toHaveText("Room cover saved.");
  await expect(name).toHaveValue("Cover room edited before upload");
  const preview = settings.locator(".tm-room-cover-image");
  await expect(preview).toHaveAttribute(
    "src",
    /\/uploads\/room-covers\/[0-9a-f-]{36}\.webp$/,
  );
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(960);
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await page.getByRole("button", { name: "Hall", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search rooms" })
    .fill("Cover room edited before upload");
  const card = page.locator(".tm-room-card");
  const cover = card.locator(".tm-room-cover-image");
  await expect(card).toHaveCount(1);
  await expect(cover).toHaveAttribute("src", /\/uploads\/room-covers\//);
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(960);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(card.getByRole("button", { name: "Join room" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const proportions = await card.evaluate((element) => {
      const image = element
        .querySelector(".tm-room-art")!
        .getBoundingClientRect();
      const body = element
        .querySelector(".tm-room-card-body")!
        .getBoundingClientRect();
      return { image: image.height, body: body.height };
    });
    expect(proportions.image).toBeGreaterThan(proportions.body);
  }
  await page.route("**/uploads/room-covers/**", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.reload();
  await expect(cover).toHaveAttribute(
    "src",
    /\/room-covers\/(aurora|cinema|music|studio)\.webp$/,
  );
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(960);
  await page.unroute("**/uploads/room-covers/**");
  await page.reload();
  await expect(cover).toHaveAttribute("src", /\/uploads\/room-covers\//);
});

test("invalid room-cover images retain the existing cover and restoring defaults really clears it", async ({
  page,
}) => {
  const settings = await createCoverRoom(page, "Cover validation room");
  const coverInput = settings.getByLabel("Choose a room cover image");
  await coverInput.setInputFiles(
    path.join(process.cwd(), "frontend/public/room-covers/studio.webp"),
  );
  await expect(settings.getByRole("status")).toHaveText("Room cover saved.");
  const preview = settings.locator(".tm-room-cover-image");
  const savedUrl = await preview.getAttribute("src");
  await coverInput.setInputFiles({
    name: "fake.png",
    mimeType: "image/png",
    buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
  });
  await expect(settings.getByRole("alert")).toHaveText(
    "Use a valid JPG, PNG or WebP image.",
  );
  await expect(preview).toHaveAttribute("src", savedUrl!);
  await coverInput.setInputFiles({
    name: "large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(settings.getByRole("alert")).toHaveText(
    "Choose an image smaller than 5 MB.",
  );
  await expect(preview).toHaveAttribute("src", savedUrl!);
  await settings
    .getByRole("button", { name: "Use default cover", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText("Room cover saved.");
  await expect(preview).toHaveAttribute(
    "src",
    /\/room-covers\/(aurora|cinema|music|studio)\.webp$/,
  );
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(960);
  await expect(
    settings.getByRole("button", { name: "Use default cover", exact: true }),
  ).toHaveCount(0);
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Room settings", exact: true })
    .click();
  await expect(preview).toHaveAttribute("src", /\/room-covers\//);
});
