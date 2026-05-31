import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodError, ZodTypeAny } from 'zod';

import { ValidationError } from './errors.js';

/**
 * Which property of the Express `Request` object to validate.
 */
type ValidateTarget = 'body' | 'query' | 'params';

/**
 * Wrap a Zod failure in the project `ValidationError` (HTTP 400) so the
 * centralized error-handler maps every validation failure uniformly. The
 * flattened field errors are attached as `details` for per-field feedback.
 */
function toValidationError(error: ZodError, source: ValidateTarget): ValidationError {
  return new ValidationError(`Invalid request ${source}`, error.flatten().fieldErrors);
}

/**
 * Multi-source schema map for the overload that validates multiple request
 * properties in a single middleware pass.
 */
interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Type guard: true when the argument is a `ValidateSchemas` map (the
 * multi-source overload) rather than a single Zod schema (the
 * single-target overload). The discriminator is the absence of the Zod
 * `_def` property, which every Zod schema carries.
 */
function isSchemaMap(candidate: ZodTypeAny | ValidateSchemas): candidate is ValidateSchemas {
  return !('_def' in candidate);
}

/**
 * Write the parsed (and possibly Zod-`.transform()`-coerced) value back onto a
 * non-body request target so downstream handlers observe the typed shape.
 *
 * Express 5 exposes `req.query` as a lazily-recomputed GETTER on the request
 * prototype: a plain assignment throws (getter-only) and `Object.assign(req.query, …)`
 * mutates a throwaway object that the next `req.query` access discards — so a
 * transforming schema's output (e.g. the presence `userIds` string→string[]
 * coercion, or a paginating `limit` string→number coercion) is silently lost,
 * leaving the handler with the raw string. Defining an OWN, configurable data
 * property shadows the prototype getter so the parsed value persists for the
 * remainder of the request. `req.params` is a writable own property set by the
 * router, so the same definition applies uniformly and also survives a future
 * transforming params schema. Rationale recorded in /docs/decision-log.md.
 */
function applyValidated(
  req: Request,
  target: Exclude<ValidateTarget, 'body'>,
  data: unknown,
): void {
  Object.defineProperty(req, target, {
    value: data,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Build an Express middleware that validates a single request property
 * (body | query | params) against the supplied Zod schema. On success,
 * the parsed (potentially transformed) data is written back to
 * `req[target]` so downstream handlers see the typed shape.
 *
 * Overload 1: validate a single target. Default target is `'body'`.
 */
export function validate(schema: ZodTypeAny, target?: ValidateTarget): RequestHandler;

/**
 * Build an Express middleware that validates multiple request properties
 * in a single pass. The schemas map declares which properties to
 * validate; missing keys are skipped.
 *
 * Overload 2: validate a multi-source map.
 */
export function validate(schemas: ValidateSchemas): RequestHandler;

/**
 * Implementation of both overloads. The runtime dispatches based on
 * whether the first argument is a single Zod schema or a schemas map.
 *
 * On any validation failure the Zod error is wrapped in the project
 * `ValidationError` (HTTP 400) via `toValidationError` and passed to
 * `next(err)` so the centralized `errorHandler` emits a uniform 400
 * response with field-level error details.
 */
export function validate(
  schemaOrMap: ZodTypeAny | ValidateSchemas,
  target: ValidateTarget = 'body',
): RequestHandler {
  if (isSchemaMap(schemaOrMap)) {
    const schemas = schemaOrMap;
    return (req: Request, _res: Response, next: NextFunction): void => {
      if (schemas.body !== undefined) {
        const parsed = schemas.body.safeParse(req.body);
        if (!parsed.success) {
          next(toValidationError(parsed.error, 'body'));
          return;
        }
        const data: unknown = parsed.data;
        req.body = data;
      }

      if (schemas.query !== undefined) {
        const parsed = schemas.query.safeParse(req.query);
        if (!parsed.success) {
          next(toValidationError(parsed.error, 'query'));
          return;
        }
        applyValidated(req, 'query', parsed.data);
      }

      if (schemas.params !== undefined) {
        const parsed = schemas.params.safeParse(req.params);
        if (!parsed.success) {
          next(toValidationError(parsed.error, 'params'));
          return;
        }
        applyValidated(req, 'params', parsed.data);
      }

      next();
    };
  }

  const schema = schemaOrMap;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const source: unknown = req[target];
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      next(toValidationError(parsed.error, target));
      return;
    }

    const data: unknown = parsed.data;
    if (target === 'body') {
      req.body = data;
    } else {
      applyValidated(req, target, data);
    }

    next();
  };
}
