/**
 * packages/web/test/e2e/dms.spec.ts
 *
 * Direct-message flow E2E suite. It exercises the 1:1 DM surface end to end:
 *
 *   1. Starting a DM        — a coworker is found through the sidebar people
 *                             picker and the conversation opens at /app/dms/:dmId.
 *   2. Sending Messages     — a message posted through the composer appears in
 *                             the DM timeline (the same Message model channels use).
 *   3. Real-Time Delivery   — two authenticated clients in separate browser
 *                             contexts exchange messages over Socket.io (the
 *                             dm:<id> room), each arriving sub-second (Rule 2).
 *   4. Persistence & Reload — a DM survives navigating away and back, and its
 *                             history rehydrates after a full page refresh.
 *   5. Edge Cases           — POST /api/dms rejects a non-existent participant
 *                             (404/400) and a malformed, non-CUID id (400, Zod).
 *
 * UI flows drive the browser through the `page` (and `browser`) fixtures; the
 * deterministic request-validation assertions call POST /api/dms directly.
 * Every user is provisioned through POST /api/auth/register (Rule 4 — never a
 * direct DB insert) with a unique random identity, so the suite is safe under
 * Playwright's `fullyParallel` execution. No message is ever inserted directly
 * into the database — seeding always travels through the public API.
 */

import {
  test,
  expect,
  registerUserViaApi,
  loginViaUi,
  sendMessageViaUi,
  type RegisteredUser,
} from './fixtures';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Resolve the API origin at call time from the Vite env, with a dev fallback. */
function resolveApiUrl(): string {
  return process.env.VITE_API_URL ?? 'http://localhost:3000';
}

/**
 * Provision two fresh, isolated users via the registration API (Rule 4 — never
 * a direct DB insert). Each {@link registerUserViaApi} call generates a unique
 * random email and display name, so the pair never collides under parallel
 * execution. Both records are returned typed as {@link RegisteredUser} so the
 * cross-user DM scenarios can drive one browser client as each participant.
 */
async function registerTwoUsers(): Promise<{ user1: RegisteredUser; user2: RegisteredUser }> {
  const [user1, user2] = await Promise.all([registerUserViaApi(), registerUserViaApi()]);
  return { user1, user2 };
}

/**
 * Start (or resolve the existing) 1:1 DM with `targetUserId` by calling
 * POST /api/dms with a Bearer token. Per AAP §0.4.4 a conversation is unique per
 * participant pair, so repeat calls return the same DM id (idempotent). The
 * response body is narrowed to the only field this suite reads — the DM id used
 * to address the /app/dms/:dmId route and the `dm:<id>` Socket.io room.
 *
 * @param token - JWT Bearer token of the initiating user
 * @param targetUserId - the other participant's user id
 * @returns the created (or existing) DM id
 */
