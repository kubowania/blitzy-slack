/**
 * @app/api — Full-text search route (AUTH REQUIRED).
 *
 * GET /api/search?q=<text>
 *   200 { results: MessageWithAuthor[], query: string } — matches, most relevant first
 *   400 ValidationError (ZodError) when `q` is missing, empty, or exceeds 200 chars
 *   401 UnauthorizedError when the Authorization bearer token is missing or invalid
 *
 * ACL: results are restricted to messages in channels the caller is a member
 *      of, DMs they participate in, OR any public channel. The filter is
 *      enforced inside the service via the search SQL's WHERE clause; this
 *      route adds no further filtering or sorting.
 *
 * Performance (Gate 9): the service matches against the `tsvector` generated
 * column on Message.content, backed by a GIN index, keeping latency under the
 * <2s budget. The page is bounded to PAGE_SIZE results.
 *
 * Observability (Gate 10): the request-scoped Pino child logger (`req.log`)
 * emits a single structured `search` line carrying the query LENGTH and result
 * count — never the raw query string.
 *
 * NO Socket.io emissions — search is a pure read.
 * NO advanced filters in the PoC (date range, channel, author, content-type
 * are out of scope per AAP §0.7.2); only `?q=<text>` is supported.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation. That augmentation adds `log: pino.Logger` to `IncomingMessage`
// (which the Express `Request` extends), which is what types `req.log` below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';

import { searchQuerySchema } from '@app/shared/schemas/message';
import type { SearchQueryInput } from '@app/shared/schemas/message';
import type { SearchResponse } from '@app/shared/types/message';
import { PAGE_SIZE } from '@app/shared/constants/limits';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { searchMessages } from '../services/search.service.js';

/**
/**
 * Search router, mounted at `/search` by the routes barrel so the effective
 * path is `/api/search`. Exported as `router` to match the barrel convention
 * (`import { router as searchRouter } from './search.js'`).
 */
export const router: Router = Router();

router.get(
  '/',
  requireAuth,
  validate({ query: searchQuerySchema }),
  async (
    req: Request<unknown, SearchResponse, unknown, SearchQueryInput>,
    res: Response<SearchResponse>,
  ): Promise<void> => {
    // `requireAuth` guarantees `req.user` is populated before this handler
    // runs; the non-null assertion narrows the optional Request augmentation.
    const userId = req.user!.id;
    // `validate({ query: searchQuerySchema })` has parsed `req.query`, so `q`
    // is a trimmed, non-empty, length-bounded (1..200) string.
    const query = req.query.q;

    // The service performs the tsvector + GIN search, applies the ACL filter
    // (member channels OR participant DMs OR public channels), and returns the
    // most relevant matches bounded by `limit`.
    const results = await searchMessages({
      userId,
      query,
      limit: PAGE_SIZE,
    });

    // Gate 10 structured log: query length and result count only — the raw
    // query string is never logged.
    req.log.info(
      {
        component: 'search.route',
        event: 'search',
        userId,
        queryLength: query.length,
        resultCount: results.length,
      },
      'message search completed',
    );

    res.status(200).json({ results, query });
  },
);
