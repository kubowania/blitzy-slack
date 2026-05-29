/**
 * scripts/seed-via-api.ts — Test user seed via the registration flow.
 *
 * Creates the seed user `admin@test.com` / `Password12345!` by calling
 * `POST /api/auth/register` (Rule 4, AAP §0.8.1) after polling
 * `GET /api/health` until the API reports ready.
 *
 * Dual invocation modes:
 *   1. CLI (`make seed` → `pnpm exec tsx scripts/seed-via-api.ts`): detected via
 *      `process.argv[1] === fileURLToPath(import.meta.url)`; exits 0 on success,
 *      1 on failure.
 *   2. Playwright globalSetup (referenced in `playwright.config.ts`): the default
 *      export is awaited; errors bubble to Playwright. Both modes run through
 *      `seedTestUser()`, so the health gate applies to both.
 *
 * Idempotent: HTTP 201 (created) and HTTP 409 (already exists) are both success;
 * any other status, a network error, or a timeout is a failure.
 *
 * Rationale and trade-offs for the decisions in this file are recorded in
 * docs/decision-log.md (Explainability rule, AAP §0.8.3).
 */

import { fileURLToPath } from 'node:url';

const DEFAULT_API_URL = 'http://localhost:3000';
const SEED_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const SEED_USER = {
  email: 'admin@test.com',
  password: 'Password12345!',
  displayName: 'Admin',
} as const;

interface SeedResult {
  status: 'created' | 'already_exists';
  httpStatus: number;
}

/**
 * Polls `GET ${apiUrl}/api/health` until it responds 2xx or the timeout
 * elapses. Each poll is bounded by its own AbortController so a hung socket
 * cannot stall the loop. Resolves when healthy; throws on timeout.
 */
async function waitForApiHealth(apiUrl: string): Promise<void> {
  const healthUrl = `${apiUrl}/api/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'no response yet';

  console.info(`[seed] Waiting for API health at ${healthUrl} (timeout ${HEALTH_TIMEOUT_MS}ms)`);

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.ok) {
        console.info(`[seed] API healthy (${res.status})`);
        return;
      }
      lastError = `HTTP ${res.status} ${res.statusText}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeoutId);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `API did not become healthy at ${healthUrl} within ${HEALTH_TIMEOUT_MS}ms ` +
      `(last error: ${lastError}). Is the API server running and reachable?`,
  );
}

async function seedTestUser(): Promise<SeedResult> {
  const apiUrl = process.env.VITE_API_URL ?? DEFAULT_API_URL;
  const registerUrl = `${apiUrl}/api/auth/register`;

  await waitForApiHealth(apiUrl);

  console.info(`[seed] POST ${registerUrl} (email=${SEED_USER.email})`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SEED_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(registerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(SEED_USER),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Seed request timed out after ${SEED_TIMEOUT_MS}ms (target: ${registerUrl}). ` +
          'Is the API server running and reachable?',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Seed request to ${registerUrl} failed before receiving a response: ${message}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 201) {
    console.info(`[seed] User created (201): ${SEED_USER.email}`);
    return { status: 'created', httpStatus: 201 };
  }

  if (response.status === 409) {
    console.info(`[seed] User already exists (409): ${SEED_USER.email} — idempotent success`);
    return { status: 'already_exists', httpStatus: 409 };
  }

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '<failed to read response body>';
  }
  throw new Error(
    `Unexpected ${response.status} ${response.statusText} from ${registerUrl}: ${bodyText}`,
  );
}

export default async function seedViaApi(): Promise<void> {
  await seedTestUser();
}

function isCliInvocation(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  try {
    await seedTestUser();
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[seed] FAILED: ${message}`);
    process.exit(1);
  }
}
