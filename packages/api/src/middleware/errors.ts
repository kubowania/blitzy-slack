/**
 * Typed domain error classes shared across the API.
 *
 * Services throw these instead of writing HTTP responses directly. The
 * error-handler middleware reads each error's `statusCode` to build the HTTP
 * response. Prisma's own known-request errors are mapped separately by the
 * error-handler via code matching and are not wrapped here.
 *
 * Status code mapping:
 *   UnauthorizedError → 401
 *   ForbiddenError    → 403
 *   NotFoundError     → 404
 *   ConflictError     → 409
 *   ValidationError   → 400
 *   AppError          → caller-supplied `statusCode`
 *
 * Design rationale and trade-offs are recorded in /docs/decision-log.md.
 */

/**
 * Field-level validation error details keyed by request-field path.
 * Mirrors the shape of Zod's `error.flatten().fieldErrors`.
 */
export type ValidationFieldErrors = Record<string, string[] | undefined>;

/**
 * Base class for all service-thrown domain errors. Each concrete subclass
 * exposes a `statusCode` that the error-handler maps to an HTTP status. The
 * constructor restores the prototype chain (so `instanceof` holds across
 * module boundaries), sets `name` to the concrete class name, and captures a
 * V8 stack trace when available.
 */
export abstract class ServiceError extends Error {
  /** HTTP status code the error-handler returns for this error. */
  public abstract readonly statusCode: number;

  protected constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * 401 Unauthorized — the request lacks valid authentication.
 *
 * Carries an optional machine-readable `code` (e.g. `'token_expired'`,
 * `'token_invalid'`) that the error-handler surfaces in the JSON payload so
 * clients can distinguish an expired session (refresh/re-login) from a
 * malformed/tampered token. The code is omitted for generic 401s (missing
 * header, bad credentials) where no finer classification applies.
 */
export class UnauthorizedError extends ServiceError {
  public readonly statusCode = 401;
  public readonly code?: string;

  public constructor(message = 'Unauthorized', code?: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 403 Forbidden — authenticated but the caller lacks permission.
 */
export class ForbiddenError extends ServiceError {
  public readonly statusCode = 403;

  public constructor(message = 'Forbidden') {
    super(message);
  }
}

/**
 * 404 Not Found — the requested resource does not exist.
 */
export class NotFoundError extends ServiceError {
  public readonly statusCode = 404;

  public constructor(message = 'Not found') {
    super(message);
  }
}

/**
 * 409 Conflict — a uniqueness or state precondition is violated.
 */
export class ConflictError extends ServiceError {
  public readonly statusCode = 409;

  public constructor(message = 'Conflict') {
    super(message);
  }
}

/**
 * 400 Bad Request — a request payload or service-layer invariant is invalid.
 *
 * Carries optional `details` (field path → messages) so the error-handler can
 * surface per-field validation feedback. The `validate` middleware wraps Zod
 * failures in this class with `details` populated from `error.flatten()`.
 */
export class ValidationError extends ServiceError {
  public readonly statusCode = 400;
  public readonly details?: ValidationFieldErrors;

  public constructor(message = 'Validation failed', details?: ValidationFieldErrors) {
    super(message);
    this.details = details;
  }
}

/**
 * Generic application error carrying an explicit HTTP status code, for cases
 * the named domain errors above do not cover.
 */
export class AppError extends ServiceError {
  public readonly statusCode: number;

  public constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
