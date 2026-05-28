import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration. Specs live under packages/web/test/e2e.
 * baseURL points at the Vite dev server (VITE_APP_URL).
 */
const baseURL = process.env.VITE_APP_URL ?? 'http://localhost:5173';

const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
];

// WebKit's Linux build requires system libraries that are unavailable on some
// hosts (e.g. Ubuntu 25.10 ships ICU 76 while the WebKit build needs ICU 74).
// It is therefore opt-in: set PLAYWRIGHT_WEBKIT=1 on a supported OS or in the
// official `mcr.microsoft.com/playwright` Docker image to include it.
if (process.env.PLAYWRIGHT_WEBKIT === '1') {
  projects.push({ name: 'webkit', use: { ...devices['Desktop Safari'] } });
}

export default defineConfig({
  testDir: './packages/web/test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects,
});
