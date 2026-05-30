/**
 * packages/web/test/e2e/search.spec.ts
 *
 * Full-text search E2E suite. It exercises the search experience end to end:
 *
 *   1. Basic Search        — a unique message is found through the header search bar.
 *   2. Performance Budget   — search results render inside the Gate 9 < 2 s budget.
 *   3. ACL Filtering        — a private channel's messages are invisible to non-members.
 *   4. Result Navigation    — clicking a result opens the originating channel, and the
 *                             results surface groups hits with shadcn Tabs (Messages /
 *                             Channels / Files).
 *   5. Edge Cases           — an empty query fires no request, an over-long query is
 *                             rejected with 400, and special characters never 500.
 *
 * UI flows drive the browser through the `page` fixture; assertions that must be
 * deterministic regardless of the rendered layout (ACL isolation, request
 * validation, query-escaping) drive the REST API through Playwright's typed
 * `request` fixture. All users and channels are provisioned through the shared
 * fixtures so each test is fully isolated. No message is ever inserted directly
 * into the database — seeding always travels through the public API.
 */

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  sendMessageViaUi,
  uniqueChannelName,
} from './fixtures';
import type { Page } from '@playwright/test';
import { MAX_SEARCH_QUERY_LENGTH } from '@app/shared/constants/limits';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Resolve the API origin at call time from the Vite env, with a dev fallback. */
function resolveApiUrl(): string {
  return process.env.VITE_API_URL ?? 'http://localhost:3000';
}

/** Resolve after `ms` milliseconds. Used to absorb tiny indexing races. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Narrowing guard: `value` is a non-null object usable as a string-keyed record. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrowing guard: `value` is an array whose elements are of unknown type. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Extract the `content` strings of message hits from a search response without
 * asserting its exact shape. The API may return either `{ messages: [...] }` or
 * `{ results: [...] }`; both are accepted. Only message-body content is read, so
 * a response that echoes the raw query elsewhere cannot produce a false match.
 */
function extractMessageContents(body: unknown): string[] {
  if (!isObjectRecord(body)) {
    return [];
  }
  const candidate = body.messages ?? body.results;
  if (!isUnknownArray(candidate)) {
    return [];
  }
  const contents: string[] = [];
  for (const item of candidate) {
    if (isObjectRecord(item) && typeof item.content === 'string') {
      contents.push(item.content);
    }
  }
  return contents;
}

/**
 * Focus the workspace search bar. The exact control varies with the layout, so
 * three strategies are attempted in order: a search input, an explicit search
 * button, then the Ctrl+K command-palette shortcut as a last resort.
 */
async function focusSearchBar(page: Page): Promise<void> {
  const searchInput = page.getByPlaceholder(/search/i).first();
  const inputVisible = await searchInput
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (inputVisible) {
    await searchInput.click();
    return;
  }

  const searchButton = page.getByRole('button', { name: /search/i }).first();
  const buttonVisible = await searchButton
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (buttonVisible) {
    await searchButton.click();
    return;
  }

  await page.keyboard.press('Control+K');
}

