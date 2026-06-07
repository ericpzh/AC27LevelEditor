import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.mjs',
  globalTeardown: './tests/e2e/global-teardown.mjs',
  workers: 1,              // Electron is single-instance — tests must run serially
  retries: process.env.CI ? 2 : 0,
  timeout: process.env.CI ? 180_000 : 75_000,
  use: {
    headless: !!process.env.CI,
    viewport: { width: 1400, height: 880 },
  },
});
