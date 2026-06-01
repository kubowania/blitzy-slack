/**
 * packages/web/test/e2e/messaging.spec.ts
 *
 * Channel messaging and real-time delivery E2E suite. It exercises the core
 * messaging surface end to end, driving the browser through the augmented
 * `page`/`browser` fixtures and provisioning users and channels through the
 * public API (Rule 4 — never a direct DB insert):
 *
 *   1. Channel Creation     — a public channel is created through the sidebar
 *                             "+ Add channels" shadcn Dialog and then appears in
 *                             the channel list (Rule 1 `#`-prefixed name).
 *   2. Seeded Admin Access  — the registration-seeded admin (admin@test.com)
 *                             authenticates through the standard login form.
 *   3. Sending Messages     — a message typed into the composer renders in the
 *                             channel timeline.
 *   4. Real-Time Delivery   — two authenticated clients in separate browser
 *                             contexts exchange a message over Socket.io within
 *                             the Gate 9 < 500 ms budget, and an emoji reaction
 *                             propagates between them (Rule 2 — no polling).
 *   5. Threads              — a reply posted in the shadcn Sheet thread panel
 *                             renders within the panel (thread:<parentId> room).
 *   6. Infinite Scroll      — PAGE_SIZE + 5 messages are seeded so scrolling to
 *                             the top loads the older cursor page.
 *   7. Edge Cases           — empty messages are not posted, an over-length body
 *                             (> MAX_MESSAGE_LENGTH) is never accepted, and a
 *                             dropped network reconnects so messaging resumes.
 *
 * Each test provisions isolated, randomly-named users and channels so the suite
 * is safe under Playwright's `fullyParallel` execution. No message is ever
 * inserted directly into the database — seeding always travels through the API.
 */

import {
  test,
  expect,
  loginAsAdmin,
  loginViaUi,
  registerUserViaApi,
  createChannelViaApi,
  sendMessageViaUi,
  uniqueChannelName,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} from './fixtures';
import { PAGE_SIZE, MAX_MESSAGE_LENGTH } from '@app/shared/constants/limits';

/**
 * Accessible role/name selector for the channel/thread message composer. It
 * mirrors the locator used by `sendMessageViaUi` so timing-sensitive tests can
 * fill and submit in separate steps. `.first()` guards against an incidental
 * second textbox (e.g. a header search field) matching the role.
 */
const COMPOSER_NAME = /message|compose/i;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Resolve the API origin at call time from the Vite env, with a dev fallback. */
function resolveApiUrl(): string {
  return process.env.VITE_API_URL ?? 'http://localhost:3000';
}

/**
 * Join a public channel by calling POST /api/channels/:id/join with a Bearer
 * token. Public channels are joinable without an invitation (AAP §0.1.1), which
 * places the joining user into the shared `channel:<id>` Socket.io room used by
 * the cross-context real-time tests (AAP §0.4.5).
 *
 * @param token - JWT Bearer token of the joining user
 * @param channelId - id of the channel to join
 */
