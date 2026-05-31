/**
 * @file packages/api/test/presence.test.ts
 *
 * Jest + supertest integration tests for the presence-hydration route
 * (1 endpoint):
 *   - GET /api/presence?userIds=<id1,id2,...>   (AUTH REQUIRED)
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             supertest's `any` `response.body` is narrowed with a single
 *             whole-object assertion so the `no-unsafe-*` rules stay satisfied).
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts.
 *   Gate 10 — Observability: every response carries an `X-Request-Id` header.
 *   Gate 12 — Zod validation on `userIds` (missing/empty/non-cuid/over-cap → 400)
 *             and every backend endpoint has at least one integration test.
 *
 * AAP refs: §0.1.1 (presence), §0.4.5 (presence:update), §0.8.4 (presence
 *           semantics), §0.8.2 Gate 10/Gate 12.
 *
 * Behavioral contract (verified against routes/presence.ts +
 * services/presence.service.ts + schemas/presence.ts):
 *   - `requireAuth` runs BEFORE `validate`, so a request with no/!invalid bearer
 *     token is 401 regardless of the query string.
 *   - `presenceQuerySchema` requires a non-empty `userIds` string, splits it on
 *     commas, and validates the result as a non-empty list of cuids bounded to
 *     MAX_PRESENCE_QUERY_IDS entries; `.strict()` rejects unknown keys.
 *   - The service resolves presence from Redis TTL: a user with NO heartbeat key
 *     (every freshly registered user in this HTTP-only suite) reads as
 *     `'offline'`. Every requested id appears in the response map.
 *   - The endpoint is a pure read — no Socket.io emissions, no DB writes.
 *
 * Rationale for the non-trivial test decisions (the offline-by-default
 * assertion, the over-cap fixture built from a real cuid) lives in
 * /docs/decision-log.md per the Explainability rule, not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type { PresenceState } from '@app/shared/types/presence';
import { MAX_PRESENCE_QUERY_IDS } from '@app/shared/constants/limits';

import { createTestApp, cleanDatabase, closeTestResources, registerUser } from './setup.js';

/** UUID v4 shape emitted by `request-logger.ts` as the `X-Request-Id` header. */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The three valid presence buckets (AAP §0.8.4). */
const PRESENCE_STATES: readonly PresenceState[] = ['online', 'away', 'offline'];

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
 * Shape of the `GET /api/presence` success body: a map from each requested
 * userId to its current presence bucket.
 */
type PresenceMapBody = Record<string, PresenceState>;

describe('GET /api/presence', () => {
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
      const { user } = await registerUser();

      const response = await request(app)
        .get('/api/presence')
        .query({ userIds: user.id })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.error).toBe('Unauthorized');
      expect(typeof body.message).toBe('string');
    });

    it('returns 401 when the Authorization header lacks the Bearer prefix', async () => {
      const { user } = await registerUser();

      await request(app)
        .get('/api/presence')
        .query({ userIds: user.id })
        .set('Authorization', 'NotBearer xyz')
        .expect(401);
    });

    it('returns 401 for a malformed bearer token (auth checked before validation)', async () => {
      // A bad token short-circuits at requireAuth even though the query is also
      // invalid (missing userIds) — proving the middleware order.
      await request(app)
        .get('/api/presence')
        .set('Authorization', 'Bearer not.a.valid.jwt')
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation (Gate 12) — valid token, invalid query
  // ---------------------------------------------------------------------------
  describe('validation', () => {
    it('returns 400 when userIds is missing', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .get('/api/presence')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.error).toBe('BadRequest');
      expect(typeof body.message).toBe('string');
    });

    it('returns 400 when userIds is empty', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/presence')
        .query({ userIds: '' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('returns 400 when userIds contains a non-cuid', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .get('/api/presence')
        .query({ userIds: 'not-a-cuid' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.error).toBe('BadRequest');
    });

    it(`returns 400 when more than ${String(MAX_PRESENCE_QUERY_IDS)} ids are requested`, async () => {
      const { token, user } = await registerUser();
      // A list one over the cap, built from a REAL cuid so each entry passes the
      // per-id `cuid()` check and ONLY the `.max(MAX_PRESENCE_QUERY_IDS)` bound
      // fails — isolating the over-cap rejection.
      const overCap = Array.from({ length: MAX_PRESENCE_QUERY_IDS + 1 }, () => user.id).join(',');

      await request(app)
        .get('/api/presence')
        .query({ userIds: overCap })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('returns 400 for an unknown query key (.strict())', async () => {
      const { token, user } = await registerUser();

      await request(app)
        .get('/api/presence')
        .query({ userIds: user.id, unexpected: 'value' })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path — fresh users have no heartbeat, so they read as offline
  // ---------------------------------------------------------------------------
  describe('happy path', () => {
    it('returns offline for a freshly registered user (no heartbeat)', async () => {
      const caller = await registerUser();
      const peer = await registerUser();

      const response = await request(app)
        .get('/api/presence')
        .query({ userIds: peer.user.id })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PresenceMapBody;
      expect(body[peer.user.id]).toBe('offline');
    });

    it('returns a bucket for EVERY requested id', async () => {
      const caller = await registerUser();
      const peerA = await registerUser();
      const peerB = await registerUser();

      const requested = [caller.user.id, peerA.user.id, peerB.user.id];

      const response = await request(app)
        .get('/api/presence')
        .query({ userIds: requested.join(',') })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PresenceMapBody;
      // Every requested id is present in the map...
      expect(Object.keys(body).sort()).toEqual([...requested].sort());
      // ...and every value is one of the three valid buckets (all offline here).
      for (const id of requested) {
        expect(PRESENCE_STATES).toContain(body[id]);
        expect(body[id]).toBe('offline');
      }
    });

    it('deduplicates repeated ids into a single map entry', async () => {
      const caller = await registerUser();
      const peer = await registerUser();

      const response = await request(app)
        .get('/api/presence')
        .query({ userIds: `${peer.user.id},${peer.user.id}` })
        .set('Authorization', `Bearer ${caller.token}`)
        .expect(200);

      const body = response.body as PresenceMapBody;
      // The map is keyed by id, so a repeated id collapses to one key.
      expect(Object.keys(body)).toEqual([peer.user.id]);
      expect(body[peer.user.id]).toBe('offline');
    });
  });

  // ---------------------------------------------------------------------------
  // Response headers (Gate 10)
  // ---------------------------------------------------------------------------
  describe('response headers', () => {
    it('returns application/json', async () => {
      const { token, user } = await registerUser();

      await request(app)
        .get('/api/presence')
        .query({ userIds: user.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect('Content-Type', /application\/json/);
    });

    it('exposes an X-Request-Id header (Gate 10 — Pino reqId)', async () => {
      const { token, user } = await registerUser();

      await request(app)
        .get('/api/presence')
        .query({ userIds: user.id })
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect('X-Request-Id', UUID_FORMAT);
    });
  });
});
