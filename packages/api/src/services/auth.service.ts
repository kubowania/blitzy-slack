/**
 * Authentication service — registration, login, JWT issuance, and JWT
 * verification for the `@app/api` package.
 *
 * Public surface:
 *   registerUser(input)    → { token, user }   (issues a JWT for a new account)
 *   loginUser(input)       → { token, user }   (issues a JWT for valid credentials)
 *   verifyToken(token)     → AuthTokenPayload  (the single verifier shared by the
 *                                               HTTP Bearer middleware and the
 *                                               Socket.io handshake middleware)
 *   getMe(userId)          → UserResponse      (resolves the authenticated self view)
 *
 * Layering: this module is a service — it is the only layer permitted to touch
 * the Prisma client directly. It never imports `express` or `socket.io`, never
 * writes to an HTTP response, and never emits a socket event. All failures
 * surface as thrown errors that the error-handler middleware maps to HTTP
 * status codes.
 *
 * Security invariants (contract honored by this file):
 *  - `passwordHash` is NEVER placed in a returned DTO — every public return value
 *    is funneled through {@link toUserDto}, which omits it.
 *  - `passwordHash` and the JWT are NEVER passed to the logger.
 *  - Passwords are hashed with `bcryptjs` at the `env.BCRYPT_ROUNDS` cost factor.
 *  - JWTs are signed and verified with HS256 only; `verifyToken` pins the
 *    accepted algorithm set so a token presented with a different algorithm
 *    (e.g. `none`) is rejected.
 *  - A duplicate-email insert surfaces Prisma's `P2002` error UNWRAPPED: this
 *    service does not catch it, so the error-handler can map it to HTTP 409
 *    (the idempotency contract the seed flow depends on).
 *  - Login failures throw a single uniform error for both unknown-email and
 *    wrong-password cases.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { SignOptions, JwtPayload as RawJwtPayload } from 'jsonwebtoken';

import { prisma } from '@app/db';
import type { User as PrismaUser } from '@app/db';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { UnauthorizedError, NotFoundError } from '../middleware/errors.js';

import type { UserResponse } from '@app/shared/types/user';
import type { RegisterInput, LoginInput } from '@app/shared/schemas/auth';

/**
 * Result of {@link register} and {@link login}: a freshly signed JWT plus the
 * account-owner self view. The `user` field is a {@link UserResponse}, which by
 * construction carries no `passwordHash`.
 */
export interface AuthResult {
  /** Signed HS256 JWT bearing the user's id (`sub`) and `email`. */
  token: string;
  /** Account-owner self view DTO (never includes `passwordHash`). */
  user: UserResponse;
}

/**
 * The validated payload {@link verifyToken} returns to its callers.
 *
 * `sub` is the user id (also the JWT `sub` registered claim); `email` is
 * denormalized into the token so the Socket.io handshake can attach an
 * identity without a database round-trip. The `iat`/`exp` claims are managed by
 * `jsonwebtoken` and are intentionally not surfaced here.
 */
export interface AuthTokenPayload {
  /** User id (the JWT `sub` claim). */
  sub: string;
  /** User email (denormalized into the token). */
  email: string;
}

/**
 * Project a Prisma `User` row onto the public {@link UserResponse} DTO.
 *
 * This is the sole boundary between the persistence model (which carries
 * `passwordHash`) and the network/socket shapes: `passwordHash` is omitted by
 * listing fields explicitly, and the `Date` columns are serialized to ISO 8601
 * strings to match the DTO contract. Every public function returns through this
 * mapper.
 */
function toUserDto(record: PrismaUser): UserResponse {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Sign an HS256 JWT for the given user, expiring per `env.JWT_EXPIRES_IN`.
 *
 * The `expiresIn` assertion is required because `jsonwebtoken` types the option
 * as a narrow `StringValue | number` union while `env.JWT_EXPIRES_IN` is a
 * validated free-form duration string (e.g. `'7d'`); it is the only type
 * assertion in this file.
 */
function signToken(user: PrismaUser): string {
  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
  };
  const options: SignOptions = {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

/**
 * Verify a JWT and return its typed payload. Throws {@link UnauthorizedError} on
 * any verification failure — expired, malformed, signature mismatch, or an
 * unaccepted algorithm — with a uniform message that leaks no detail about which
 * check failed.
 *
 * This is the single JWT verifier shared by the HTTP `Authorization: Bearer`
 * middleware and the Socket.io handshake middleware.
 */
export function verifyToken(token: string): AuthTokenPayload {
  let decoded: string | RawJwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    logger.debug({ err }, 'auth.verifyToken.failed');
    // Classify the verification failure so the HTTP layer can return a stable
    // machine-readable `code`. `TokenExpiredError` extends `JsonWebTokenError`,
    // so it MUST be checked first; otherwise the broader guard would shadow it.
    // Any non-JWT error falls through to a generic 401 with no code (no detail
    // about which check failed is leaked in the message).
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token has expired', 'token_expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new UnauthorizedError('Invalid authentication token', 'token_invalid');
    }
    throw new UnauthorizedError('Invalid or expired token');
  }

  // `jwt.verify` yields a bare string only for non-JSON payloads, which this
  // service never signs. Viewing the object payload as Record<string, unknown>
  // keeps the `any` from JwtPayload's index signature out of the typed result
  // (`decoded` is itself a typed payload here, so this view is type-safe).
  if (typeof decoded === 'string') {
    throw new UnauthorizedError('Invalid token payload');
  }
  const claims: Record<string, unknown> = decoded;
  const sub = claims.sub;
  const email = claims.email;
  if (typeof sub !== 'string' || typeof email !== 'string') {
    throw new UnauthorizedError('Invalid token payload');
  }

  return { sub, email };
}

/**
 * Register a new user: hash the password, insert the `User` row, sign a JWT, and
 * return the token with the self-view DTO.
 *
 * The `prisma.user.create` call is intentionally not wrapped in a try/catch: a
 * duplicate email raises `PrismaClientKnownRequestError` (`P2002`), which must
 * propagate to the error-handler middleware to become an HTTP 409.
 *
 * @param input - Registration payload already validated by the route's
 *                `validate(registerSchema)` middleware.
 */
export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

  const created = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    },
  });

  const token = signToken(created);
  logger.info({ userId: created.id }, 'auth.register.success');
  return { token, user: toUserDto(created) };
}

/**
 * Authenticate an existing user by email and password.
 *
 * The bcrypt comparison runs only when a matching user exists; both the
 * unknown-email and wrong-password paths converge on the same
 * {@link UnauthorizedError} message so the response does not reveal whether an
 * account exists.
 *
 * @param input - Login payload already validated by the route's
 *                `validate(loginSchema)` middleware.
 */
export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });

  const isValid = user !== null && (await bcrypt.compare(input.password, user.passwordHash));

  if (user === null || !isValid) {
    logger.debug('auth.login.failed');
    throw new UnauthorizedError('Invalid email or password');
  }

  const token = signToken(user);
  logger.info({ userId: user.id }, 'auth.login.success');
  return { token, user: toUserDto(user) };
}

/**
 * Resolve the account-owner self view for an authenticated user id (backs
 * `GET /api/auth/me`). Throws {@link NotFoundError} when the id no longer
 * resolves — e.g. a deleted account presenting an otherwise-valid token.
 */
export async function getMe(userId: string): Promise<UserResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (user === null) {
    throw new NotFoundError('User not found');
  }
  return toUserDto(user);
}
