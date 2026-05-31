/**
 * @app/api — User-directory route (AUTH REQUIRED).
 *
 * GET /api/users?q=<text>
 *   200 PublicUser[] — up to MAX_USER_SEARCH_RESULTS peers, ordered by displayName
 *   400 ValidationError (ZodError) when `q` exceeds the displayName length cap
 *   401 UnauthorizedError when the Authorization bearer token is missing or invalid
 *
 * Powers the "Start a direct message" people picker (StartDmDialog). `q` is
 * OPTIONAL: omit it to list the first page of users; supply it for a
 * case-insensitive displayName substring match. The authenticated caller is
 * always excluded from the results (you cannot DM yourself), and email is never
 * searched or returned (privacy — results are `PublicUser`).
 *
 * Observability (Gate 10): the request-scoped Pino child logger emits a single
 * structured line carrying the query LENGTH and result count — never the raw
 * query string.
 *
 * NO Socket.io emissions — this is a pure read.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which types `req.log` below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';

import { userSearchQuerySchema } from '@app/shared/schemas/user';
import type { UserSearchQueryInput } from '@app/shared/schemas/user';
import type { PublicUser } from '@app/shared/types/user';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { searchUsers } from '../services/users.service.js';

/**
 * User-directory router, mounted at `/users` by the routes barrel so the
 * effective path is `/api/users`. Exported as `router` to match the barrel
 * convention (`import { router as usersRouter } from './users.js'`).
 */
export const router: Router = Router();

router.get(
  '/',
  requireAuth,
  validate({ query: userSearchQuerySchema }),
  async (
    req: Request<unknown, PublicUser[], unknown, UserSearchQueryInput>,
    res: Response<PublicUser[]>,
  ): Promise<void> => {
    // `requireAuth` guarantees `req.user` is populated; the non-null assertion
    // narrows the optional Request augmentation.
    const userId = req.user!.id;
    // `validate({ query: userSearchQuerySchema })` has parsed `req.query`, so
    // `q` is either a trimmed, length-bounded string or undefined.
    const query = req.query.q;

    const users = await searchUsers({ query, excludeUserId: userId });

    // Gate 10 structured log: query length and result count only — never the
    // raw query string (it may contain a person's name).
    req.log.info(
      {
        component: 'users.route',
        event: 'search',
        userId,
        queryLength: query?.length ?? 0,
        resultCount: users.length,
      },
      'user search completed',
    );

    res.status(200).json(users);
  },
);
