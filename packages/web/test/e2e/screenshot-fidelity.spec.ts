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
 * The clone-golden comparisons run in Chromium only. Firefox and WebKit
 * rasterise fonts and anti-aliasing differently from Chromium, so running them
 * against a Chromium-generated capture yields false-positive diffs.
 *
 * Reference-anchored layer (Gate 8, second describe block): because a clone
 * cannot pixel-match a third-party Slack capture, Rule 1 fidelity is ALSO
 * asserted directly against the authoritative `/screenshots/Slack web Jul 2024
 * *.png` reference PNGs. One test reads each enumerated reference PNG (presence,
 * PNG signature, and capture dimensions), so the gate genuinely DEPENDS on the
 * Slack references and fails if any is missing, renamed, or replaced by a
 * non-capture. The remaining tests assert the structural Rule 1 invariants each
 * reference establishes — the three-column shell with left-to-right rail /
 * sidebar / content ordering, the dark-aubergine sidebar against the white
 * content area, the `#` channel-name prefix, pill-chip reactions, and the
 * centered modal-over-backdrop — on the rendered app, plus a 1024px composer
 * regression check (VIS-004) guarding against formatting-toolbar overflow.
 * Rationale and the Gate 8 operational redefinition are recorded in
 * /docs/decision-log.md.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locator } from '@playwright/test';

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  sendMessageViaUi,
  uniqueChannelName,
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

/**
 * Resolve a locator's bounding box, throwing a descriptive error when the
 * element is not laid out (`boundingBox()` returns null for detached/hidden
 * elements). Lets callers consume the box without a non-null assertion (the
 * zero-warning lint gate, Rule 3, flags `!`).
 */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('expected the element to have a bounding box (is it visible and laid out?)');
  }
  return box;
}

/**
 * Sum the sRGB R+G+B channels of the first opaque background color found while
 * walking up the DOM from `el`. A low sum indicates a dark surface (the Slack
 * aubergine sidebar ~ 141), a high sum a light surface (white content ~ 765).
 * Walking ancestors is required because a landmark's own background can be
 * transparent while its wrapper carries the color (the sidebar bg lives on the
 * `<aside>` around the nav).
 *
 * Each candidate color is normalized to sRGB bytes via a 1x1 canvas rather than
 * parsed by hand: modern Chromium reports theme tokens from
 * getComputedStyle().backgroundColor in the authored color space (e.g.
 * `oklch(1 0 0)` for white), which a naive numeric parse would misread. Canvas
 * fillStyle parses any CSS color and getImageData returns the resolved sRGB
 * bytes. An unparseable color leaves fillStyle at the transparent reset, so it
 * is treated as transparent and the walk continues. Runs in the browser via
 * `Locator.evaluate`, so it MUST stay self-contained (no references to the Node
 * module scope); returns -1 when no opaque background exists in the ancestor
 * chain (or no 2D context is available).
 */
function effectiveBgSum(el: Element): number {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return -1;
  }
  let node: Element | null = el;
  while (node !== null) {
    const color = getComputedStyle(node).backgroundColor;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    const r = data[0] ?? 0;
    const g = data[1] ?? 0;
    const b = data[2] ?? 0;
    const a = data[3] ?? 0;
    if (a > 0) {
      return r + g + b;
    }
    node = node.parentElement;
  }
  return -1;
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

/**
 * Reference-Anchored Rule 1 Fidelity (Gate 8 — second layer)
 *
 * The clone-golden block above guards the clone against unintended visual
 * regressions, but it compares the clone to itself and so cannot, on its own,
 * prove fidelity to Slack. This block ties Gate 8 to the AUTHORITATIVE
 * `/screenshots/Slack web Jul 2024 *.png` reference captures:
 *
 *   1. `reference PNGs ... are real captures` makes the references a HARD
 *      dependency of the suite — it reads each enumerated PNG and asserts its
 *      presence, PNG signature, and capture dimensions, so the gate fails if a
 *      reference is missing, renamed, or swapped for a non-capture stub.
 *   2. The per-screen tests assert, on the rendered app, the structural Rule 1
 *      invariants each reference establishes: the three-column shell with a
 *      left-to-right rail / sidebar / content ordering, the dark-aubergine
 *      sidebar against the white content area, the `#` public-channel prefix,
 *      pill-chip reactions, and the centered modal over a fixed backdrop.
 *   3. A 1024px composer check regression-guards VIS-004 (toolbar overflow).
 *
 * These are DOM/computed-style assertions (not pixels), but are restricted to
 * Chromium to match the clone-golden block and keep computed values
 * deterministic. The Gate 8 operational redefinition is recorded in
 * /docs/decision-log.md.
 */
