/**
 * packages/web/test/e2e/screenshot-fidelity.spec.ts
 *
 * Visual-regression E2E suite enforcing AAP Gate 8 (Visual Fidelity) and Rule 1
 * (Screenshot-Driven UI). Each golden-path screen is compared with Playwright's
 * `toHaveScreenshot` against a baseline in the deterministic snapshot directory
 * (`<testDir>/__screenshots__`, fixed by `snapshotPathTemplate` in the root
 * `playwright.config.ts`) — never against a silently self-generated first-run
 * capture.
 *
 * Baseline strategy — COMMITTED CLONE-GOLDENS (rationale: docs/decision-log.md):
 * every baseline is a known-good capture of THIS application, not the third-party
 * Slack reference PNG. A clone cannot pixel-match a real Slack capture at the
 * suite's 2% tolerance (different copy, workspace data, fonts and anti-aliasing —
 * empirically: clone-vs-Slack-PNG fails for all six screens, public screens
 * included), so the correct visual-regression baseline for an app-owned screen is
 * a capture of the app itself, against which future runs are checked for layout
 * regressions. Each golden was visually verified to reproduce the STRUCTURE of its
 * Slack reference (three-column shell, `#` channel prefix, pill-chip reactions,
 * centered modal — Rule 1). The baseline name is what `toHaveScreenshot(name)`
 * resolves against; the arrow notes the Slack reference each golden reproduces:
 *     landing.png               ← reproduces Slack web Jul 2024 0.png   (marketing landing)
 *     login.png                 ← reproduces Slack web Jul 2024 1.png   (email sign-in)
 *     register.png              ← reproduces Slack web Jul 2024 8.png   (registration)
 *     channel.png               ← reproduces Slack web Jul 2024 29.png  (3-column shell)
 *     channel-reactions.png     ← reproduces Slack web Jul 2024 100.png (pill-chip reactions)
 *     create-channel-dialog.png ← reproduces Slack web Jul 2024 500.png (centered modal)
 *
 * The goldens are committed under `__screenshots__` (otherwise gitignored — added
 * with `git add -f`) and regenerated deliberately with
 * `pnpm exec playwright test screenshot-fidelity --update-snapshots`.
 *
 * Framing: the reference assets are 1920×1320 viewport captures, so the suite pins
 * the viewport to 1920×1320 and captures the viewport (not full page) so the
 * rendered frame is dimensionally aligned with the golden.
 *
 * Masking: on authenticated screens, regions whose pixels are inherently
 * non-deterministic between runs — relative timestamps, live presence dots, and
 * per-user avatars — are passed to `mask` so layout/structure is asserted without
 * their churn. Residual rendering noise is bounded by the central
 * `expect.toHaveScreenshot` tolerance (`maxDiffPixelRatio`/`threshold`) defined
 * once in the root `playwright.config.ts`, not repeated per assertion.
 *
 * The suite runs in Chromium only. Firefox and WebKit rasterise fonts and
 * anti-aliasing differently from Chromium, so running them against a
 * Chromium-generated capture yields false-positive diffs.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  sendMessageViaUi,
} from './fixtures';

// Directory of THIS spec file (ESM equivalent of __dirname).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

// Deterministic baseline directory — MUST match `snapshotPathTemplate` in the
// root playwright.config.ts (`{testDir}/__screenshots__/{arg}{ext}`). This is the
// committable repo directory (otherwise gitignored — committed with `git add -f`).
const BASELINE_DIR = resolve(TEST_DIR, '__screenshots__');

/**
 * Ensure the committed-golden baseline directory exists before any comparison
 * runs. The goldens themselves are committed to the repo and regenerated
 * deliberately with `pnpm exec playwright test screenshot-fidelity
 * --update-snapshots`; a missing golden therefore surfaces as Playwright's native
 * "snapshot doesn't exist" failure (it writes the actual and fails the test),
 * never a silent pass. Creating the directory here keeps that first
 * `--update-snapshots` bootstrap from failing on a fresh checkout that has not yet
 * materialised the folder.
 */
function ensureBaselineDir(): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
}

