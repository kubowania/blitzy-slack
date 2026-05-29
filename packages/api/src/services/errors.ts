/**
 * Custom error classes shared across all service modules.
 *
 * Services throw these typed errors instead of returning HTTP responses
 * directly (a service never calls `res.status(...).json(...)`). The
 * error-handler middleware (see middleware/error-handler.ts) uses `instanceof`
 * checks to map each error class to its HTTP status code:
 *
 *   UnauthorizedError → 401
 *   ForbiddenError    → 403
 *   NotFoundError     → 404
 *   ConflictError     → 409
 *   ValidationError   → 400
 *   AppError          → its own `statusCode` field
 *
 * Prisma's own error class (Prisma.PrismaClientKnownRequestError) is handled
 * separately by the error-handler via code matching (P2002 → 409, P2025 → 404),
 * so it is intentionally NOT wrapped here.
 *
 * This module has zero imports — every class extends the built-in `Error`. It
 * is the lowest level of the services dependency tree; all other service
 * modules and the error-handler middleware import the classes from here so that
 * `instanceof` identity is preserved across module boundaries.
 *
 * Rationale for this shared-module pattern is recorded in /docs/decision-log.md
 * (Explainability rule); this file carries no embedded "why" rationale.
 */

/**
 * Base class for all service-thrown domain errors.
 *
 * Subclasses set their own `name` (via `new.target`) for clear log output and
 * provide stable class identity for the `instanceof` checks performed by the
 * error-handler middleware. The constructor restores the prototype chain so
 * `instanceof` remains reliable across module boundaries and captures a V8
 * stack trace that omits the constructor frame.
 *
 * Declared `abstract` so it is never thrown directly — the concrete subclasses
 * below are the public contract.
 */
export abstract class ServiceError extends Error {
  public constructor(message: string) {
    super(message);
    // Restore the prototype chain so `instanceof` works across module
    // boundaries when extending the built-in Error (TypeScript + NodeNext).
    Object.setPrototypeOf(this, new.target.prototype);
    // Set `name` to the concrete subclass name for stack traces and logs.
    this.name = new.target.name;
    // `Error.captureStackTrace` is a V8-only API; the typeof guard keeps this
    // safe on engines that do not provide it.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * 401 Unauthorized — the request lacks valid authentication.
 *
 * Thrown by auth.service when a JWT is missing, invalid, or expired, or when
 * login credentials do not match. The error-handler maps this to HTTP 401,
 * using a uniform generic message to avoid user enumeration.
 */
export class UnauthorizedError extends ServiceError {
  public constructor(message = 'Unauthorized') {
    super(message);
  }
}

/**
 * 403 Forbidden — the request is authenticated but the caller lacks permission.
 *
 * Thrown when a caller is not a member of a private channel, is not a
 * participant in a requested DM, attempts to start a DM with themselves, or
 * otherwise acts on a resource they cannot access. The error-handler maps this
 * to HTTP 403.
 */
export class ForbiddenError extends ServiceError {
  public constructor(message = 'Forbidden') {
    super(message);
  }
}

/**
 * 404 Not Found — the requested resource does not exist.
 *
 * Thrown when a required entity lookup returns null — an unknown channel, DM,
 * file, or parent message, or a user id taken from a JWT that no longer exists.
 * The error-handler maps this to HTTP 404.
 */
export class NotFoundError extends ServiceError {
  public constructor(message = 'Not found') {
    super(message);
  }
}

/**
 * 409 Conflict — a uniqueness or state precondition is violated.
 *
 * Thrown for non-Prisma duplicate or state conflicts. Prisma's own unique-
 * constraint error (P2002) is detected by code in the error-handler and is NOT
 * wrapped in this class, which preserves the registration idempotency contract.
 * The error-handler maps this to HTTP 409.
 */
export class ConflictError extends ServiceError {
  public constructor(message = 'Conflict') {
    super(message);
  }
}

/**
 * 400 Bad Request — a service-layer semantic invariant was violated.
 *
 * Thrown for value-level checks that Zod's structural validation cannot express
 * (for example, the message XOR rule requiring exactly one of channelId or
 * dmId to be set). Schema-shape violations are handled earlier by the validate
 * middleware at the route layer, not by this class. The error-handler maps this
 * to HTTP 400.
 */
export class ValidationError extends ServiceError {
  public constructor(message = 'Validation failed') {
    super(message);
  }
}

/**
 * Generic application error that carries an explicit HTTP status code.
 *
 * Used when a service needs to signal a status that the named domain errors
 * above do not cover; the error-handler reads `statusCode` directly instead of
 * inferring it from the class identity. The named errors above remain the
 * preferred surface for the common 400 / 401 / 403 / 404 / 409 cases.
 */
export class AppError extends ServiceError {
  public readonly statusCode: number;

  public constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
