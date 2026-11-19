import { defineConfig, devices } from "@playwright/test";

// e2e scaffold (F0's own acceptance criterion) — one real browser
// (Chromium), pointed at a dev server this config starts itself so `npm
// run test:e2e` works standalone, not just inside an already-running
// `npm run dev` session. Deliberately small: this is the *scaffold*, not
// full coverage — see e2e/README.md-equivalent note in smoke.spec.ts for
// what's covered and what isn't.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
