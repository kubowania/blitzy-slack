/**
 * Centralized Express 5 error-handling middleware for the `@app/api` package.
 *
 * Mounted LAST in the Express app (after every route) by
 * `packages/api/src/app.ts` via `app.use(errorHandler)`. Express 5 forwards
 * BOTH synchronous `throw`s and rejected async-handler promises to error
 * middleware automatically, so this handler is the single source of error
 * formatting for the entire HTTP surface (AAP §0.8.4 — Error Bubbling Contract).
 *
 * Responsibilities:
 *   - Map every known error class to a stable HTTP status code.
 *   - Emit a uniform JSON payload: `{ error, message, code?, details? }`.
 *   - Log every failure with structured fields for Gate 10 observability
 *     (routine 4xx client errors at `warn`; unexpected 5xx at `error`).
 *   - Never leak internal error text, stack traces, DB metadata, or request
 *     bodies to the client.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation. That augmentation adds `log: pino.Logger` to `IncomingMessage`
// (which the Express `Request` extends), which is what types `req.log` below.
import type {} from 'pino-http';

import type { ErrorRequestHandler, Request } from 'express';
// `jsonwebtoken` and `multer` are CommonJS packages: their error classes are
// NOT exposed as ESM named exports under NodeNext, so they are imported as the
// default export (matching the auth.service.ts / upload.ts convention) and the
// error constructors are accessed as members for the `instanceof` guards below.
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { ZodError, type ZodIssue } from 'zod';

import { Prisma } from '@app/db';

import { logger as appLogger } from '../config/logger.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

/**
 * Canonical JSON shape returned for every error response.
 * `error` is a short machine-readable label (e.g., 'BadRequest');
 * `message` is a human-readable explanation;
 * `code` is an optional Prisma/Multer/JWT-specific code;
 * `details` carries Zod field-level issues for 400 responses.
 */
interface ErrorPayload {
  error: string;
  message: string;
  code?: string;
  details?: readonly { path: string; message: string; code: string }[];
}

const formatZodIssues = (
  issues: readonly ZodIssue[],
): readonly { path: string; message: string; code: string }[] =>
  issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

const resolveLogger = (req: Request) => {
  return req.log ?? appLogger;
};

/**
 * Express 5 error-handling middleware. Maps every known error class
 * to a stable HTTP status code, emits a uniform JSON payload, and
 * logs the failure with structured fields for Gate 10 observability.
 *
 * Express 5 forwards async-handler rejections to error middleware
 * automatically, so this handler covers BOTH sync `throw` and async
 * `await` rejection paths from routes and middleware.
 *
 * If the response has already begun streaming (`res.headersSent`),
 * we delegate to Express's default handler which terminates the
 * connection (per Express docs — the standard behavior).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next): void => {
  const log = resolveLogger(req);

  if (res.headersSent) {
    log.error({ err }, 'Error after response headers sent');
    next(err);
    return;
  }

  // 1. Zod validation errors (from validate.ts middleware)
  if (err instanceof ZodError) {
    const payload: ErrorPayload = {
      error: 'BadRequest',
      message: 'Request validation failed',
      details: formatZodIssues(err.issues),
    };
    log.warn({ err, issues: payload.details }, 'Validation error');
    res.status(400).json(payload);
    return;
  }

  // 2. Multer file-size errors → 413 Payload Too Large
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const payload: ErrorPayload = {
        error: 'PayloadTooLarge',
        message: 'Uploaded file exceeds the maximum allowed size',
        code: err.code,
      };
      log.warn({ err }, 'File upload too large');
      res.status(413).json(payload);
      return;
    }
    // Other multer errors (LIMIT_FIELD_COUNT, etc.) → 400
    const payload: ErrorPayload = {
      error: 'BadRequest',
      message: err.message,
      code: err.code,
    };
    log.warn({ err }, 'File upload rejected');
    res.status(400).json(payload);
    return;
  }

  // 3. JWT errors (defense in depth; requireAuth typically catches first)
  if (err instanceof jwt.TokenExpiredError) {
    const payload: ErrorPayload = {
      error: 'Unauthorized',
      message: 'Token has expired',
      code: 'token_expired',
    };
    log.warn({ err }, 'JWT expired');
    res.status(401).json(payload);
    return;
  }
  if (err instanceof jwt.JsonWebTokenError) {
    const payload: ErrorPayload = {
      error: 'Unauthorized',
      message: 'Invalid authentication token',
      code: 'token_invalid',
    };
    log.warn({ err }, 'JWT invalid');
    res.status(401).json(payload);
    return;
  }

  // 4. Prisma known errors → mapped by error code
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const payload: ErrorPayload = {
        error: 'Conflict',
        message: 'A record with the same unique value already exists',
        code: err.code,
      };
      log.warn({ err, prismaCode: err.code, meta: err.meta }, 'Prisma unique constraint violation');
      res.status(409).json(payload);
      return;
    }
    if (err.code === 'P2025') {
      const payload: ErrorPayload = {
        error: 'NotFound',
        message: 'The requested record was not found',
        code: err.code,
      };
      log.warn({ err, prismaCode: err.code, meta: err.meta }, 'Prisma record not found');
      res.status(404).json(payload);
      return;
    }
    // Any other known Prisma error → 500 (do NOT leak DB internals)
    log.error({ err, prismaCode: err.code, meta: err.meta }, 'Unhandled Prisma error');
    res.status(500).json({
      error: 'InternalServerError',
      message: 'A database error occurred',
    } satisfies ErrorPayload);
    return;
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    log.error({ err }, 'Prisma validation error');
    res.status(500).json({
      error: 'InternalServerError',
      message: 'A database query was malformed',
    } satisfies ErrorPayload);
    return;
  }

  // 5. Application-level custom errors (middleware/errors.ts)
  if (err instanceof ValidationError) {
    const payload: ErrorPayload = {
      error: 'BadRequest',
      message: err.message,
    };
    log.warn({ err }, 'Application validation error');
    res.status(400).json(payload);
    return;
  }
  if (err instanceof UnauthorizedError) {
    const payload: ErrorPayload = {
      error: 'Unauthorized',
      message: err.message,
      // Surface the typed classification (token_expired / token_invalid) when
      // the verifier supplied one; omitted for generic 401s.
      ...(err.code !== undefined ? { code: err.code } : {}),
    };
    log.warn({ err }, 'Unauthorized request');
    res.status(401).json(payload);
    return;
  }
  if (err instanceof ForbiddenError) {
    const payload: ErrorPayload = {
      error: 'Forbidden',
      message: err.message,
    };
    log.warn({ err }, 'Forbidden request');
    res.status(403).json(payload);
    return;
  }
  if (err instanceof NotFoundError) {
    const payload: ErrorPayload = {
      error: 'NotFound',
      message: err.message,
    };
    log.warn({ err }, 'Resource not found');
    res.status(404).json(payload);
    return;
  }
  if (err instanceof ConflictError) {
    const payload: ErrorPayload = {
      error: 'Conflict',
      message: err.message,
    };
    log.warn({ err }, 'Conflict');
    res.status(409).json(payload);
    return;
  }

  // 6. Catch-all for AppError instances with a custom statusCode
  if (err instanceof AppError) {
    const payload: ErrorPayload = {
      error: err.name || 'AppError',
      message: err.message,
    };
    log.error({ err, statusCode: err.statusCode }, 'Unhandled AppError subclass');
    res.status(err.statusCode).json(payload);
    return;
  }

  // 7. Unknown error → 500 (generic message; full error logged)
  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected error occurred',
  } satisfies ErrorPayload);
};