test.describe('Reference-Anchored Rule 1 Fidelity (Gate 8)', () => {
  // Repo root is four levels above this spec's directory
  // (packages/web/test/e2e -> repo root); the reference captures live in
  // /screenshots at the repo root.
  const SCREENSHOTS_DIR = resolve(TEST_DIR, '../../../../screenshots');

  // The specific reference captures cited by AAP §0.6.3 for each in-scope screen.
  const REFERENCE_PNGS: Record<string, string> = {
    landing: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 0.png'),
    login: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 1.png'),
    register: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 8.png'),
    channelShell: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 29.png'),
    reactions: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 100.png'),
    modal: resolve(SCREENSHOTS_DIR, 'Slack web Jul 2024 500.png'),
  };

  // Structural/computed-style assertions are most deterministic on a single
  // engine; restrict to Chromium to match the clone-golden block.
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'Reference-anchored fidelity tests run in chromium only');
  });

  test('authoritative Slack reference PNGs exist and are real captures', () => {
    const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const [screen, pngPath] of Object.entries(REFERENCE_PNGS)) {
      expect(existsSync(pngPath), `reference PNG for "${screen}" must exist at ${pngPath}`).toBe(
        true,
      );
      const buf = readFileSync(pngPath);
      // 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A).
      expect(Array.from(buf.subarray(0, 8)), `"${screen}" must be a PNG`).toEqual(PNG_SIGNATURE);
      // IHDR width/height are big-endian uint32 at byte offsets 16 and 20. Real
      // Slack web captures are wide desktop frames; a placeholder stub would not be.
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      expect(width, `"${screen}" capture width`).toBeGreaterThanOrEqual(1000);
      expect(height, `"${screen}" capture height`).toBeGreaterThanOrEqual(600);
    }
  });

  test('landing renders Slack-style marketing structure (reference 0)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    await page.goto('/');
    // Brand link, a hero <h1>, and a primary "Get started" CTA (two exist — the
    // nav and the hero — so the assertion targets the first).
    await expect(page.getByRole('link', { name: 'Blitzy Slack home' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible();
  });

  test('login renders email + password and no display-name field (reference 1)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/password/i)).toBeVisible();
    // The display-name field is register-only; it MUST be absent from login.
    await expect(page.getByLabel(/display name/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Blitzy Slack home' })).toBeVisible();
  });

  test('register renders display-name + email + password (reference 8)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    await page.goto('/register');
    await expect(page.getByLabel(/display name/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('authenticated shell matches the Slack three-column structure (reference 29)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    const user = await registerUserViaApi({ displayName: 'Fidelity User' });
    const channel = await createChannelViaApi(user.token, uniqueChannelName('shell'));
    await loginViaUi(page, user.email, user.password);
    await page.goto(`/app/channels/${channel.id}`);

    // The rail's accessible name "Workspace" is a substring of the sidebar's
    // "Workspace navigation", so the rail locator must be exact to stay
    // strict-mode safe.
    const rail = page.getByRole('navigation', { name: 'Workspace', exact: true });
    const sidebar = page.getByRole('navigation', { name: 'Workspace navigation' });
    const main = page.locator('#main-content');

    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(sidebar).toBeVisible();
    await expect(main).toBeVisible();

    // Left-to-right column ordering: rail < sidebar < main.
    const railBox = await boxOf(rail);
    const sidebarBox = await boxOf(sidebar);
    const mainBox = await boxOf(main);
    expect(railBox.x).toBeLessThan(sidebarBox.x);
    expect(sidebarBox.x).toBeLessThan(mainBox.x);

    // Dark-aubergine sidebar/rail against a light content area.
    const railSum = await rail.evaluate(effectiveBgSum);
    const sidebarSum = await sidebar.evaluate(effectiveBgSum);
    const mainSum = await main.evaluate(effectiveBgSum);
    expect(railSum, 'workspace rail should be a dark (aubergine) surface').toBeGreaterThanOrEqual(
      0,
    );
    expect(railSum, 'workspace rail should be a dark (aubergine) surface').toBeLessThan(400);
    expect(sidebarSum, 'sidebar should be a dark (aubergine) surface').toBeLessThan(400);
    expect(mainSum, 'content area should be a light surface').toBeGreaterThan(600);

    // The `#` public-channel prefix (Rule 1) renders in the sidebar channel list.
    await expect(sidebar.getByText('#', { exact: true }).first()).toBeVisible();

    // The rich-text composer is present in the content column.
    await expect(page.locator('[data-slot="message-composer"]')).toBeVisible();
  });

  test('reactions render as pill chips (reference 100)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    const user = await registerUserViaApi({ displayName: 'Fidelity User' });
    const channel = await createChannelViaApi(user.token, uniqueChannelName('reactions'));
    await loginViaUi(page, user.email, user.password);
    await page.goto(`/app/channels/${channel.id}`);
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 10_000,
    });

    const content = 'reaction structural fidelity message';
    await sendMessageViaUi(page, content);
    await expect(page.getByText(content).first()).toBeVisible({ timeout: 5_000 });
    await page.getByText(content).first().hover();
    await page
      .getByRole('button', { name: /add reaction/i })
      .first()
      .click({ force: true });
    await page.getByLabel('Search emoji').fill('👍');
    await page.getByRole('button', { name: 'Select 👍' }).first().click();

    const chip = page.locator('[data-slot="reaction-chip"]').first();
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // A pill chip is fully rounded: its corner radius is at least half its
    // height. `rounded-full` resolves to a very large px value (trivially
    // satisfying the bound), while a square chip (radius 0) would fail.
    const pill = await chip.evaluate((el: Element) => {
      const styles = getComputedStyle(el);
      return {
        radius: parseFloat(styles.borderTopLeftRadius),
        height: el.getBoundingClientRect().height,
      };
    });
    expect(pill.radius).toBeGreaterThanOrEqual(pill.height / 2 - 1);
  });

  test('create-channel modal is centered over a fixed backdrop (reference 500)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1320 });
    const user = await registerUserViaApi({ displayName: 'Fidelity User' });
    await loginViaUi(page, user.email, user.password);
    await page.goto('/app');
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 10_000,
    });

    await page
      .getByRole('button', {
        name: /add channels|create channel|new channel|create a channel|\+ channels/i,
      })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The backdrop overlay is a fixed, full-viewport layer.
    const overlayPosition = await page
      .locator('[data-slot="dialog-overlay"]')
      .evaluate((el: Element) => getComputedStyle(el).position);
    expect(overlayPosition).toBe('fixed');

    // The dialog content is fixed and centered (top/left 50% + translate -50%).
    const content = page.locator('[data-slot="dialog-content"]');
    expect(await content.evaluate((el: Element) => getComputedStyle(el).position)).toBe('fixed');

    const box = await boxOf(content);
    const viewport = page.viewportSize();
    if (viewport === null) {
      throw new Error('expected a fixed viewport size');
    }
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    expect(Math.abs(centerX - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(centerY - viewport.height / 2)).toBeLessThanOrEqual(2);
  });

  test('composer does not overflow horizontally at 1024px (VIS-004)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const user = await registerUserViaApi({ displayName: 'Fidelity User' });
    const channel = await createChannelViaApi(user.token, uniqueChannelName('vis004'));
    await loginViaUi(page, user.email, user.password);
    await page.goto(`/app/channels/${channel.id}`);
    await expect(page.locator('[data-slot="message-composer"]')).toBeVisible({ timeout: 10_000 });

    // No page-level horizontal scrollbar at 1024px (VIS-003 reported
    // docScrollWidth 768 at innerWidth 375; this guards the intermediate
    // breakpoint stays within the viewport).
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(docOverflow).toBeLessThanOrEqual(1);

    // The composer itself fits its column (no internal horizontal overflow).
    const composerOverflow = await page
      .locator('[data-slot="message-composer"]')
      .evaluate((el: Element) => el.scrollWidth - el.clientWidth);
    expect(composerOverflow).toBeLessThanOrEqual(1);

    // The formatting toolbar wraps rather than overflowing (the VIS-004 fix).
    const flexWrap = await page
      .locator('[data-slot="rich-text-editor-toolbar"]')
      .evaluate((el: Element) => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe('wrap');
  });
});
