/**
 * @file packages/api/test/health.test.ts
 *
 * Jest + supertest integration tests for the health route (1 endpoint):
 *   - GET /api/health   (PUBLIC readiness probe, no auth)
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             supertest's `any` `response.body` is narrowed with a single
 *             whole-object assertion so the `no-unsafe-*` rules stay satisfied).
 *   Gate 10 — Observability: every response carries an `X-Request-Id` header
 *             (request-logger.ts generates a UUID v4 per request).
 *   Gate 12 — Every backend endpoint has at least one integration test.
 *
 * AAP refs: §0.1.2 (health-check endpoint gating `make local`), §0.8.2 Gate 10,
 *           User Example — "GET /api/health returns readiness for Docker,
 *           Postgres, Redis, and the API".
 *
 * Behavioral contract (verified against routes/health.ts):
 *   - GET /api/health is mounted PUBLICLY (no `requireAuth`); it answers whether
 *     or not an Authorization header is present.
 *   - When the Docker-provisioned Postgres + Redis backing services are live
 *     (the precondition for ALL API integration suites, which mutate the test
 *     database), the probe returns 200 with every subsystem reporting `'ok'`
 *     and `ok: true`. The shape is identical on the degraded (503) path; this
 *     suite asserts the healthy path because the test infra is up by definition.
 *   - The response is `application/json`.
 *
 * Rationale for the non-trivial test decisions (asserting the healthy path, the
 * one-off route→infra architectural exception) lives in /docs/decision-log.md
 * per the Explainability rule, not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import { createTestApp, closeTestResources } from './setup.js';

/** UUID v4 shape emitted by `request-logger.ts` as the `X-Request-Id` header. */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Shape of the `GET /api/health` JSON body (mirrors routes/health.ts
 * `HealthResponse`). Declared locally to narrow supertest's `any` body without
 * an unsafe member access.
 */
interface HealthBody {
  ok: boolean;
  api: string;
  postgres: string;
  redis: string;
  infrastructure: string;
}

describe('GET /api/health', () => {
  let app: Application;

  beforeAll(() => {
    // createTestApp() builds the production Express app once; supertest binds to
    // the app object per request (no port is opened).
    app = createTestApp();
  });

  afterAll(async () => {
    // Close the shared Prisma + Redis singletons the health probe touches so
    // Jest exits without open-handle leaks.
    await closeTestResources();
  });

  describe('readiness — healthy infrastructure', () => {
    it('returns 200 with every subsystem reporting ok', async () => {
      const response = await request(app).get('/api/health').expect(200);

      const body = response.body as HealthBody;
      expect(body.ok).toBe(true);
      expect(body.api).toBe('ok');
      expect(body.postgres).toBe('ok');
      expect(body.redis).toBe('ok');
      expect(body.infrastructure).toBe('ok');
    });

    it('exposes exactly the readiness contract fields', async () => {
      const response = await request(app).get('/api/health').expect(200);

      const body = response.body as HealthBody;
      // The contract is the four readiness fields plus the aggregate `ok` flag —
      // no more, no less (Docker/Postgres/Redis/API per the User Example).
      expect(Object.keys(body).sort()).toEqual(
        ['api', 'infrastructure', 'ok', 'postgres', 'redis'].sort(),
      );
    });
  });

  describe('public access (no auth)', () => {
    it('responds 200 without an Authorization header', async () => {
      // The Makefile readiness loop and the Docker healthcheck poll this endpoint
      // before any token exists, so it MUST be reachable unauthenticated.
      await request(app).get('/api/health').expect(200);
    });

    it('ignores a malformed Authorization header (still public)', async () => {
      // A garbage bearer token must not turn a public probe into a 401.
      await request(app)
        .get('/api/health')
        .set('Authorization', 'Bearer not.a.valid.jwt')
        .expect(200);
    });
  });

  describe('response headers', () => {
    it('returns application/json', async () => {
      await request(app)
        .get('/api/health')
        .expect(200)
        .expect('Content-Type', /application\/json/);
    });

    it('exposes an X-Request-Id header (Gate 10 — Pino reqId)', async () => {
      // request-logger.ts generates a UUID v4 per request and echoes it back on
      // every response, including this public probe.
      await request(app).get('/api/health').expect(200).expect('X-Request-Id', UUID_FORMAT);
    });
  });
});
