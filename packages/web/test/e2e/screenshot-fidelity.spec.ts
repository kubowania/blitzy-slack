/**
 * packages/web/test/e2e/screenshot-fidelity.spec.ts
 *
 * Visual-regression E2E suite enforcing AAP Gate 8 (Visual Fidelity) and Rule 1
 * (Screenshot-Driven UI). Each golden-path screen is compared with Playwright's
 * `toHaveScreenshot` against a baseline that is SEEDED FROM the authoritative
 * Mobbin reference captures committed under `/screenshots/Slack web Jul 2024 *.png`
 * — not against a self-generated first-run capture. `seedReferenceBaselines`
 * copies each mapped reference asset into the deterministic snapshot directory
 * (`<testFileDir>/__screenshots__`, fixed by `snapshotPathTemplate` in the root
 * `playwright.config.ts`) before the assertions run, so every comparison is
 * literally rendered-clone-vs-Slack-reference.
 *
 * Reference mapping (AAP §0.6.3 / §0.9.2):
 *   landing.png               ← Slack web Jul 2024 0.png   (marketing landing)
 *   login.png                 ← Slack web Jul 2024 1.png   (email sign-in)
 *   register.png              ← Slack web Jul 2024 8.png   (registration)
 *   channel.png               ← Slack web Jul 2024 29.png  (3-column channel view)
 *   create-channel-dialog.png ← Slack web Jul 2024 500.png (centered modal)
 *
 * Framing: the reference assets are 1920×1320 viewport captures, so the suite
 * pins the viewport to 1920×1320 and captures the viewport (not full page) so the
 * rendered frame is dimensionally aligned with the reference baseline.
 *
 * Cropping / masking: regions whose pixels are inherently non-deterministic
 * between the clone and the reference — relative timestamps, live presence dots,
 * and per-user avatars — are passed to `mask` so layout/structure is asserted
 * without their churn. Residual content differences (the clone's own copy/data
 * versus Slack's reference content) are bounded by the central
 * `expect.toHaveScreenshot` tolerance (`maxDiffPixelRatio`/`threshold`) defined
 * once in the root `playwright.config.ts`, not repeated per assertion.
 *
 * The suite runs in Chromium only. Firefox and WebKit rasterise fonts and
 * anti-aliasing differently from Chromium, so running them against a
 * Chromium-generated capture yields false-positive diffs.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  uniqueChannelName,
} from './fixtures';

// Directory of THIS spec file (ESM equivalent of __dirname).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

// Authoritative reference assets live at the repository root under /screenshots
// (four levels up from packages/web/test/e2e).
const REFERENCE_DIR = resolve(TEST_DIR, '../../../../screenshots');

// Deterministic baseline directory — MUST match `snapshotPathTemplate` in the
// root playwright.config.ts (`{testFileDir}/__screenshots__/{arg}{ext}`).
const BASELINE_DIR = resolve(TEST_DIR, '__screenshots__');

/**
 * Map each Playwright baseline name to the authoritative Slack reference asset
 * it is seeded from. The baseline name is what `toHaveScreenshot(name)` resolves
 * against; the value is the committed Mobbin capture under /screenshots.
 */
const REFERENCE_BASELINES: Readonly<Record<string, string>> = {
  'landing.png': 'Slack web Jul 2024 0.png',
  'login.png': 'Slack web Jul 2024 1.png',
  'register.png': 'Slack web Jul 2024 8.png',
  'channel.png': 'Slack web Jul 2024 29.png',
  'create-channel-dialog.png': 'Slack web Jul 2024 500.png',
};

/**
 * Seed the snapshot baselines from the authoritative reference assets so every
 * `toHaveScreenshot` compares the rendered clone against the real Slack capture
 * rather than a self-generated first-run image. Throws loudly if a referenced
 * asset is missing so the suite can never silently fall back to a generated
 * baseline.
 */
