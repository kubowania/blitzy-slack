import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { verifyToken } from '../services/auth.service.js';
import { UnauthorizedError } from './errors.js';

/**
 * Shape of the authenticated user attached to every request that
 * passes through `requireAuth`. Downstream handlers read this as
 * `req.user.id` and `req.user.email`.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
}

/**
 * Module augmentation: extend Express's core Request type with an
 * optional `user` field. Optional because not every route is
 * authenticated (e.g., /api/auth/login, /api/auth/register,
 * /api/health). Routes that DO use `requireAuth` are guaranteed
 * `req.user !== undefined` at the handler's entry — within authenticated
 * routes you can safely access `req.user!.id` or use a non-optional
 * helper.
 *
 * We augment `express-serve-static-core` (the package Express imports
 * Request from) rather than `express` directly — this is the canonical
 * Express 5 augmentation target.
 */
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Extracts the bearer token from the `Authorization` header. Returns
 * the raw token string (without the 'Bearer ' prefix) when present and
 * well-formed, otherwise `undefined`.
 *
 * Accepts only single-string Authorization headers. Multi-value
 * headers (Authorization arrays) are not supported by RFC 7235 and
 * are treated as missing.
 */
const extractBearerToken = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
};

/**
 * Express middleware that enforces JWT authentication on the request.
 *
 * Flow:
 *   1. Extract `Bearer <token>` from the `Authorization` header.
 *   2. Delegate verification to `verifyToken` (the SAME helper used by
 *      the Socket.io handshake middleware — AAP §0.8.4 single verifier).
 *   3. Attach the decoded identity to `req.user` for downstream handlers.
 *   4. On any failure, forward `UnauthorizedError` to the centralized
 *      error handler via `next(err)`. We never send a 401 response from
 *      here directly — error formatting is the error handler's job
 *      (AAP §0.8.4 Error Bubbling Contract).
 *
 * The middleware is synchronous: `verifyToken` is sync, and all checks
 * are sync. We declare it as `RequestHandler` (Express's standard
 * type) so it composes with `router.use(requireAuth)` and per-route
 * application identically.
 */
export const requireAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const token = extractBearerToken(req);
  if (token === undefined) {
    next(new UnauthorizedError('Missing or malformed Authorization header'));
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      next(err);
      return;
    }
    next(new UnauthorizedError('Invalid or expired token'));
  }
};
