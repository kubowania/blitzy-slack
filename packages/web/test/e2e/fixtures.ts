/**
 * packages/web/test/e2e/fixtures.ts — Shared Playwright fixtures and helpers
 *
 * Loaded by every spec file in this folder. Centralizes:
 *   - Seed admin credentials (Rule 4)
 *   - Env-resolved API_URL and APP_URL constants
 *   - registerUserViaApi() for cross-user test setup
 *   - loginViaUi(), loginAsAdmin(), registerUserViaUi() for UI flows
 *   - createChannelViaApi(), sendMessageViaUi() for action helpers
 *   - cleanupTestData() + auto fixtures for per-test DB isolation (preserving
 *     the Rule 4 seed admin) and worker-scoped Prisma disconnect
 *   - Extended `test` with apiUrl + appUrl fixtures
 *
 * See packages/web/test/e2e/README or AAP §0.8.1 for compliance requirements.
 */

import { test as base, expect as baseExpect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { prisma, disconnectPrisma } from '@app/db';

// The per-test cleanup helper below connects to Postgres directly through the
// @app/db Prisma client (a lazy proxy that reads DATABASE_URL on first use).
// Provide the local dev/test default when the variable is not exported into the
// Playwright process, mirroring the API_URL / APP_URL fallbacks. Rationale and
// the shared-database trade-off are recorded in docs/decision-log.md.
process.env.DATABASE_URL ??= 'postgresql://slack:slack@localhost:5432/slack_dev?schema=public';

// === Constants ===

/**
 * Seeded admin user credentials, created by `scripts/seed-via-api.ts` via
 * Playwright's `globalSetup`. Per AAP Rule 4, this user is created by
 * calling POST /api/auth/register — never via a direct SQL INSERT.
 */
export const ADMIN_EMAIL = 'admin@test.com';
export const ADMIN_PASSWORD = 'Password12345!';
export const ADMIN_DISPLAY_NAME = 'Admin User';

/**
 * API base URL (HTTP). Falls back to `http://localhost:3000` for local dev,
 * matching the root `.env.example`.
 */
export const API_URL: string = process.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Web app base URL. Falls back to `http://localhost:5173` (Vite dev default),
 * matching the `playwright.config.ts` baseURL.
 */
export const APP_URL: string = process.env.VITE_APP_URL ?? 'http://localhost:5173';

// === Types ===

/**
 * Shape returned by `registerUserViaApi` for use in cross-user tests.
 * Mirrors the auth response from POST /api/auth/register.
 */
export interface RegisteredUser {
  email: string;
  password: string;
  displayName: string;
  userId: string;
  token: string;
}

// === Helpers ===

/**
 * Register a new user by calling POST /api/auth/register directly.
 *
 * This is the ONLY way (per AAP Rule 4) to create test users beyond the seeded
 * admin. The API response is expected to be `{ user: { id, ... }, token: string }`.
 *
 * Generates a unique email per call by appending a random suffix so concurrent
 * tests do not collide on the email-unique constraint.
 *
 * @param overrides - Optional credential overrides; when omitted, generates random ones
 * @returns the registered user with their JWT and the credentials used
 */
export async function registerUserViaApi(
  overrides: Partial<Pick<RegisteredUser, 'email' | 'password' | 'displayName'>> = {},
): Promise<RegisteredUser> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = overrides.email ?? `user-${suffix}@test.com`;
  const password = overrides.password ?? 'TestPassword123!';
  const displayName = overrides.displayName ?? `Test User ${suffix}`;

  const response = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `registerUserViaApi failed: HTTP ${response.status} ${response.statusText} — ${errText}`,
    );
  }

  const data = (await response.json()) as { user: { id: string }; token: string };
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('registerUserViaApi: response missing `token` field');
  }
  if (typeof data.user?.id !== 'string' || data.user.id.length === 0) {
    throw new Error('registerUserViaApi: response missing `user.id` field');
  }

  return { email, password, displayName, userId: data.user.id, token: data.token };
}

/**
 * Log in to the web app by navigating to /login and submitting the form.
 *
 * Waits for navigation to /app or any /app/* subpath as the login-success signal.
 *
 * @param page - Playwright Page to drive
 * @param email - Email to enter
 * @param password - Password to enter
 */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  // Wait for redirect to authenticated area
  await page.waitForURL(/\/app(\/.*)?$/, { timeout: 10_000 });
}

/**
 * Convenience wrapper that logs the page in as the seeded admin user.
 * Per AAP Rule 4, this admin is created at globalSetup via /api/auth/register.
 *
 * @param page - Playwright Page to drive
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
}

/**
 * Register a new user by submitting the /register form in the UI.
 * Generates a unique email so concurrent tests do not collide.
 *
 * @param page - Playwright Page to drive
 * @param overrides - Optional credential overrides
 * @returns the credentials submitted (NOT a token — register-via-UI typically
 *          auto-logs the user in by setting a cookie/localStorage; spec
 *          should verify navigation to /app)
 */
export async function registerUserViaUi(
  page: Page,
  overrides: Partial<Pick<RegisteredUser, 'email' | 'password' | 'displayName'>> = {},
): Promise<{ email: string; password: string; displayName: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = overrides.email ?? `user-${suffix}@test.com`;
  const password = overrides.password ?? 'TestPassword123!';
  const displayName = overrides.displayName ?? `Test User ${suffix}`;

  await page.goto('/register');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByLabel(/display name|name/i).fill(displayName);
  await page.getByRole('button', { name: /sign up|register|create account/i }).click();
  // Wait for redirect to /app (or any authenticated subpath)
  await page.waitForURL(/\/app(\/.*)?$/, { timeout: 10_000 });

  return { email, password, displayName };
}

