/**
 * packages/web/test/e2e/screenshot-fidelity.spec.ts
 *
 * Visual-regression E2E suite enforcing AAP Gate 8 (Visual Fidelity). It captures
 * a baseline screenshot of each golden-path screen and compares subsequent runs
 * against that baseline with Playwright's `toHaveScreenshot`. The comparison
 * tolerances (`maxDiffPixelRatio`, `threshold`) are supplied centrally by the
 * shared `expect.toHaveScreenshot` configuration in the root `playwright.config.ts`
 * and are therefore not repeated on the per-assertion calls below.
 *
 * The suite runs in Chromium only. Firefox and WebKit rasterise fonts and
 * anti-aliasing differently from Chromium, so running them against a
 * Chromium-generated baseline yields false-positive diffs.
 *
 * Screens covered (see AAP §0.6.3):
 *   1. `/`                  — landing page
 *   2. `/register`          — registration form
 *   3. `/login`             — login form
 *   4. `/app/channels/:id`  — authenticated three-column channel view
 *   5. CreateChannelDialog  — modal overlay opened from the workspace shell
 */

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  uniqueChannelName,
} from './fixtures';

test.describe('Screenshot Fidelity (Gate 8)', () => {
  // Restrict every test in this suite to Chromium; other engines render glyphs
  // and anti-aliasing differently and would diff against the Chromium baseline.
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Screenshot fidelity tests run in chromium only — Safari/Firefox render anti-aliasing differently',
    );
  });

  // A fixed viewport keeps the captured pixels deterministic across machines.
  test.use({ viewport: { width: 1280, height: 720 } });

  test('landing page matches baseline', async ({ page }) => {
    await page.goto('/');
    // The primary heading is the last element to settle on the marketing page.
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });
    // Block until web fonts are loaded so the capture is not a flash-of-unstyled-text frame.
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('landing.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('register page matches baseline', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('register.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('login page matches baseline', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('login.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('authenticated channel view matches baseline', async ({ page }) => {
    // Provision an isolated user and a freshly created (empty) channel so the
    // message timeline has no per-run content to capture.
    const user = await registerUserViaApi();
    const channel = await createChannelViaApi(user.token, uniqueChannelName('vis'));
    await loginViaUi(page, user.email, user.password);
    await page.goto(`/app/channels/${channel.id}`);

    // The three-column shell is ready once the sidebar nav and composer render.
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('channel.png', {
      animations: 'disabled',
      caret: 'hide',
      // Mask regions whose content changes per run — relative timestamps and the
      // live presence dots — so layout is asserted without their churn.
      mask: [
        page.locator('time'),
        page.locator('[data-presence-indicator]'),
        page.locator('[aria-label*="ago" i]'),
      ],
    });
  });

  test('create channel dialog matches baseline', async ({ page }) => {
    const user = await registerUserViaApi();
    await loginViaUi(page, user.email, user.password);
    await page.goto('/app');

    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 10_000 });

    // Open the Create Channel dialog. The accessible name of the trigger differs
    // across the reference screenshots, so match any of its known variants.
    const addChannelButton = page
      .getByRole('button', {
        name: /add channels|create channel|new channel|create a channel|\+ channels/i,
      })
      .first();
    await addChannelButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('create-channel-dialog.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
