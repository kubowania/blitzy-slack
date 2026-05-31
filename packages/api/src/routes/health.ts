/**
 * @app/api — Health route (PUBLIC, no auth).
 *
 * GET /api/health
 *   200 { ok: true,  api: "ok", postgres: "ok",  redis: "ok",  infrastructure: "ok"  } — healthy
 *   503 { ok: false, api: "ok", postgres: ...,    redis: ...,    infrastructure: ...    } — degraded
 *
 * Readiness fields (matches the prompt's example contract — Docker, Postgres,
 * Redis, and the API):
 *   - `api`            — the API process itself; always "ok" when this handler
 *                        runs (the process is serving the response by definition).
 *   - `postgres`       — PostgreSQL liveness (`SELECT 1`).
 *   - `redis`          — Redis liveness (`PING` → `PONG`).
 *   - `infrastructure` — aggregate readiness of the Docker-provisioned backing
 *                        services (Postgres AND Redis); the signal `make local`
 *                        waits on before seeding. This stands in for "Docker"
 *                        readiness, which the API cannot probe directly.
 *   - `ok`             — boolean AND of `api` and `infrastructure`; clients may
 *                        branch on either the status code or this field.
 *
 * Polled by:
 *   - the root Makefile's `local` target (readiness loop) before `make seed`
 *   - the Playwright `playwright.config.ts` web-server wait before E2E specs
 *   - the Docker Compose healthcheck (when the api service is added to compose)
 *   - external uptime / monitoring probes in future deployments
 *
 * ARCHITECTURAL EXCEPTION: this route directly imports `prisma` from `@app/db`
 * and `redisClient` from `../config/redis.js`. The architectural rule "routes go
 * through services" has a documented one-off exception for the infrastructure
 * liveness probe — see /docs/decision-log.md.
 */

import { Router, type Request, type Response } from 'express';

import { prisma } from '@app/db';

import { logger } from '../config/logger.js';
import { redisClient } from '../config/redis.js';

/**
 * Liveness status of a single subsystem.
 * - 'ok'    — the subsystem responded to its liveness probe.
 * - 'error' — the probe threw or returned an unexpected result.
 */
type SubsystemStatus = 'ok' | 'error';

/**
 * Body returned by `GET /api/health`. The shape is identical for the healthy
 * (200) and degraded (503) responses; `ok` is the boolean AND of the subsystem
 * statuses and clients may branch on either the status code or this field.
 */
interface HealthResponse {
  ok: boolean;
  api: SubsystemStatus;
  postgres: SubsystemStatus;
  redis: SubsystemStatus;
  infrastructure: SubsystemStatus;
}

/**
 * Probe PostgreSQL with the cheapest possible query (`SELECT 1`): no planner
 * work, no table I/O, no model dependency. Resolves to 'ok' when the query
 * succeeds and 'error' on any exception, logging the failure at warn level.
 */
async function checkPostgres(): Promise<SubsystemStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'ok';
  } catch (err: unknown) {
    logger.warn(
      {
        component: 'health',
        subsystem: 'postgres',
        err: err instanceof Error ? err.message : String(err),
      },
      'postgres liveness probe failed',
    );
    return 'error';
  }
}

/**
 * Probe Redis with the O(1) `PING` command. Resolves to 'ok' only when the
 * server answers 'PONG', and 'error' on any other response or exception,
 * logging the failure at warn level.
 */
async function checkRedis(): Promise<SubsystemStatus> {
  try {
    const result = await redisClient.ping();
    return result === 'PONG' ? 'ok' : 'error';
  } catch (err: unknown) {
    logger.warn(
      {
        component: 'health',
        subsystem: 'redis',
        err: err instanceof Error ? err.message : String(err),
      },
      'redis liveness probe failed',
    );
    return 'error';
  }
}

/**
 * Health router, mounted at `/health` by the routes barrel so the effective
 * path is `/api/health`. Exported as `router` to match the barrel convention
 * (`import { router as healthRouter } from './health.js'`).
 */
export const router: Router = Router();

router.get('/', async (_req: Request, res: Response<HealthResponse>) => {
  // Both probes catch their own errors, so this Promise.all never rejects.
  const [postgresStatus, redisStatus] = await Promise.all([checkPostgres(), checkRedis()]);

  // The API process is serving this response, so it is live by definition.
  const apiStatus: SubsystemStatus = 'ok';
  // The Docker-provisioned backing services are ready only when BOTH probes
  // pass; this aggregate is the "infrastructure"/Docker readiness signal that
  // `make local` blocks on before seeding and opening the browser.
  const infrastructureStatus: SubsystemStatus =
    postgresStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'error';

  const ok = apiStatus === 'ok' && infrastructureStatus === 'ok';
  const status = ok ? 200 : 503;

  res.status(status).json({
    ok,
    api: apiStatus,
    postgres: postgresStatus,
    redis: redisStatus,
    infrastructure: infrastructureStatus,
  });
});
