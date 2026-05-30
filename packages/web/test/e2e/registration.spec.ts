/**
 * packages/web/test/e2e/registration.spec.ts
 *
 * Authentication-flow E2E suite — the first spec in the folder's implementation
 * order. It drives the public auth surface end to end through the browser:
 *
 *   1. Registration         — a fresh, uniquely-identified user signs up through
 *                             the /register form and lands on the authenticated
 *                             /app shell (the three-column workspace).
 *   2. Duplicate Email      — re-submitting an already-registered email keeps the
 *                             visitor on /register and surfaces the 409 conflict
 *                             through a shadcn Alert (role="alert").
 *   3. Validation Edges     — an invalid email format and a password shorter than
 *                             MIN_PASSWORD_LENGTH are both rejected client-side
 *                             (HTML5 and/or react-hook-form + Zod), never reaching
 *                             /app.
 *   4. Login                — the Rule 4-seeded admin (admin@test.com) signs in and
 *                             reaches /app; an incorrect password is rejected and
 *                             surfaces an error.
 *   5. Logout               — an authenticated session is torn down and the visitor
 *                             returns to an unauthenticated route.
 *   6. Round Trip           — a newly-registered user can authenticate again after
 *                             the client session is cleared.
 *
 * All flows drive the browser through the augmented `page` fixture re-exported by
 * ./fixtures (never @playwright/test directly). New users are created exclusively
 * through the public registration flow (Rule 4 — never a direct DB insert); the
 * seeded admin is provisioned at setup time by scripts/seed-via-api.ts. Each test
 * is fully independent and safe under Playwright's `fullyParallel` execution: the
 * registration helper mints a unique email per call, so concurrent workers never
 * collide on the email-unique constraint. Assertions deliberately avoid coupling
 * to exact API copy or DOM structure — they assert URL transitions and ARIA roles
 * so the suite stays resilient to UI refinement.
 */

import {
  test,
  expect,
  loginAsAdmin,
  loginViaUi,
  registerUserViaUi,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} from './fixtures';
import type { Page } from '@playwright/test';
import { MIN_PASSWORD_LENGTH } from '@app/shared/constants/limits';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Tear down all client-side authentication state so a subsequent navigation is
 * treated as an anonymous visitor: clears the context cookies (where a session
 * cookie may live) and both web-storage areas (where a JWT is typically held).
 *
 * Web storage is origin-scoped, so the page MUST already be on a same-origin
 * document — call this only after a successful login/registration has landed on
 * an /app route.
 *
 * @param page - Playwright Page whose client session should be cleared
 */
