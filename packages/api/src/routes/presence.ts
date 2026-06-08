/**
 * @app/api — Presence-hydration route (AUTH REQUIRED).
 *
 * GET /api/presence?userIds=<id1,id2,...>
 *   200 Record<userId, PresenceState> — current bucket for each requested id
 *   400 ValidationError (ZodError) when `userIds` is missing/empty, contains a
 *       non-cuid, or exceeds MAX_PRESENCE_QUERY_IDS entries
 *   401 UnauthorizedError when the Authorization bearer token is missing or invalid
 *
 * The web client calls this once on mount to SEED its presence map for every
 * user currently visible in the sidebar / DM list, closing the gap before the
 * first live `presence:update` event arrives (without it, peers render as
 * `offline` until they happen to transition). Every requested id is present in
 * the response; ids with no live heartbeat resolve to `offline`.
 *
 * Performance (Gate 9): the service resolves the whole batch in a single Redis
 * MGET, so a sidebar of dozens of users hydrates in one round-trip.
 *
 * Observability (Gate 10): the request-scoped Pino child logger emits a single
 * structured line carrying the requested id COUNT — never the ids themselves.
 *
 * NO Socket.io emissions — this is a pure read.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which types `req.log` below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';

import { presenceQuerySchema } from '@app/shared/schemas/presence';
import type { PresenceQueryInput } from '@app/shared/schemas/presence';
import type { PresenceState } from '@app/shared/types/presence';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getPresenceMap } from '../services/presence.service.js';

/**
 * Response body for `GET /api/presence`: a map from each requested userId to
 * its current presence bucket. Every requested id appears (absent heartbeat →
 * `offline`).
 */
type PresenceMapResponse = Record<string, PresenceState>;

/**
 * Presence router, mounted at `/presence` by the routes barrel so the effective
 * path is `/api/presence`. Exported as `router` to match the barrel convention
 * (`import { router as presenceRouter } from './presence.js'`).
 */
export const router: Router = Router();

router.get(
  '/',
  requireAuth,
  validate({ query: presenceQuerySchema }),
  async (
    req: Request<unknown, PresenceMapResponse, unknown, PresenceQueryInput>,
    res: Response<PresenceMapResponse>,
  ): Promise<void> => {
    // `requireAuth` guarantees `req.user` is populated; the non-null assertion
    // narrows the optional Request augmentation.
    const userId = req.user!.id;
    // `validate({ query: presenceQuerySchema })` has parsed and transformed
    // `req.query.userIds` into a validated `string[]` of cuids.
    const userIds = req.query.userIds;

    const presence = await getPresenceMap(userIds);

    // Gate 10 structured log: requested id count only — never the ids.
    req.log.info(
      {
        component: 'presence.route',
        event: 'hydrate',
        userId,
        requestedCount: userIds.length,
      },
      'presence map hydration completed',
    );

    res.status(200).json(presence);
  },
);
