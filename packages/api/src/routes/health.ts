/**
 * @app/api — Health route (PUBLIC, no auth).
 *
 * GET /api/health
 *   200 { ok: true,  postgres: "ok",          redis: "ok"          } — all subsystems healthy
 *   503 { ok: false, postgres: "ok" | "error", redis: "ok" | "error" } — degraded
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
  postgres: SubsystemStatus;
  redis: SubsystemStatus;
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

  const ok = postgresStatus === 'ok' && redisStatus === 'ok';
  const status = ok ? 200 : 503;

  res.status(status).json({
    ok,
    postgres: postgresStatus,
    redis: redisStatus,
  });
});
