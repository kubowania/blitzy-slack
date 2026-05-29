/**
 * scripts/seed-via-api.ts — Test user seed via the registration flow.
 *
 * Rule 4 (AAP §0.8.1) mandates that the seed user `admin@test.com` /
 * `Password12345!` is created by calling `POST /api/auth/register`, NOT by
 * issuing a direct database INSERT. This file is the sole code path that
 * fulfills that rule.
 *
 * Dual invocation modes:
 *
 *   1. CLI mode (invoked by `make seed` → `pnpm exec tsx scripts/seed-via-api.ts`):
 *      Detected via `process.argv[1] === fileURLToPath(import.meta.url)`.
 *      Runs seedTestUser() and exits 0 on success, 1 on failure.
 *
 *   2. Playwright globalSetup mode (referenced as `./scripts/seed-via-api.ts`
 *      in `playwright.config.ts`): Playwright imports this module and invokes
 *      the default export, which awaits seedTestUser(). Errors bubble to
 *      Playwright which fails the test run.
 *
 * Idempotent semantics: HTTP 201 (newly created) AND HTTP 409 (already exists)
 * are both treated as success. Any other status — including network errors
 * and the 60-second AbortController timeout — is a failure.
 *
 * No workspace package imports: the script is self-contained for simplicity
 * and to keep tsx ESM resolution trivial. The body shape is the hardcoded
 * test-user record, which by definition matches registerSchema in
 * packages/shared/src/schemas/auth.ts.
 *
 * Rationale for native fetch over node-fetch/axios, dual-mode design, the
 * 60s timeout, and 409-as-success is recorded in /docs/decision-log.md per
 * the Explainability rule (AAP §0.8.3).
 */

import { fileURLToPath } from 'node:url';

const DEFAULT_API_URL = 'http://localhost:3000';
const SEED_TIMEOUT_MS = 60_000;
const SEED_USER = {
  email: 'admin@test.com',
  password: 'Password12345!',
  displayName: 'Admin',
} as const;

interface SeedResult {
  status: 'created' | 'already_exists';
  httpStatus: number;
}

async function seedTestUser(): Promise<SeedResult> {
  const apiUrl = process.env.VITE_API_URL ?? DEFAULT_API_URL;
  const registerUrl = `${apiUrl}/api/auth/register`;

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
