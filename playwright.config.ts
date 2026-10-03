import { defineConfig } from "@playwright/test";

const browserName = process.env.PLAYWRIGHT_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserName)) {
  throw new Error("PLAYWRIGHT_BROWSER must be chromium, firefox, or webkit");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: browserName as "chromium" | "firefox" | "webkit",
    channel:
      browserName === "chromium"
        ? process.env.PLAYWRIGHT_CHANNEL || undefined
        : undefined,
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    // Existing behavior tests explicitly select English; product default is
    // Chinese and the localization suite overrides this initial preference.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:5173",
          localStorage: [{ name: "tongmu-locale", value: "en" }],
        },
      ],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/start-e2e.js",
    url: "http://127.0.0.1:5173",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
