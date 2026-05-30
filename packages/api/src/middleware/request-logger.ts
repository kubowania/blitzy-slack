import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';
import { pinoHttp, type HttpLogger } from 'pino-http';

import { logger } from '../config/logger.js';

/**
 * Express middleware that wraps the application Pino logger with HTTP
 * request context. Every request receives a stable `reqId` (UUID v4), a
 * child logger (`req.log`), and per-request log lines for both inbound
 * receipt and outbound response.
 *
 * Conventions enforced here (Gate 10 + AAP §0.8.4):
 *
 * - `reqId` is a freshly generated UUID v4; `genReqId` is invoked once
 *   per request before any handler sees `req.id`.
 * - The custom `customLogLevel` maps response status codes to severity:
 *   2xx/3xx → info, 4xx → warn, 5xx → error. Requests that error out
 *   before producing a response (`err` populated) are logged at error.
 * - The `/api/health` endpoint is silenced at info level so the Makefile
 *   readiness poll (every 2 seconds during `make local`) does not flood
 *   logs; 4xx/5xx responses on `/api/health` STILL log normally so real
 *   problems surface.
 * - `serializers` strip noisy fields and surface only the request
 *   metadata operators need: method, url, remote address, request id.
 * - `customProps` injects `userId` from `req.user.id` when present (set
 *   by the `requireAuth` middleware downstream).
 *
 * Sensitive fields (Authorization header, cookies, password bodies) are
 * already redacted at the application logger level in
 * `../config/logger.js`; pino-http inherits that redaction.
 */
export const requestLogger: HttpLogger<Request, Response> = pinoHttp({
  logger,
  genReqId: (_req: Request, res: Response): string => {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (req: Request, res: Response, err) => {
    if (err !== undefined && err !== null) {
      return 'error';
    }
    if (res.statusCode >= 500) {
      return 'error';
    }
    if (res.statusCode >= 400) {
      return 'warn';
    }
    if (req.url === '/api/health') {
      return 'silent';
    }
    return 'info';
  },
  customSuccessMessage: (req: Request, res: Response) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req: Request, res: Response) => {
    return `${req.method} ${req.url} ${res.statusCode} ERROR`;
  },
  customProps: (req: Request) => {
    const userId = req.user?.id;
    return userId !== undefined ? { userId } : {};
  },
  serializers: {
    req: (req: Request & { id?: string }) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.ip,
    }),
    res: (res: Response) => ({
      statusCode: res.statusCode,
    }),
  },
});