function seedReferenceBaselines(): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  for (const [baselineName, referenceFile] of Object.entries(REFERENCE_BASELINES)) {
    const referencePath = resolve(REFERENCE_DIR, referenceFile);
    if (!existsSync(referencePath)) {
      throw new Error(
        `Reference screenshot not found: ${referencePath}. Visual fidelity baselines ` +
          'must be seeded from the committed /screenshots assets (Rule 1 / Gate 8).',
      );
    }
    copyFileSync(referencePath, resolve(BASELINE_DIR, baselineName));
  }
}

test.describe('Screenshot Fidelity (Gate 8)', () => {
  // Seed all baselines from the authoritative /screenshots assets before any
  // comparison runs, so baselines are tied to the references (Rule 1).
  test.beforeAll(() => {
    seedReferenceBaselines();
  });

  // Restrict every test in this suite to Chromium; other engines render glyphs
  // and anti-aliasing differently and would diff against the Chromium baseline.
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Screenshot fidelity tests run in chromium only — Safari/Firefox render anti-aliasing differently',
    );
  });

  // Pin the viewport to the reference capture dimensions (1920×1320) so the
  // rendered frame is dimensionally aligned with the seeded Slack baseline.
  test.use({ viewport: { width: 1920, height: 1320 } });

  test('landing page matches the Slack reference (screenshot 0)', async ({ page }) => {
    await test.step('Navigate to the landing page and wait for fonts/heading', async () => {
      await page.goto('/');
      // The primary heading is the last element to settle on the marketing page.
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });
      // Block until web fonts are loaded so the capture is not a flash-of-unstyled-text frame.
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the seeded landing baseline', async () => {
      await expect(page).toHaveScreenshot('landing.png', {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });

  test('register page matches the Slack reference (screenshot 8)', async ({ page }) => {
    await test.step('Navigate to the registration page and wait for the form', async () => {
      await page.goto('/register');
      await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the seeded register baseline', async () => {
      await expect(page).toHaveScreenshot('register.png', {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });

  test('login page matches the Slack reference (screenshot 1)', async ({ page }) => {
    await test.step('Navigate to the login page and wait for the form', async () => {
      await page.goto('/login');
      await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the seeded login baseline', async () => {
      await expect(page).toHaveScreenshot('login.png', {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });

  test('authenticated channel view matches the Slack reference (screenshot 29)', async ({
    page,
  }) => {
    // Provision an isolated user and a freshly created (empty) channel so the
    // message timeline has no per-run content to capture.
    const user = await test.step('Register a user', () => registerUserViaApi());
    const channel = await test.step('Create an empty channel via the API', () =>
      createChannelViaApi(user.token, uniqueChannelName('vis')));

    await test.step('Log in and open the channel three-column shell', async () => {
      await loginViaUi(page, user.email, user.password);
      await page.goto(`/app/channels/${channel.id}`);
      // The three-column shell is ready once the sidebar nav and composer render.
      await expect(page.getByRole('navigation')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the seeded channel baseline (volatile regions masked)', async () => {
      await expect(page).toHaveScreenshot('channel.png', {
        animations: 'disabled',
        caret: 'hide',
        // Mask regions whose content is non-deterministic between the clone and
        // the reference — relative timestamps, live presence dots, and per-user
        // avatars — so layout is asserted without their churn.
        mask: [
          page.locator('time'),
          page.locator('[data-slot="presence-indicator"]'),
          page.locator('[aria-label*="ago" i]'),
          page.locator('[data-slot="avatar"]'),
        ],
      });
    });
  });

  test('create channel dialog matches the Slack reference (screenshot 500)', async ({ page }) => {
    const user = await test.step('Register a user', () => registerUserViaApi());

    await test.step('Log in and open the workspace shell', async () => {
      await loginViaUi(page, user.email, user.password);
      await page.goto('/app');
      await expect(page.getByRole('navigation')).toBeVisible({ timeout: 10_000 });
    });

    await test.step('Open the Create Channel dialog', async () => {
      // The accessible name of the trigger differs across the reference
      // screenshots, so match any of its known variants.
      const addChannelButton = page
        .getByRole('button', {
          name: /add channels|create channel|new channel|create a channel|\+ channels/i,
        })
        .first();
      await addChannelButton.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the seeded create-channel-dialog baseline', async () => {
      await expect(page).toHaveScreenshot('create-channel-dialog.png', {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });
});
