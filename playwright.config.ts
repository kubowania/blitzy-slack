import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Blitzy Slack end-to-end suite.
 *
 * Specs live under `packages/web/test/e2e/**` and run against the Vite dev
 * server (`baseURL` = `VITE_APP_URL`). Before the suite starts, `globalSetup`
 * runs `scripts/seed-via-api.ts`, which creates the seed user `admin@test.com`
 * by calling `POST /api/auth/register` (Rule 4). The `expect.toHaveScreenshot`
 * tolerances below apply to the visual-fidelity suite
 * (`screenshot-fidelity.spec.ts`, Gate 8); `snapshotPathTemplate` maps baselines
 * to `<testFileDir>/__screenshots__`.
 *
 * Decisions for this file are recorded in docs/decision-log.md (Explainability).
 */

// Web app origin the browser navigates to; also the autostarted web server URL.
const baseURL = process.env.VITE_APP_URL ?? 'http://localhost:5173';

// API readiness probe used when Playwright autostarts the API dev server.
const apiHealthUrl = `${process.env.VITE_API_URL ?? 'http://localhost:3000'}/api/health`;

// All three browser engines are defined so the suite covers chromium, firefox,
// and webkit (Gate 8 / Gate 13). Host-specific launch constraints are documented
// in docs/decision-log.md.
const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

export default defineConfig({
  testDir: './packages/web/test/e2e',

  // Visual-fidelity baselines resolve to `<testFileDir>/__screenshots__/<name>`
  // (no project/platform suffix), matching the directory screenshot-fidelity.spec.ts
  // seeds from the authoritative /screenshots assets (Rule 1 / Gate 8).
  snapshotPathTemplate: '{testFileDir}/__screenshots__/{arg}{ext}',

  // Run spec files in parallel; `workers` below overrides concurrency on CI.
  fullyParallel: true,

  // Reject a committed `test.only` on CI.
  forbidOnly: !!process.env.CI,

  // Retry failed specs twice on CI; no retries locally.
  retries: process.env.CI ? 2 : 0,

  // Single worker on CI; Playwright's default (CPU-based) concurrency locally.
  workers: process.env.CI ? 1 : undefined,

  // HTML report (never auto-opened) plus the streaming `list` reporter.
  reporter: [['html', { open: 'never' }], ['list']],

  // Seeds admin@test.com before the suite via scripts/seed-via-api.ts (Rule 4).
  globalSetup: './scripts/seed-via-api.ts',

  expect: {
    // Shared tolerance applied to every toHaveScreenshot comparison (Gate 8).
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects,

  // With PLAYWRIGHT_AUTOSTART set, boot the API and web dev servers; otherwise
  // they are expected to be running already (e.g. started by `make local`).
  webServer: process.env.PLAYWRIGHT_AUTOSTART
    ? [
        {
          command: 'pnpm --filter @app/api dev',
          url: apiHealthUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @app/web dev',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ]
    : undefined,
});