/**
 * Create a channel by calling POST /api/channels directly with a Bearer token.
 *
 * Channel name must match the regex `/^[a-z0-9_-]+$/` (lowercase ASCII,
 * hyphens, underscores, digits). See `packages/shared/src/schemas/channel.ts`.
 *
 * @param token - JWT Bearer token of the requesting user
 * @param name - Channel name (lowercase ASCII pattern)
 * @param isPrivate - Whether to create a private channel (defaults to public)
 * @param description - Optional channel description
 * @returns the created channel id
 */
export async function createChannelViaApi(
  token: string,
  name: string,
  isPrivate = false,
  description?: string,
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = { name, isPrivate };
  if (description !== undefined) {
    body.description = description;
  }
  const response = await fetch(`${API_URL}/api/channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `createChannelViaApi failed: HTTP ${response.status} ${response.statusText} — ${errText}`,
    );
  }
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

/**
 * Send a message by typing into the composer and pressing Enter.
 * The composer is identified by its accessible role/name; the spec assumes
 * it is rendered as a multi-line text area.
 *
 * @param page - Playwright Page already on a channel or DM view
 * @param content - Message content to send
 */
export async function sendMessageViaUi(page: Page, content: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: /message|compose/i }).first();
  await composer.fill(content);
  await composer.press('Enter');
  // Wait for the composer to clear before returning. A successful send resets
  // the textarea to empty; until then the disabled, mid-submission composer
  // still holds the submitted text. Firefox keeps that text visible noticeably
  // longer than Chromium, so a follow-up `page.getByText(content)` on the
  // sender's page would otherwise match BOTH the timeline message and the
  // not-yet-cleared composer textarea and trip Playwright's strict mode.
  // Gating on an empty composer makes the helper deterministic across browsers
  // and additionally confirms the send round-trip completed before the caller
  // proceeds to assert on the result.
  await baseExpect(composer).toHaveValue('', { timeout: 10_000 });
}

/**
 * Generate a unique, valid channel name matching `/^[a-z0-9_-]+$/` so concurrent
 * tests do not collide on the unique-name constraint.
 *
 * @param prefix - Optional name prefix (must be lowercase)
 * @returns a randomized channel name like `test-channel-abc123`
 */
export function uniqueChannelName(prefix = 'test'): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${suffix}`;
}

/**
 * Remove all test-created data so each E2E test starts from a clean,
 * deterministic state. The suite shares the single dev/test Postgres
 * (`slack_dev`), so without this teardown channels, messages, and users
 * accumulate across the run and couple tests to global state.
 *
 * Deletes in dependency-safe order (children before parents) and deliberately
 * PRESERVES the Rule 4 seed admin (`admin@test.com`): that account is created
 * once by Playwright's `globalSetup` (via POST /api/auth/register) and must
 * survive so `loginAsAdmin` keeps working for every test. Relies on serial
 * execution (`workers: 1` in playwright.config.ts) so cleanup never races a
 * sibling test.
 */
export async function cleanupTestData(): Promise<void> {
  await prisma.messageReaction.deleteMany();
  await prisma.message.deleteMany();
  await prisma.channelMember.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.dMParticipant.deleteMany();
  await prisma.directMessage.deleteMany();
  await prisma.file.deleteMany();
  await prisma.user.deleteMany({ where: { email: { not: ADMIN_EMAIL } } });
}

// === Test fixture extension ===

interface TestFixtures {
  apiUrl: string;
  appUrl: string;
  /**
   * Auto fixture: after each test runs, remove all test-created rows so the
   * next test starts clean (preserves the seed admin). Declared `auto` so every
   * spec inherits the isolation without opting in.
   */
  cleanupAfterEach: void;
}

interface WorkerFixtures {
  /**
   * Auto worker fixture: disconnect the Prisma client when the worker tears
   * down so the suite exits cleanly with no lingering DB connections.
   */
  dbConnection: void;
}

/**
 * Extended Playwright test object that exposes:
 *   - `apiUrl` — the resolved API_URL constant (for cross-spec consistency)
 *   - `appUrl` — the resolved APP_URL constant
 *
 * Spec files MUST import `test` and `expect` from THIS module rather than
 * directly from `@playwright/test` so they inherit the fixtures.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern
  apiUrl: async ({}, use) => {
    await use(API_URL);
  },
  // eslint-disable-next-line no-empty-pattern
  appUrl: async ({}, use) => {
    await use(APP_URL);
  },
  // Per-test auto fixture: run the test, then remove all test-created rows so the
  // next test starts from a clean database (the suite shares slack_dev). Serial
  // execution (workers: 1) guarantees this never races a sibling test.
  cleanupAfterEach: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      await cleanupTestData();
    },
    { auto: true },
  ],
  // Worker-scoped auto fixture: close the Prisma connection when the worker
  // finishes so the run exits cleanly without open handles.
  dbConnection: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      await disconnectPrisma();
    },
    { scope: 'worker', auto: true },
  ],
});

/**
 * Re-export expect for convenience.
 */
export const expect = baseExpect;