async function joinChannelViaApi(token: string, channelId: string): Promise<void> {
  const response = await fetch(`${resolveApiUrl()}/api/channels/${channelId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `joinChannelViaApi failed: HTTP ${response.status} ${response.statusText} — ${body}`,
    );
  }
}

/**
 * Seed a single channel message through the REST API (Rule 4 — never a direct
 * DB insert). The nested channel-scoped route is preferred; if it is not
 * available the top-level messages route carrying `channelId` is used as a
 * fallback. Only the response status is inspected, so no response body is read.
 *
 * @param token - JWT Bearer token of the author
 * @param channelId - target channel id
 * @param content - message body to persist
 */
async function seedChannelMessageViaApi(
  token: string,
  channelId: string,
  content: string,
): Promise<void> {
  const apiUrl = resolveApiUrl();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Preferred contract: the nested, channel-scoped messages route.
  const nested = await fetch(`${apiUrl}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  });
  if (nested.ok) {
    return;
  }

  // Fallback contract: the top-level messages route carrying `channelId`.
  const topLevel = await fetch(`${apiUrl}/api/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId, content }),
  });
  if (!topLevel.ok) {
    const body = await topLevel.text();
    throw new Error(
      `seedChannelMessageViaApi failed: HTTP ${topLevel.status} ${topLevel.statusText} — ${body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Channel Messaging', () => {
  test.describe('Channel Creation', () => {
    test('creates a public channel via the "+ Add channels" dialog', async ({ page }) => {
      const channelName = uniqueChannelName('create');

      await test.step('Sign in as the seeded admin', async () => {
        await loginAsAdmin(page);
      });

      await test.step('Open the "+ Add channels" dialog and submit a new channel', async () => {
        // Open the sidebar's add-channel affordance. The label varies across the
        // reference screenshots, so several Slack-equivalent names are matched.
        await page
          .getByRole('button', {
            name: /add channels|create channel|new channel|create a channel|\+ channels/i,
          })
          .first()
          .click();

        // The shadcn Dialog renders with role="dialog".
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 5_000 });

        // The channel-name field is a shadcn Input wired through a Form/Label.
        await dialog.getByLabel(/name|channel name/i).fill(channelName);
        await dialog
          .getByRole('button', { name: /create|submit|save/i })
          .first()
          .click();

        // The dialog dismisses on success.
        await expect(dialog).not.toBeVisible({ timeout: 5_000 });
      });

      await test.step('Assert the new channel appears in the sidebar list', async () => {
        // Per Rule 1 the name is rendered with a `#` prefix, so a substring match
        // on the generated name is used rather than an exact-string match. The
        // sidebar channel row is a shadcn Item exposing role="button" (not a link),
        // so it is matched by the button role.
        await expect(
          page.getByRole('button', { name: new RegExp(channelName) }).first(),
        ).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Seeded Admin Access', () => {
    test('signs in with the registration-seeded admin credentials', async ({ page }) => {
      await test.step('Authenticate through the login form as the seeded admin', async () => {
        // Per Rule 4, the seeded admin (ADMIN_EMAIL / ADMIN_PASSWORD constants) is
        // created exclusively through POST /api/auth/register by `make seed`; it
        // then authenticates through the standard login form like any other user.
        await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      });

      await test.step('Assert an authenticated /app route is reached', async () => {
        // Reaching an authenticated /app route confirms the seed + login path.
        await expect(page).toHaveURL(/\/app(\/.*)?$/);
      });
    });
  });

  test.describe('Sending Messages', () => {
    test('sends a message and renders it in the timeline', async ({ page }) => {
      const { user, channel, channelName } =
        await test.step('Provision a user and channel via the API', async () => {
          // API-driven setup is faster and more deterministic than driving the
          // creation dialog; the UI is exercised only for the behaviour under test.
          const provisionedUser = await registerUserViaApi();
          const name = uniqueChannelName('msg');
          const provisionedChannel = await createChannelViaApi(provisionedUser.token, name);
          return { user: provisionedUser, channel: provisionedChannel, channelName: name };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        // The channel header confirms the view mounted before sending.
        await expect(
          page.getByRole('heading', { name: new RegExp(channelName) }).first(),
        ).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Send a message and assert it renders in the timeline', async () => {
        const content = `hello-world-${Date.now()}`;
        await sendMessageViaUi(page, content);
        await expect(page.getByText(content).first()).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Real-Time Delivery (Cross-Browser)', () => {
    test('delivers a message to a second client within 500ms (Gate 9)', async ({ browser }) => {
      const { user1, user2, channel } =
        await test.step('Provision two users and a shared public channel', async () => {
          const provisionedUser1 = await registerUserViaApi();
          const provisionedUser2 = await registerUserViaApi();
          const channelName = uniqueChannelName('realtime');
          const provisionedChannel = await createChannelViaApi(
            provisionedUser1.token,
            channelName,
            false,
          );
          // The second user joins the public channel so both share the
          // `channel:<id>` Socket.io room (AAP §0.4.5).
          await joinChannelViaApi(provisionedUser2.token, provisionedChannel.id);
          return {
            user1: provisionedUser1,
            user2: provisionedUser2,
            channel: provisionedChannel,
          };
        });

      // Two isolated browser contexts model two users on two machines — the only
      // faithful way to exercise the Rule 2 Socket.io + Redis-adapter path.
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      try {
        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        const composer1 =
          await test.step('Sign both clients in and open the channel on each', async () => {
            await loginViaUi(page1, user1.email, user1.password);
            await loginViaUi(page2, user2.email, user2.password);

            await page1.goto(`/app/channels/${channel.id}`);
            await page2.goto(`/app/channels/${channel.id}`);

            // A visible composer on each page signals that the channel view (and
            // its socket subscription) has mounted on both clients.
            const composer = page1.getByRole('textbox', { name: COMPOSER_NAME }).first();
            await expect(composer).toBeVisible({ timeout: 10_000 });
            await expect(page2.getByRole('textbox', { name: COMPOSER_NAME }).first()).toBeVisible({
              timeout: 10_000,
            });
            return composer;
          });

        await test.step('Send from client 1 and assert delivery to client 2 under the 500 ms budget', async () => {
          // Fill BEFORE timing so the measured window is purely send -> receive.
          const content = `realtime-${Date.now()}`;
          await composer1.fill(content);
          const sendTime = Date.now();
          await composer1.press('Enter');

          // The message must reach the SECOND client over Socket.io, not a reload.
          await expect(page2.getByText(content).first()).toBeVisible({ timeout: 2_000 });
          const deltaMs = Date.now() - sendTime;

          // Gate 9 budget is < 500 ms. The measured delta also includes
          // Playwright's web-first assertion polling, so the true socket latency
          // is lower than this number. If CI hardware makes this flaky, the
          // budget may be relaxed to 1000 ms with a /docs/decision-log.md entry.
          expect(deltaMs).toBeLessThan(500);
        });
      } finally {
        // Always release both contexts, even if an assertion above fails.
        await context1.close();
        await context2.close();
      }
    });

    test('delivers an emoji reaction to a second client in real time', async ({ browser }) => {
      const { user1, user2, channel } =
        await test.step('Provision two users and a shared public channel', async () => {
          const provisionedUser1 = await registerUserViaApi();
          const provisionedUser2 = await registerUserViaApi();
          const channelName = uniqueChannelName('react');
          const provisionedChannel = await createChannelViaApi(
            provisionedUser1.token,
            channelName,
            false,
          );
          await joinChannelViaApi(provisionedUser2.token, provisionedChannel.id);
          return {
            user1: provisionedUser1,
            user2: provisionedUser2,
            channel: provisionedChannel,
          };
        });

      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      try {
        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        await test.step('Sign both clients in and open the channel on each', async () => {
          await loginViaUi(page1, user1.email, user1.password);
          await loginViaUi(page2, user2.email, user2.password);

          await page1.goto(`/app/channels/${channel.id}`);
          await page2.goto(`/app/channels/${channel.id}`);

          // A visible composer on each page signals that the channel view (and its
          // Socket.io room subscription) has mounted on BOTH clients. Without this
          // gate, client 1 can broadcast the message before client 2 has joined the
          // `channel:<id>` room, and Socket.io does not replay missed emits — so the
          // peer would never receive that message (a cross-client race that mirrors
          // the sibling real-time message test's readiness gate).
          await expect(page1.getByRole('textbox', { name: COMPOSER_NAME }).first()).toBeVisible({
            timeout: 10_000,
          });
          await expect(page2.getByRole('textbox', { name: COMPOSER_NAME }).first()).toBeVisible({
            timeout: 10_000,
          });
        });

        const content = await test.step('Post a message visible to both clients', async () => {
          const posted = `reaction-target-${Date.now()}`;
          await sendMessageViaUi(page1, posted);
          await expect(page1.getByText(posted).first()).toBeVisible({ timeout: 5_000 });
          await expect(page2.getByText(posted).first()).toBeVisible({ timeout: 5_000 });
          return posted;
        });

        await test.step('React on client 1 and assert the reaction propagates to client 2', async () => {
          // Hovering the message row reveals its floating action toolbar (the
          // :hover state applies to the ancestor row), exposing the add-reaction
          // control. The toolbar floats above the row (absolute, negative top
          // offset), so the trigger is force-clicked: it is visible and
          // pointer-interactive on hover, but Playwright's strict actionability
          // check otherwise treats the overlapping row as intercepting the click.
          await page1.getByText(content).first().hover();
          await page1
            // The message action is labelled exactly "Add reaction". Matching only
            // that name avoids the composer's "Add emoji" control (which opens an
            // insert-into-composer picker, not a reaction picker): a broader
            // /react|emoji/ alternation matches both buttons, so `.first()` can grab
            // the wrong one and the reaction EmojiPicker never opens.
            .getByRole('button', { name: /add reaction/i })
            .first()
            .click({ force: true });

          // The emoji grid (a project-local component inside a shadcn Popover,
          // AAP §0.5.4) opens on the default category, so search by the emoji
          // glyph — the picker filters by the character itself — to render the
          // target regardless of which category tab is active, then select it by
          // its "Select <emoji>" accessible name.
          await page1.getByLabel('Search emoji').fill('👋');
          await page1.getByRole('button', { name: 'Select 👋' }).first().click();

          // The reaction pill shows for the actor and propagates to the peer via
          // the `reaction:added` event (Rule 2) without any reload.
          await expect(page1.getByText('👋').first()).toBeVisible({ timeout: 2_000 });
          await expect(page2.getByText('👋').first()).toBeVisible({ timeout: 2_000 });
        });
      } finally {
        await context1.close();
        await context2.close();
      }
    });
  });

  test.describe('Threads', () => {
    test('opens the thread Sheet and posts a reply', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('thread'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
      });

      const parentContent = await test.step('Post a parent message', async () => {
        const parent = `thread-parent-${Date.now()}`;
        await sendMessageViaUi(page, parent);
        await expect(page.getByText(parent).first()).toBeVisible({ timeout: 5_000 });
        return parent;
      });

      const thread = await test.step('Open the thread Sheet on the parent message', async () => {
        // Reveal the toolbar on the parent message and open its thread. The
        // regex deliberately omits the bare "thread" token: this test creates a
        // sidebar channel via uniqueChannelName('thread') ("thread-…"), whose
        // role="button" row precedes the message toolbar in the DOM and would be
        // matched first by `.first()`. The message action is labelled
        // "Reply in thread" (MessageItem toolbar), so the tightened regex targets
        // only the reply control.
        await page.getByText(parentContent).first().hover();
        await page
          .getByRole('button', { name: /reply in thread|start a thread/i })
          .first()
          // The reply control sits in the message's floating hover toolbar
          // (absolute, negative top offset); force the click so Playwright does not
          // treat the overlapping message row as intercepting the visible,
          // hover-enabled trigger (same rationale as the add-reaction control).
          .click({ force: true });

        // The thread panel is a shadcn Sheet (role="dialog"); it is the most
        // recently opened dialog, so `.last()` selects it deterministically.
        const panel = page.getByRole('dialog').last();
        await expect(panel).toBeVisible({ timeout: 5_000 });
        return panel;
      });

      await test.step('Post a reply in the Sheet and assert it renders in the panel', async () => {
        // The Sheet hosts its own composer; the reply posts into the
        // `thread:<parentId>` room and renders within the panel.
        const replyContent = `thread-reply-${Date.now()}`;
        const threadComposer = thread.getByRole('textbox').first();
        await threadComposer.fill(replyContent);
        await threadComposer.press('Enter');

        await expect(thread.getByText(replyContent).first()).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Infinite Scroll / Pagination', () => {
    test('loads older messages when scrolling to the top of the timeline', async ({ page }) => {
      // Seeding a full page plus a few extra and then loading older history is
      // the slowest scenario in the suite; allow extra wall-clock time.
      test.setTimeout(60_000);

      const { user, channel, total } =
        await test.step('Provision a channel and seed PAGE_SIZE + 5 messages via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('scroll'),
          );
          // Seed PAGE_SIZE + 5 messages through the API (Rule 4 — never a direct
          // DB insert) so a second cursor page exists behind the newest PAGE_SIZE.
          const seedTotal = PAGE_SIZE + 5;
          for (let i = 0; i < seedTotal; i++) {
            await seedChannelMessageViaApi(
              provisionedUser.token,
              provisionedChannel.id,
              `seed-${i}`,
            );
          }
          return { user: provisionedUser, channel: provisionedChannel, total: seedTotal };
        });

      await test.step('Sign in and assert the newest page renders first', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        // The newest page renders first; the most recent seeded message is shown.
        await expect(page.getByText(`seed-${total - 1}`).first()).toBeVisible({
          timeout: 10_000,
        });
      });

      await test.step('Scroll to the top and assert the older cursor page loads', async () => {
        // The scrollable element is the Radix ScrollArea viewport
        // ([data-slot="scroll-area-viewport"]) inside the message list
        // ([data-slot="message-list"]); the role="log" wrapper nested within it is
        // not itself scrollable. Scrolling the viewport to the top trips the
        // IntersectionObserver sentinel that requests the previous (older) cursor page.
        const viewport = page
          .locator('[data-slot="message-list"] [data-slot="scroll-area-viewport"]')
          .first();
        await viewport.evaluate((el) => {
          el.scrollTo({ top: 0 });
        });

        // The oldest seeded message (absent from the first page) becomes visible
        // once the older page is prepended.
        await expect(page.getByText('seed-0').first()).toBeVisible({ timeout: 10_000 });
      });
    });
  });

  test.describe('Edge Cases', () => {
    test('does not send an empty message', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('empty'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      const composer =
        await test.step('Sign in, open the channel, and locate the composer', async () => {
          await loginViaUi(page, user.email, user.password);
          await page.goto(`/app/channels/${channel.id}`);
          const composerLocator = page.getByRole('textbox', { name: COMPOSER_NAME }).first();
          await expect(composerLocator).toBeVisible({ timeout: 10_000 });
          return composerLocator;
        });

      await test.step('Press Enter on the empty composer and assert nothing is posted', async () => {
        // Pressing Enter on an empty composer must be a no-op: nothing is posted
        // and the composer remains empty (a textarea-backed shadcn composer).
        await composer.focus();
        await composer.press('Enter');
        await expect(composer).toHaveValue('');
      });
    });

    test('rejects a message longer than MAX_MESSAGE_LENGTH', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('long'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      const composer =
        await test.step('Sign in, open the channel, and locate the composer', async () => {
          await loginViaUi(page, user.email, user.password);
          await page.goto(`/app/channels/${channel.id}`);
          const composerLocator = page.getByRole('textbox', { name: COMPOSER_NAME }).first();
          await expect(composerLocator).toBeVisible({ timeout: 10_000 });
          return composerLocator;
        });

      await test.step('Submit an over-length body and assert it is never posted', async () => {
        const tooLong = 'a'.repeat(MAX_MESSAGE_LENGTH + 1);
        await composer.fill(tooLong);
        await composer.press('Enter');

        // Whether the client blocks submit, truncates the input, or the API
        // returns 400, the exact over-length body must never appear as a posted
        // message. A brief settle absorbs any async post attempt before this
        // negative assertion (the documented exception for "did not happen").
        await page.waitForTimeout(1_000);
        await expect(page.getByText(tooLong)).toHaveCount(0);
      });
    });

    test('reconnects Socket.io after a network drop', async ({ page, context }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('reconnect'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
      });

      await test.step('Confirm baseline send works while connected', async () => {
        // Baseline: a message sends and renders while connected.
        const before = `before-disconnect-${Date.now()}`;
        await sendMessageViaUi(page, before);
        await expect(page.getByText(before).first()).toBeVisible({ timeout: 5_000 });
      });

      await test.step('Drop and restore the network connection', async () => {
        // Drop the network so the client observes a disconnect, then restore it.
        // The short offline wait covers a network-state change that has no UI
        // signal; reconnection itself is verified by the behaviour below.
        await context.setOffline(true);
        await page.waitForTimeout(2_000);
        await context.setOffline(false);
      });

      await test.step('Assert messaging resumes after Socket.io reconnects', async () => {
        // After the socket re-establishes, a freshly sent message must still flow
        // over Socket.io. `toPass` retries the send until reconnection completes,
        // replacing a brittle fixed wait with behaviour-driven polling.
        const after = `after-reconnect-${Date.now()}`;
        await expect(async () => {
          await sendMessageViaUi(page, after);
          await expect(page.getByText(after).first()).toBeVisible({ timeout: 4_000 });
        }).toPass({ timeout: 20_000 });
      });
    });
  });
});
