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

// Chromium and firefox are always defined and are verified-launchable on the
// target host. WebKit is OPT-IN via the PLAYWRIGHT_WEBKIT env var: it cannot
// launch on the Ubuntu 25.10 host (it requires ICU 74; the host provides
// libicu76), so defining it unconditionally makes `make test` non-green on this
// host. Set PLAYWRIGHT_WEBKIT=1 (e.g. inside the official Playwright Docker
// image) to add the webkit project. Rationale is documented in
// docs/decision-log.md.
const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
];
if (process.env.PLAYWRIGHT_WEBKIT) {
  projects.push({ name: 'webkit', use: { ...devices['Desktop Safari'] } });
}

export default defineConfig({
  testDir: './packages/web/test/e2e',

  // Visual-fidelity baselines resolve to `<testDir>/__screenshots__/<name>` (no
  // project/platform suffix). The `{testDir}` token expands to the ABSOLUTE project
  // test directory (packages/web/test/e2e). `{testFileDir}` must NOT be used here:
  // it expands to the test file's path RELATIVE TO testDir, which is empty for a
  // spec that lives directly in testDir, yielding the filesystem-root path
  // `/__screenshots__/...` (baselines written outside the repo, never committable).
  // Using `{testDir}` keeps baselines inside the repo, aligned with the
  // `__screenshots__` directory screenshot-fidelity.spec.ts manages as committed
  // clone-goldens (Rule 1 / Gate 8). Rationale: docs/decision-log.md.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',

  // The E2E suite is backed by a single shared Postgres (slack_dev) and performs
  // per-test cleanup (see packages/web/test/e2e/fixtures.ts). Run serially so
  // concurrent transactions cannot contend (the P2028 "Transaction already
  // closed" / HTTP 500 failures seen under default parallelism) and so per-test
  // teardown is never racing a sibling test. Rationale: docs/decision-log.md.
  fullyParallel: false,

  // Reject a committed `test.only` on CI.
  forbidOnly: !!process.env.CI,

  // Retry failed specs twice on CI; no retries locally.
  retries: process.env.CI ? 2 : 0,

  // A single worker (serial) on every host: required for the shared-DB E2E
  // suite's per-test isolation and to avoid DB transaction contention.
  workers: 1,

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
