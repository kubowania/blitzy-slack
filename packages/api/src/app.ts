/**
 * @app/api — Express application factory.
 *
 * `createApp()` constructs an Express 5 application with the middleware
 * pipeline mandated by AAP §0.6.1 Group 4:
 *
 *   helmet → cors → pino-http → JSON body parser → urlencoded body parser
 *     → /api router → 404 handler → centralized error handler
 *
 * The function is side-effect-free: it does NOT call .listen(), does NOT
 * connect to Postgres/Redis, and does NOT mount process signal handlers.
 * All side effects live in ./index.ts.
 *
 * The factory pattern enables both production composition (./index.ts wraps
 * the returned app in createServer() to attach Socket.io) and tests
 * (supertest(createApp()) per AAP §0.6.1 Group 4). Each invocation returns a
 * fresh, independent Application instance, so test suites may build one per
 * suite without shared state.
 *
 * Design rationale and trade-offs for the choices in this file (helmet CORP
 * cross-origin, environment-gated CSP, 1 MB body limit, CORS credentials, JSON
 * 404, and the deliberate omission of static file serving) are recorded in
 * /docs/decision-log.md per the Explainability rule (AAP §0.8.3), not in
 * these comments.
 */
import cors from 'cors';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { router } from './routes/index.js';

/**
 * Build and return a fully-configured Express 5 {@link Application}.
 *
 * The middleware pipeline is registered in the exact order mandated by
 * AAP §0.6.1 Group 4; reordering would break security headers or
 * request/log correlation. The function performs no IO and binds no port —
 * it is a pure factory.
 *
 * @returns A new, independent Express application with all middleware,
 *   the `/api` router, a JSON 404 handler, and the centralized error
 *   handler registered.
 */
export function createApp(): Application {
  const app: Application = express();

  // -----------------------------------------------------------------------
  // 0. Disable Express's default X-Powered-By header so we don't advertise
  //    our framework version (defense in depth; helmet also handles this).
  // -----------------------------------------------------------------------
  app.disable('x-powered-by');

  // -----------------------------------------------------------------------
  // 1. Trust the first proxy hop (e.g., Docker network, future reverse proxy)
  //    so req.ip and X-Forwarded-* headers reflect the real client. This is a
  //    defensive measure for audit logging (AAP §0.8.4 security baseline).
  // -----------------------------------------------------------------------
  app.set('trust proxy', 1);

  // -----------------------------------------------------------------------
  // 2. helmet — security headers (X-Frame-Options, X-Content-Type-Options,
  //    etc.). Per AAP §0.8.4 security baseline.
  // -----------------------------------------------------------------------
  app.use(
    helmet({
      // Allow uploaded files to be embedded by the web client across the dev
      // server origin. Without this, <img src="http://localhost:3000/..."> from
      // http://localhost:5173 is blocked by Cross-Origin-Resource-Policy.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // CSP is enforced in production but relaxed (disabled) outside it, where
      // Vite HMR injects inline scripts and Tailwind v4 injects inline styles
      // that a strict policy would block. (Trade-off in /docs/decision-log.md.)
      contentSecurityPolicy:
        env.NODE_ENV === 'production'
          ? {
              useDefaults: true,
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                objectSrc: ["'none'"],
                // Removed so a PoC served over plain HTTP is not force-upgraded
                // to HTTPS; re-enable behind TLS termination in a real deploy.
                upgradeInsecureRequests: null,
              },
            }
          : false,
    }),
  );

  // -----------------------------------------------------------------------
  // 3. CORS — allow the Vite dev server origin (env.CORS_ORIGIN). Credentials
  //    are enabled so future cookie-based auth works without an API change;
  //    the current PoC uses bearer JWTs. Per AAP §0.1.2 and §0.8.4.
  // -----------------------------------------------------------------------
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400, // 24 h preflight cache
    }),
  );

  // -----------------------------------------------------------------------
  // 4. Request logging — pino-http via the requestLogger middleware. Adds a
  //    per-request `reqId` and logs method, path, statusCode, and latency in
  //    structured JSON (AAP §0.8.2 Gate 10).
  // -----------------------------------------------------------------------
  app.use(requestLogger);

  // -----------------------------------------------------------------------
  // 5. Body parsers. JSON and urlencoded payloads are capped at 1 MB; binary
  //    uploads are NOT parsed here — multer handles multipart per-route with
  //    its own MAX_FILE_SIZE_MB limit. extended:false uses the built-in
  //    querystring parser (smaller dependency surface).
  // -----------------------------------------------------------------------
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // -----------------------------------------------------------------------
  // 6. Routes — every business route is mounted under /api by the router
  //    barrel from ./routes/index.ts (AAP §0.4.1 HTTP REST under /api/*). The
  //    router owns its own internal mounting (/auth, /channels, …).
  // -----------------------------------------------------------------------
  app.use('/api', router);

  // -----------------------------------------------------------------------
  // 7. 404 handler — any path not matched by the router falls through here and
  //    is formatted as a JSON 404. MUST be registered AFTER all routes and
  //    BEFORE the centralized error handler. `_next` is declared to document
  //    the terminal position in the chain even though it is never invoked.
  // -----------------------------------------------------------------------
  app.use((req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({
      error: 'Not Found',
      message: `No route matched ${req.method} ${req.path}`,
      path: req.path,
    });
  });

  // -----------------------------------------------------------------------
  // 8. Centralized error handler — Express 4-arg error middleware. MUST be
  //    last in the pipeline. Maps ZodError→400, Prisma errors→404/409,
  //    MulterError→413, and unknown errors→500, logging each through Pino
  //    (AAP §0.8.2 Gate 10).
  // -----------------------------------------------------------------------
  app.use(errorHandler);

  // -----------------------------------------------------------------------
  // 9. Diagnostic log — the factory has finished assembling the app. Emitted
  //    at debug so it stays out of production logs but aids local verification.
  // -----------------------------------------------------------------------
  logger.debug('Express app factory complete');

  return app;
}