async function startDmViaApi(token: string, targetUserId: string): Promise<{ id: string }> {
  const response = await fetch(`${resolveApiUrl()}/api/dms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ targetUserId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to start DM: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Direct Messages', () => {
  test.describe('Starting a DM', () => {
    test('starts a 1:1 DM with another user via the UI', async ({ page }) => {
      const { user1, user2 } = await test.step('Register two isolated users via the API', () =>
        registerTwoUsers());

      await test.step('Log in as the first user', async () => {
        await loginViaUi(page, user1.email, user1.password);
      });

      await test.step('Open the people picker and select the coworker', async () => {
        // Open the people picker from the DM section of the sidebar. The exact
        // label varies with the layout, so several Slack-equivalent affordances
        // are matched; `.first()` guards against an accidental duplicate match.
        const addDmButton = page
          .getByRole('button', {
            name: /add coworkers|new direct message|new dm|\+ direct messages|message someone/i,
          })
          .first();
        await addDmButton.click();

        // The picker surfaces as a shadcn Dialog or a Command combobox — accept
        // either rather than asserting a specific primitive (CSS-resilient).
        const picker = page.getByRole('dialog').or(page.getByRole('combobox')).first();
        await expect(picker).toBeVisible({ timeout: 5_000 });

        // Search for the second user by their unique display name.
        const searchInput = picker.getByRole('textbox').or(picker.getByRole('searchbox')).first();
        await searchInput.fill(user2.displayName);

        // The match renders as a selectable option or button; pick whichever the
        // layout exposes.
        await page
          .getByRole('option', { name: new RegExp(user2.displayName, 'i') })
          .or(page.getByRole('button', { name: new RegExp(user2.displayName, 'i') }))
          .first()
          .click();
      });

      await test.step('Confirm the DM conversation opened for the coworker', async () => {
        // Selecting the coworker opens the conversation at /app/dms/:dmId.
        await page.waitForURL(/\/app\/dms\/.+/, { timeout: 10_000 });

        // The DM header identifies the other participant.
        await expect(page.getByText(new RegExp(user2.displayName, 'i')).first()).toBeVisible({
          timeout: 5_000,
        });
      });
    });
  });

  test.describe('Sending Messages in a DM', () => {
    test('sends and receives messages within a DM', async ({ page }) => {
      const { user1, user2 } = await test.step('Register two users', () => registerTwoUsers());

      // Provision the DM through the API for a deterministic starting point.
      const dm = await test.step('Provision the DM via the API', () =>
        startDmViaApi(user1.token, user2.userId));

      await test.step('Log in and open the DM, waiting for the composer', async () => {
        await loginViaUi(page, user1.email, user1.password);
        await page.goto(`/app/dms/${dm.id}`);
        // The composer must be ready before a message can be sent.
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Send a message and see it in the DM timeline', async () => {
        const content = `dm-msg-${Date.now()}`;
        await sendMessageViaUi(page, content);
        await expect(page.getByText(content)).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Real-Time Delivery (DM)', () => {
    test('delivers DM messages bidirectionally between two clients', async ({ browser }) => {
      const { user1, user2 } = await test.step('Register two users', () => registerTwoUsers());
      const dm = await test.step('Provision the DM via the API', () =>
        startDmViaApi(user1.token, user2.userId));

      // Two isolated contexts model two real participants on separate machines.
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      try {
        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        await test.step('Log both participants in and open the same DM', async () => {
          await loginViaUi(page1, user1.email, user1.password);
          await loginViaUi(page2, user2.email, user2.password);

          await page1.goto(`/app/dms/${dm.id}`);
          await page2.goto(`/app/dms/${dm.id}`);

          await expect(page1.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
          await expect(page2.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
        });

        await test.step('user1 → user2 arrives in real time over Socket.io', async () => {
          const msg1 = `from-user1-${Date.now()}`;
          await sendMessageViaUi(page1, msg1);
          await expect(page2.getByText(msg1)).toBeVisible({ timeout: 2_000 });
        });

        await test.step('user2 → user1 is symmetric within the dm:<id> room', async () => {
          const msg2 = `from-user2-${Date.now()}`;
          await sendMessageViaUi(page2, msg2);
          await expect(page1.getByText(msg2)).toBeVisible({ timeout: 2_000 });
        });
      } finally {
        // Always release both contexts, even if an assertion above fails.
        await context1.close();
        await context2.close();
      }
    });
  });

  test.describe('Persistence and Reload', () => {
    test('DM persists across navigation away and back', async ({ page }) => {
      const { user1, user2 } = await test.step('Register two users', () => registerTwoUsers());
      const dm = await test.step('Provision the DM via the API', () =>
        startDmViaApi(user1.token, user2.userId));

      const content = `persist-${Date.now()}`;
      await test.step('Log in, open the DM, and post a message', async () => {
        await loginViaUi(page, user1.email, user1.password);
        await page.goto(`/app/dms/${dm.id}`);
        await sendMessageViaUi(page, content);
        await expect(page.getByText(content)).toBeVisible({ timeout: 5_000 });
      });

      await test.step('Navigate away to the workspace home', async () => {
        await page.goto('/app');
        await expect(page).not.toHaveURL(new RegExp(`/app/dms/${dm.id}`));
      });

      await test.step('Return to the DM and confirm the message persisted', async () => {
        // Return through the sidebar DM list when the link is present; otherwise
        // fall back to a direct navigation. `waitFor` gives a typed, timed
        // visibility probe (Locator.isVisible takes no timeout option).
        const dmLink = page.getByRole('link', { name: new RegExp(user2.displayName, 'i') }).first();
        const dmLinkVisible = await dmLink
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (dmLinkVisible) {
          await dmLink.click();
        } else {
          await page.goto(`/app/dms/${dm.id}`);
        }

        // The previously sent message is still part of the conversation.
        await expect(page.getByText(content)).toBeVisible({ timeout: 5_000 });
      });
    });

    test('DM message history reloads after page refresh via cursor pagination', async ({
      page,
    }) => {
      const { user1, user2 } = await test.step('Register two users', () => registerTwoUsers());
      const dm = await test.step('Provision the DM via the API', () =>
        startDmViaApi(user1.token, user2.userId));

      const content = `reload-${Date.now()}`;
      await test.step('Log in, open the DM, and post a message', async () => {
        await loginViaUi(page, user1.email, user1.password);
        await page.goto(`/app/dms/${dm.id}`);
        await sendMessageViaUi(page, content);
        await expect(page.getByText(content)).toBeVisible({ timeout: 5_000 });
      });

      await test.step('Reload and confirm the timeline rehydrates from history', async () => {
        // A full reload must rehydrate the timeline from persisted history.
        await page.reload();
        await expect(page.getByText(content)).toBeVisible({ timeout: 10_000 });
      });
    });
  });

  test.describe('Edge Cases', () => {
    test('rejects starting a DM with a non-existent user id', async () => {
      const user = await test.step('Register a user', () => registerUserViaApi());

      await test.step('POST /api/dms with an unowned CUID is rejected (400/404)', async () => {
        const apiUrl = resolveApiUrl();
        // A syntactically-valid CUID that no user owns. Implementations may answer
        // 404 (not found) or 400 (rejected at validation); both are acceptable.
        const fakeUserId = 'cl0000000000000000000000';

        const response = await fetch(`${apiUrl}/api/dms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({ targetUserId: fakeUserId }),
        });

        expect([400, 404]).toContain(response.status);
      });
    });

    test('rejects starting a DM with malformed user id (Zod validation)', async () => {
      const user = await test.step('Register a user', () => registerUserViaApi());

      await test.step('POST /api/dms with a non-CUID id is rejected (400, Zod)', async () => {
        const apiUrl = resolveApiUrl();
        // `startDmSchema` validates `targetUserId` as a CUID, so a malformed
        // value must be rejected with 400 before any DB lookup.
        const response = await fetch(`${apiUrl}/api/dms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({ targetUserId: 'not-a-cuid' }),
        });

        expect(response.status).toBe(400);
      });
    });
  });
});
