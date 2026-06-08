/**
 * @file packages/api/test/users.test.ts
 *
 * Jest + supertest integration tests for the user-directory route (1 endpoint):
 *   - GET /api/users?q=<text>   (AUTH REQUIRED)
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             supertest's `any` `response.body` is narrowed with a single
 *             whole-object assertion so the `no-unsafe-*` rules stay satisfied).
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts.
 *   Gate 10 — Observability: every response carries an `X-Request-Id` header.
 *   Gate 12 — Zod validation on `q` (over-length / unknown key → 422) and every
 *             backend endpoint has at least one integration test.
 *
 * AAP refs: §0.1.1 (DMs people picker), §0.5.2 (StartDmDialog), §0.8.2
 *           Gate 10/Gate 12, privacy contract (`PublicUser` omits email).
 *
 * Behavioral contract (verified against routes/users.ts +
 * services/users.service.ts + schemas/user.ts):
 *   - `requireAuth` runs BEFORE `validate`, so a request with no/!invalid bearer
 *     token is 401 regardless of the query string.
 *   - `q` is OPTIONAL: omitted/empty → first page of the directory (ordered by
 *     displayName asc); present → case-insensitive `displayName CONTAINS q`.
 *   - The authenticated caller is ALWAYS excluded (you cannot DM yourself).
 *   - Results are `PublicUser` (id, displayName, avatarUrl): email and
 *     passwordHash are NEVER searched nor returned (privacy).
 *   - `.strict()` rejects unknown query keys; `q` is bounded to
 *     MAX_DISPLAY_NAME_LENGTH characters; the page is capped at
 *     MAX_USER_SEARCH_RESULTS.
 *   - Pure read — no Socket.io emissions, no DB writes.
 *
 * Rationale for the non-trivial test decisions (deterministic displayName
 * fixtures for ordering/substring assertions, the privacy-shape strategy) lives
 * in /docs/decision-log.md per the Explainability rule, not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type { PublicUser } from '@app/shared/types/user';
import { MAX_DISPLAY_NAME_LENGTH, MAX_USER_SEARCH_RESULTS } from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  uniqueEmail,
} from './setup.js';

/** UUID v4 shape emitted by `request-logger.ts` as the `X-Request-Id` header. */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Minimal shape of the centralized error envelope
 * (`middleware/error-handler.ts`) used to narrow supertest's `any` body on
 * failure responses without an unsafe member access.
 */
interface ErrorResponseBody {
  error: string;
  message: string;
  code?: string;
  details?: Record<string, string[] | undefined>;
}

/**
 * Assert a single result row is exactly the `PublicUser` projection: the three
 * public fields present and the private `email` / `passwordHash` absent.
 */
function expectPublicUserShape(row: PublicUser): void {
  expect(Object.keys(row).sort()).toEqual(['avatarUrl', 'displayName', 'id'].sort());
  expect(row).not.toHaveProperty('email');
  expect(row).not.toHaveProperty('passwordHash');
}

