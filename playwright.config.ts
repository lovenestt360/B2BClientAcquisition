import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config();
const E2E_DB = process.env.DATABASE_URL_E2E ?? "postgresql://app:app@localhost:5432/acquisition_e2e";
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    // iPhone viewport (rendered in Chromium) to check the responsive dashboard.
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@mobile/ },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: E2E_DB,
      SIMULATION_MODE: "true",
      ALLOW_AUTOMATED_OUTREACH: "false",
      JOBS_MODE: "inline",
      LLM_PROVIDER: "mock",
      STT_PROVIDER: "mock",
      TTS_PROVIDER: "mock",
      APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32, 3).toString("base64"),
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
