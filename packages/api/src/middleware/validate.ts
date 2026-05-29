import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Which property of the Express `Request` object to validate.
 */
type ValidateTarget = 'body' | 'query' | 'params';

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
 * On any validation failure the Zod `ZodError` is passed to `next(err)`
 * so that the centralized `errorHandler` middleware maps it to a 400
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
          next(parsed.error);
          return;
        }
        req.body = parsed.data;
      }

      if (schemas.query !== undefined) {
        const parsed = schemas.query.safeParse(req.query);
        if (!parsed.success) {
          next(parsed.error);
          return;
        }
        Object.assign(req.query, parsed.data);
      }

      if (schemas.params !== undefined) {
        const parsed = schemas.params.safeParse(req.params);
        if (!parsed.success) {
          next(parsed.error);
          return;
        }
        Object.assign(req.params, parsed.data);
      }

      next();
    };
  }

  const schema = schemaOrMap;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const source = req[target];
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }

    if (target === 'body') {
      req.body = parsed.data;
    } else {
      Object.assign(req[target], parsed.data);
    }

    next();
  };
}
