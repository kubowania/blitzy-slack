/**
 * @app/api — Authentication routes.
 *
 * POST /api/auth/register — PUBLIC. Returns 201 with { token, user }.
 *   On duplicate email: 409 (Prisma P2002 → the centralized error handler).
 *   This is the Rule 4 entry point for `scripts/seed-via-api.ts`.
 *
 * POST /api/auth/login — PUBLIC. Returns 200 with { token, user }.
 *   On invalid credentials: 401 (uniform error to prevent account enumeration).
 *
 * GET /api/auth/me — AUTH REQUIRED. Returns 200 with the account-owner self view.
 *   On expired/invalid/missing JWT: 401 (handled by the requireAuth middleware).
 *
 * Every handler delegates password hashing, JWT issuance/verification, and
 * persistence to services/auth.service.ts; this file never touches Prisma,
 * bcrypt, jsonwebtoken, or Redis directly. Errors thrown by the service and
 * middleware layers (ConflictError / Prisma P2002, UnauthorizedError,
 * NotFoundError, ValidationError) propagate to the centralized error handler,
 * so the handlers carry no try/catch. Rationale and trade-offs for the choices
 * in this file live in /docs/decision-log.md per the Explainability rule
 * (AAP §0.8.3), not in these comments.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which adds `log: pino.Logger` to IncomingMessage (the type the
// Express Request extends) — this is what types `req.log` in the handlers below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';

import { loginSchema, registerSchema } from '@app/shared/schemas/auth';
import type { LoginInput, RegisterInput } from '@app/shared/schemas/auth';
import type { UserResponse } from '@app/shared/types/user';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getMe, loginUser, registerUser } from '../services/auth.service.js';
import type { AuthResult } from '../services/auth.service.js';

/**
 * Authentication router, mounted at `/auth` by the routes barrel so the
 * effective paths are `/api/auth/*`. Exported as `router` to match the barrel
 * convention (`import { router as authRouter } from './auth.js'`).
 */
export const router: Router = Router();

router.post(
  '/register',
  validate(registerSchema),
  async (req: Request<unknown, AuthResult, RegisterInput>, res: Response<AuthResult>) => {
    // The service hashes the password, inserts the user, and issues a JWT. A
    // duplicate email surfaces Prisma's P2002 UNWRAPPED; the centralized error
    // handler maps it to HTTP 409, which the seed flow treats as idempotent
    // success (Rule 4) — so this handler deliberately does NOT catch it.
    const result = await registerUser(req.body);

    req.log.info(
      {
        component: 'auth.route',
        event: 'register',
        userId: result.user.id,
        email: result.user.email,
      },
      'user registered',
    );

    res.status(201).json(result);
  },
);

router.post(
  '/login',
  validate(loginSchema),
  async (req: Request<unknown, AuthResult, LoginInput>, res: Response<AuthResult>) => {
    // The service verifies the password and issues a JWT. On bad credentials it
    // throws a uniform UnauthorizedError → the error handler returns 401.
    const result = await loginUser(req.body);

    req.log.info(
      { component: 'auth.route', event: 'login', userId: result.user.id, email: result.user.email },
      'user logged in',
    );

    res.status(200).json(result);
  },
);

router.get('/me', requireAuth, async (req: Request, res: Response<UserResponse>) => {
  // requireAuth guarantees req.user is populated when this handler runs; the
  // non-null assertion expresses that middleware contract. The service returns
  // the passwordHash-free self view, or throws NotFoundError → 404 if the
  // account was deleted after the token was issued.
  const userId = req.user!.id;

  const user = await getMe(userId);

  res.status(200).json(user);
});