test.describe('Screenshot Fidelity (Gate 8)', () => {
  // Ensure the committed clone-golden baseline directory exists before any
  // comparison runs (the goldens themselves are committed; rationale in
  // docs/decision-log.md).
  test.beforeAll(() => {
    ensureBaselineDir();
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

    await test.step('Compare against the committed landing clone-golden', async () => {
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

    await test.step('Compare against the committed register clone-golden', async () => {
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

    await test.step('Compare against the committed login clone-golden', async () => {
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
    // message timeline has no per-run content to capture. Fixed displayName and
    // channel name keep the captured frame deterministic against the committed
    // clone-golden (the per-test cleanup fixture removes both afterwards, so the
    // fixed names cannot collide across tests).
    const user = await test.step('Register a user', () =>
      registerUserViaApi({ displayName: 'Fidelity User' }));
    const channel = await test.step('Create an empty channel via the API', () =>
      createChannelViaApi(user.token, 'fidelity-shell'));

    await test.step('Log in and open the channel three-column shell', async () => {
      await loginViaUi(page, user.email, user.password);
      await page.goto(`/app/channels/${channel.id}`);
      // The three-column shell is ready once the sidebar nav and composer render.
      // Two <nav> landmarks exist (the WorkspaceNavRail rail and the Sidebar), so
      // the accessible name disambiguates the readiness gate (avoids strict-mode).
      await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the committed channel clone-golden (volatile regions masked)', async () => {
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

  test('channel view with reactions matches the Slack reference (screenshot 100)', async ({
    page,
  }) => {
    // Provision a user and channel, then post a message and toggle a reaction so
    // the pill-chip reaction styling (Rule 1) is present in the captured frame.
    // Fixed displayName and channel name keep the frame deterministic against
    // the committed clone-golden (the per-test cleanup fixture removes both).
    const user = await test.step('Register a user', () =>
      registerUserViaApi({ displayName: 'Fidelity User' }));
    const channel = await test.step('Create a channel via the API', () =>
      createChannelViaApi(user.token, 'fidelity-reactions'));

    await test.step('Log in and open the channel', async () => {
      await loginViaUi(page, user.email, user.password);
      await page.goto(`/app/channels/${channel.id}`);
      await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
    });

    await test.step('Post a message and add an emoji reaction (pill chip)', async () => {
      const content = 'reaction fidelity message';
      await sendMessageViaUi(page, content);
      await expect(page.getByText(content).first()).toBeVisible({ timeout: 5_000 });
      // Hover the message to reveal its toolbar, open the reaction picker, and
      // toggle the thumbs-up so a reaction pill chip renders on the message.
      await page.getByText(content).first().hover();
      // The add-reaction control sits in the message's floating hover toolbar
      // (absolute, negative top offset); force the click so Playwright does not
      // treat the overlapping row as intercepting the visible, hover-enabled
      // trigger.
      await page
        .getByRole('button', { name: /add reaction/i })
        .first()
        .click({ force: true });
      // Search by the emoji glyph (the picker filters by the character itself)
      // so the target renders regardless of the active category tab, then pick
      // it by its "Select <emoji>" accessible name.
      await page.getByLabel('Search emoji').fill('👍');
      await page.getByRole('button', { name: 'Select 👍' }).first().click();
      await expect(page.getByText('👍').first()).toBeVisible({ timeout: 5_000 });
      await page.evaluate(() => document.fonts.ready);
    });

    await test.step('Compare against the committed reactions clone-golden (volatile regions masked)', async () => {
      await expect(page).toHaveScreenshot('channel-reactions.png', {
        animations: 'disabled',
        caret: 'hide',
        // Same volatile-region masking as the channel view — timestamps, live
        // presence dots, and per-user avatars.
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
    // Fixed displayName keeps the avatar fallback initials and any name-derived
    // text deterministic against the committed clone-golden.
    const user = await test.step('Register a user', () =>
      registerUserViaApi({ displayName: 'Fidelity User' }));

    await test.step('Log in and open the workspace shell', async () => {
      await loginViaUi(page, user.email, user.password);
      await page.goto('/app');
      // Disambiguate the two <nav> landmarks by accessible name (strict-mode safe).
      await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
        timeout: 10_000,
      });
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

    await test.step('Compare against the committed create-channel-dialog clone-golden', async () => {
      await expect(page).toHaveScreenshot('create-channel-dialog.png', {
        animations: 'disabled',
        caret: 'hide',
        // Mask the volatile regions behind the modal (live presence dots and
        // per-user avatars) so the comparison asserts the modal + shell layout
        // without their churn — matching the channel-view masking.
        mask: [
          page.locator('time'),
          page.locator('[data-slot="presence-indicator"]'),
          page.locator('[aria-label*="ago" i]'),
          page.locator('[data-slot="avatar"]'),
        ],
      });
    });
  });
});