describe('GET /api/users', () => {
  let app: Application;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  // ---------------------------------------------------------------------------
  // Authentication (requireAuth runs before validate)
  // ---------------------------------------------------------------------------
  describe('authentication', () => {
    it('returns 401 without an Authorization header', async () => {
      const response = await request(app).get('/api/users').expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.error).toBe('Unauthorized');
      expect(typeof body.message).toBe('string');
    });

    it('returns 401 when the Authorization header lacks the Bearer prefix', async () => {
      await request(app).get('/api/users').set('Authorization', 'NotBearer xyz').expect(401);
    });

    it('returns 401 for a malformed bearer token', async () => {
      await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer not.a.valid.jwt')
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation (Gate 12) — valid token, invalid query
  // ---------------------------------------------------------------------------
  describe('validation', () => {
    it(`returns 422 when q exceeds ${String(MAX_DISPLAY_NAME_LENGTH)} characters`, async () => {
      const { token } = await registerUser();
      const tooLong = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);

      const response = await request(app)
        .get('/api/users')
        .query({ q: tooLong })
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      const body = response.body as ErrorResponseBody;
      expect(body.error).toBe('UnprocessableEntity');
      expect(typeof body.message).toBe('string');
    });

    it('returns 422 for an unknown query key (.strict())', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/users')
        .query({ q: 'alice', unexpected: 'value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — directory listing, exclusion, ordering, substring search
  // ---------------------------------------------------------------------------
  describe('happy path', () => {
    it('lists peers ordered by displayName and excludes the caller (no q)', async () => {
      // Deterministic displayNames so ordering and exclusion are assertable.
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      await registerUser({ displayName: 'Alice Anderson' });
      await registerUser({ displayName: 'Bob Brown' });

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      const names = body.map((u) => u.displayName);
      // Caller is excluded; peers returned ordered by displayName ascending.
      expect(names).toEqual(['Alice Anderson', 'Bob Brown']);
      expect(names).not.toContain('Zoe Caller');
    });

    it('treats an empty q the same as no q (first page of the directory)', async () => {
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      await registerUser({ displayName: 'Alice Anderson' });

      const response = await request(app)
        .get('/api/users')
        .query({ q: '' })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body.map((u) => u.displayName)).toEqual(['Alice Anderson']);
    });

    it('filters by a case-insensitive displayName substring', async () => {
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      const alice = await registerUser({ displayName: 'Alice Anderson' });
      await registerUser({ displayName: 'Bob Brown' });

      const response = await request(app)
        .get('/api/users')
        .query({ q: 'ALI' }) // upper-case query must still match "Alice"
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body).toHaveLength(1);
      expect(body[0]?.id).toBe(alice.user.id);
      expect(body[0]?.displayName).toBe('Alice Anderson');
    });

    it('excludes the caller even when the query matches their own displayName', async () => {
      const caller = await registerUser({ displayName: 'Unique Caller Name' });

      const response = await request(app)
        .get('/api/users')
        .query({ q: 'Unique Caller' })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body).toHaveLength(0);
    });

    it('returns an empty array when nothing matches', async () => {
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      await registerUser({ displayName: 'Alice Anderson' });

      const response = await request(app)
        .get('/api/users')
        .query({ q: 'no-such-person-xyz' })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      expect(response.body as PublicUser[]).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Privacy (PublicUser projection) — email / passwordHash never leak
  // ---------------------------------------------------------------------------
  describe('privacy — PublicUser projection', () => {
    it('returns only id/displayName/avatarUrl and never email or passwordHash', async () => {
      const peerEmail = uniqueEmail();
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      const peer = await registerUser({ email: peerEmail, displayName: 'Alice Anderson' });

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body).toHaveLength(1);
      const [row] = body;
      expect(row?.id).toBe(peer.user.id);
      if (row !== undefined) {
        expectPublicUserShape(row);
      }

      // Defense in depth: the peer's email and any bcrypt hash must not appear
      // anywhere in the serialized response payload.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(peerEmail);
      expect(serialized).not.toMatch(/passwordHash/);
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    });

    it('avatarUrl defaults to null for a registration without an avatar', async () => {
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      await registerUser({ displayName: 'Alice Anderson' });

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body[0]?.avatarUrl).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Result cap (MAX_USER_SEARCH_RESULTS)
  // ---------------------------------------------------------------------------
  describe('result cap', () => {
    it(`returns at most ${String(MAX_USER_SEARCH_RESULTS)} users in a single page`, async () => {
      const caller = await registerUser({ displayName: 'Zoe Caller' });
      // Register more peers than the page cap so the ceiling is exercised.
      // Sequential (not Promise.all) to keep registration deterministic and
      // avoid hammering bcrypt with a large concurrent burst.
      for (let i = 0; i < MAX_USER_SEARCH_RESULTS + 5; i++) {
        const ordinal = String(i).padStart(3, '0');
        await registerUser({ displayName: `Peer ${ordinal}` });
      }

      const response = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PublicUser[];
      expect(body.length).toBe(MAX_USER_SEARCH_RESULTS);
    });
  });

  // ---------------------------------------------------------------------------
  // Response headers (Gate 10)
  // ---------------------------------------------------------------------------
  describe('response headers', () => {
    it('returns application/json', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect('Content-Type', /application\/json/);
    });

    it('exposes an X-Request-Id header (Gate 10 — Pino reqId)', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect('X-Request-Id', UUID_FORMAT);
    });
  });
});