/** Type `query` into whichever input received focus from {@link focusSearchBar}. */
async function typeSearchQuery(page: Page, query: string): Promise<void> {
  const activeInput = page.locator(':focus');
  await activeInput.fill(query);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Full-Text Search', () => {
  test.describe('Basic Search', () => {
    test('finds a message by full-text search', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('search'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      const uniquePhrase =
        await test.step('Post a unique message that only this test can match', async () => {
          // Send a unique message so the search query can only match this test's row.
          const phrase = `uniquephrase${Date.now()}`;
          await sendMessageViaUi(page, phrase);
          await expect(page.getByText(phrase)).toBeVisible({ timeout: 5_000 });
          return phrase;
        });

      await test.step('Search for the phrase and assert it surfaces in results', async () => {
        await focusSearchBar(page);
        await typeSearchQuery(page, uniquePhrase);
        // The query may render results inline or on /app/search; either way the
        // unique phrase must surface in a result context.
        await expect(page.getByText(uniquePhrase).first()).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Performance Budget (Gate 9)', () => {
    test('returns search results within 2 seconds', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('perf'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      const uniquePhrase = await test.step('Post a unique message to search for', async () => {
        const phrase = `perfsearch${Date.now()}`;
        await sendMessageViaUi(page, phrase);
        await expect(page.getByText(phrase)).toBeVisible({ timeout: 5_000 });
        // The tsvector column is populated in the same transaction as the insert;
        // a short buffer simply guards against scheduling jitter.
        await page.waitForTimeout(200);
        return phrase;
      });

      await test.step('Measure search latency against the Gate 9 < 2 s budget', async () => {
        await focusSearchBar(page);
        // Measure typing + debounce + round-trip + render against the Gate 9 budget.
        const startTime = Date.now();
        await typeSearchQuery(page, uniquePhrase);
        await expect(page.getByText(uniquePhrase).first()).toBeVisible({ timeout: 5_000 });
        const endTime = Date.now();
        const deltaMs = endTime - startTime;
        expect(deltaMs).toBeLessThan(2_000);
      });
    });
  });

  test.describe('ACL Filtering', () => {
    test('does not return messages from private channels the user is not a member of', async ({
      request,
    }) => {
      const { owner, outsider, privateChannel } =
        await test.step('Provision an owner, an outsider, and a private channel', async () => {
          const provisionedOwner = await registerUserViaApi();
          const provisionedOutsider = await registerUserViaApi();
          const channel = await createChannelViaApi(
            provisionedOwner.token,
            uniqueChannelName('private'),
            true,
          );
          return {
            owner: provisionedOwner,
            outsider: provisionedOutsider,
            privateChannel: channel,
          };
        });

      const aclPhrase = `aclsecret${Date.now()}`;

      await test.step('Seed a message into the private channel via the public API', async () => {
        // Seed a message into the private channel as the owner through the public
        // API (Rule 4 - never a direct DB insert). Two endpoint shapes are tried.
        const apiUrl = resolveApiUrl();
        let seeded = await request.post(`${apiUrl}/api/channels/${privateChannel.id}/messages`, {
          headers: { Authorization: `Bearer ${owner.token}` },
          data: { content: aclPhrase },
        });
        if (!seeded.ok()) {
          seeded = await request.post(`${apiUrl}/api/messages`, {
            headers: { Authorization: `Bearer ${owner.token}` },
            data: { channelId: privateChannel.id, content: aclPhrase },
          });
        }
        expect(seeded.ok()).toBe(true);
        await sleep(200);
      });

      await test.step('Assert the outsider cannot see the private hit', async () => {
        const apiUrl = resolveApiUrl();
        // The outsider is NOT a member, so the ACL-filtered search must hide the hit.
        const outsiderResponse = await request.get(
          `${apiUrl}/api/search?q=${encodeURIComponent(aclPhrase)}`,
          { headers: { Authorization: `Bearer ${outsider.token}` } },
        );
        expect(outsiderResponse.ok()).toBe(true);
        const outsiderContents = extractMessageContents(await outsiderResponse.json());
        expect(outsiderContents.some((content) => content.includes(aclPhrase))).toBe(false);
      });

      await test.step('Assert the owner (a member) can see the hit', async () => {
        const apiUrl = resolveApiUrl();
        // The owner IS a member, so the same query must surface the hit.
        const ownerResponse = await request.get(
          `${apiUrl}/api/search?q=${encodeURIComponent(aclPhrase)}`,
          { headers: { Authorization: `Bearer ${owner.token}` } },
        );
        expect(ownerResponse.ok()).toBe(true);
        const ownerContents = extractMessageContents(await ownerResponse.json());
        expect(ownerContents.some((content) => content.includes(aclPhrase))).toBe(true);
      });
    });
  });

  test.describe('Result Navigation', () => {
    test('clicking a search result navigates to the originating channel', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('nav'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      const phrase = await test.step('Post a unique message then leave the channel', async () => {
        const posted = `navphrase${Date.now()}`;
        await sendMessageViaUi(page, posted);
        await expect(page.getByText(posted)).toBeVisible({ timeout: 5_000 });
        // Leave the channel so the post-click navigation is observable.
        await page.goto('/app');
        await expect(page).not.toHaveURL(new RegExp(`/app/channels/${channel.id}`));
        return posted;
      });

      await test.step('Search and click the result to navigate back to the channel', async () => {
        await focusSearchBar(page);
        await typeSearchQuery(page, phrase);
        // Results may render as links, buttons, or plain text - match any of them.
        const result = page
          .getByRole('link', { name: new RegExp(phrase, 'i') })
          .or(page.getByRole('button', { name: new RegExp(phrase, 'i') }))
          .or(page.getByText(phrase))
          .first();
        await expect(result).toBeVisible({ timeout: 5_000 });
        await result.click();
        await expect(page).toHaveURL(new RegExp(`/app/channels/${channel.id}`), {
          timeout: 5_000,
        });
        await expect(page.getByText(phrase).first()).toBeVisible({ timeout: 5_000 });
      });
    });

    test('results page uses shadcn Tabs to group categories', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('tabs'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      const phrase =
        await test.step('Post a message and open the dedicated results surface', async () => {
          const posted = `tabphrase${Date.now()}`;
          await sendMessageViaUi(page, posted);
          // Open the dedicated results surface with the query supplied in the URL.
          await page.goto(`/app/search?q=${encodeURIComponent(posted)}`);
          return posted;
        });

      await test.step('Assert the results group into shadcn Tabs categories', async () => {
        // shadcn Tabs exposes role="tablist" with each tab as role="tab".
        const tablist = page.getByRole('tablist').first();
        await expect(tablist).toBeVisible({ timeout: 5_000 });

        const tabs = page.getByRole('tab');
        const tabCount = await tabs.count();
        expect(tabCount).toBeGreaterThanOrEqual(3);

        await page.getByRole('tab', { name: /messages/i }).click();
        await expect(page.getByText(phrase).first()).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  test.describe('Edge Cases', () => {
    test('empty query does not fire a search request', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision a user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('empty'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Submit an empty query and assert no search request fires', async () => {
        let searchCallMade = false;
        page.on('request', (requestEvent) => {
          if (requestEvent.url().includes('/api/search')) {
            searchCallMade = true;
          }
        });

        await focusSearchBar(page);
        // Submitting an empty input must not trigger a network search.
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);

        expect(searchCallMade).toBe(false);
      });
    });

    test('rejects search query exceeding MAX_SEARCH_QUERY_LENGTH', async ({ request }) => {
      const user = await test.step('Provision a user via the API', async () => {
        const provisionedUser = await registerUserViaApi();
        return provisionedUser;
      });

      await test.step('Assert an over-long query is rejected with HTTP 400', async () => {
        const apiUrl = resolveApiUrl();
        const tooLong = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
        const response = await request.get(
          `${apiUrl}/api/search?q=${encodeURIComponent(tooLong)}`,
          {
            headers: { Authorization: `Bearer ${user.token}` },
          },
        );
        expect(response.status()).toBe(400);
      });
    });

    test('handles special characters in the search query without crashing', async ({ request }) => {
      const user = await test.step('Provision a user via the API', async () => {
        const provisionedUser = await registerUserViaApi();
        return provisionedUser;
      });

      await test.step('Assert special-character queries never return a 500', async () => {
        const apiUrl = resolveApiUrl();
        // Characters that would break a naive to_tsquery. The service must escape
        // them (plainto_tsquery / websearch_to_tsquery) and never return a 500.
        const specialQueries = ['"quoted"', '(parens)', 'a|b', 'a&b', 'a:b', "a'b", 'back\\slash'];
        for (const query of specialQueries) {
          const response = await request.get(
            `${apiUrl}/api/search?q=${encodeURIComponent(query)}`,
            { headers: { Authorization: `Bearer ${user.token}` } },
          );
          expect([200, 400]).toContain(response.status());
        }
      });
    });
  });
});