async function clearClientSession(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Registration & Authentication', () => {
  test.describe('Registration', () => {
    test('registers a new user and redirects to /app', async ({ page }) => {
      await test.step('Submit the registration form with a unique identity', async () => {
        // registerUserViaUi submits the /register form with a unique identity and
        // already waits for the redirect into the authenticated area.
        await registerUserViaUi(page);
      });

      await test.step('Land on the authenticated /app shell', async () => {
        await expect(page).toHaveURL(/\/app(\/.*)?$/);
        // The authenticated shell renders the workspace navigation (the sidebar /
        // workspace rail of the three-column layout). Asserting the navigation role
        // keeps the check resilient to layout refinement.
        await expect(page.getByRole('navigation')).toBeVisible({ timeout: 5_000 });
      });
    });

    test('rejects registration with a duplicate email and surfaces an error', async ({ page }) => {
      // Create the account once, then drop the resulting session so the retry
      // behaves as a brand-new anonymous visitor submitting an existing email.
      const { email, password, displayName } =
        await test.step('Register an account, then clear the session', async () => {
          const credentials = await registerUserViaUi(page);
          await clearClientSession(page);
          return credentials;
        });

      await test.step('Re-submit /register with the already-used email', async () => {
        await page.goto('/register');
        await page.getByLabel(/email/i).fill(email);
        await page.getByLabel(/password/i).fill(password);
        await page.getByLabel(/display name|name/i).fill(displayName);
        await page.getByRole('button', { name: /sign up|register|create account/i }).click();
      });

      await test.step('Stay on /register and surface the 409 conflict alert', async () => {
        // A conflict keeps the visitor on /register (no redirect to /app)...
        await expect(page).toHaveURL(/\/register/);
        // ...and reports the failure through a shadcn Alert, which renders with
        // role="alert". `.first()` guards against an incidental second alert.
        const alert = page.getByRole('alert').first();
        await expect(alert).toBeVisible({ timeout: 5_000 });
        // Match the conflict semantics flexibly rather than the exact API copy.
        await expect(alert).toContainText(/exist|already|conflict|registered/i);
      });
    });

    test('rejects registration with an invalid email format', async ({ page }) => {
      await test.step('Submit /register with a malformed email', async () => {
        await page.goto('/register');
        await page.getByLabel(/email/i).fill('not-an-email');
        await page.getByLabel(/password/i).fill('ValidPassword123!');
        await page.getByLabel(/display name|name/i).fill('Test User');
        await page.getByRole('button', { name: /sign up|register|create account/i }).click();
      });

      await test.step('Remain on /register and never reach /app', async () => {
        // Whether the browser's native :invalid handling blocks the submit or
        // react-hook-form + Zod renders an inline error, the visitor must remain on
        // /register and never reach the authenticated area.
        await expect(page).toHaveURL(/\/register/);
        await expect(page).not.toHaveURL(/\/app/);
      });
    });

    test('rejects registration with a password shorter than the minimum', async ({ page }) => {
      await test.step('Submit /register with a sub-minimum password', async () => {
        // One character below the shared policy floor — the smallest invalid input.
        const tooShort = 'a'.repeat(Math.max(1, MIN_PASSWORD_LENGTH - 1));

        await page.goto('/register');
        await page.getByLabel(/email/i).fill(`shortpw-${Date.now()}@test.com`);
        await page.getByLabel(/password/i).fill(tooShort);
        await page.getByLabel(/display name|name/i).fill('Test User');
        await page.getByRole('button', { name: /sign up|register|create account/i }).click();
      });

      await test.step('Remain on /register and never reach /app', async () => {
        await expect(page).toHaveURL(/\/register/);
        await expect(page).not.toHaveURL(/\/app/);
      });
    });
  });

  test.describe('Login', () => {
    test('logs in with the seeded admin credentials and reaches /app', async ({ page }) => {
      await test.step('Sign in as the Rule 4-seeded admin', async () => {
        // The admin account is seeded via POST /api/auth/register (Rule 4) before
        // the suite runs; loginAsAdmin drives the /login form and waits for /app.
        await loginAsAdmin(page);
      });

      await test.step('Reach the authenticated /app shell', async () => {
        await expect(page).toHaveURL(/\/app(\/.*)?$/);
        await expect(page.getByRole('navigation')).toBeVisible({ timeout: 5_000 });
      });
    });

    test('rejects login with an incorrect password', async ({ page }) => {
      await test.step('Submit /login with a deliberately wrong password', async () => {
        // Derive a guaranteed-wrong password from the real one so the test can never
        // accidentally submit the correct credentials.
        const wrongPassword = `${ADMIN_PASSWORD}_wrong`;

        await page.goto('/login');
        await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
        await page.getByLabel(/password/i).fill(wrongPassword);
        await page.getByRole('button', { name: /sign in|log in/i }).click();
      });

      await test.step('Stay on /login and surface the auth error', async () => {
        // Authentication failure keeps the visitor on /login and surfaces an error.
        await expect(page).toHaveURL(/\/login/);
        await expect(page).not.toHaveURL(/\/app/);
        await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Logout', () => {
    test('logs out and returns to the login screen', async ({ page }) => {
      await test.step('Sign in as the seeded admin', async () => {
        await loginAsAdmin(page);
        await expect(page).toHaveURL(/\/app(\/.*)?$/);
      });

      await test.step('Open the profile/account menu', async () => {
        // The sign-out control lives behind a profile/account menu whose exact label
        // is not fixed by the design spec. Probe a few Slack-equivalent affordances;
        // `Locator.isVisible()` accepts no timeout, so use a `waitFor` probe that
        // resolves to a boolean instead.
        const profileTrigger = page
          .getByRole('button', { name: /profile|user menu|account|you|settings/i })
          .first();
        const triggerVisible = await profileTrigger
          .waitFor({ state: 'visible', timeout: 3_000 })
          .then(() => true)
          .catch(() => false);

        if (triggerVisible) {
          await profileTrigger.click();
        } else {
          // Fall back to the first avatar/icon button (an image- or svg-bearing
          // control), the conventional profile-menu trigger.
          await page
            .getByRole('button')
            .filter({ has: page.locator('img, svg') })
            .first()
            .click();
        }
      });

      await test.step('Activate sign-out and return to an unauthenticated route', async () => {
        // Activate the sign-out item exposed by the shadcn DropdownMenu.
        await page.getByRole('menuitem', { name: /sign out|log out|logout/i }).click();

        // Logging out returns the visitor to an unauthenticated route.
        await page.waitForURL(/\/(login|register)?$/, { timeout: 10_000 });
        await expect(page).not.toHaveURL(/\/app/);
      });
    });
  });

  test.describe('Round-trip re-authentication', () => {
    test('a newly registered user can log in again after the session is cleared', async ({
      page,
    }) => {
      const { email, password } =
        await test.step('Register (auto-authenticates), then clear the session', async () => {
          // Register (which auto-authenticates and lands on /app)...
          const credentials = await registerUserViaUi(page);
          // ...then drop the session so the next login is a genuine fresh sign-in.
          await clearClientSession(page);
          return credentials;
        });

      await test.step('Sign in again with the same credentials', async () => {
        await loginViaUi(page, email, password);
        await expect(page).toHaveURL(/\/app(\/.*)?$/);
      });
    });
  });
});
