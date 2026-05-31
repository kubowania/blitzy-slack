/**
 * @app/api — Server bootstrap entry point.
 *
 * Responsibilities:
 *   1. Build the Express application via createApp() from ./app.js
 *   2. Wrap it in a Node http.Server so the same TCP listener serves both
 *      HTTP and WebSocket traffic (per Rule 2 and AAP §0.6.2)
 *   3. Construct a typed Socket.io Server and register its handlers from
 *      ./sockets/index.js
 *   4. Attach the @socket.io/redis-adapter (Rule 2) for horizontal scale
 *   5. Begin listening on env.PORT
 *   6. Wire SIGTERM / SIGINT handlers for graceful shutdown
 *
 * This file is the ONLY file in the API package that calls .listen() or mounts
 * process signal handlers. All other modules export factories or router objects
 * that this file composes; it exports nothing — its sole purpose is the
 * side-effect of starting the server. Design rationale lives in
 * /docs/decision-log.md (Explainability rule), not in these comments.
 */
import { createServer, type Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import { Server as IOServer } from 'socket.io';

import { prisma } from '@app/db';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { disconnectRedisClients, pubClient, subClient } from './config/redis.js';
import { registerSocketHandlers } from './sockets/index.js';

/**
 * Fully-typed Socket.io server bound to the shared real-time event contract
 * (AAP §0.4.5). Mirrors the `AppServer` alias inside ./sockets/index.ts so the
 * instance constructed here is assignable to {@link registerSocketHandlers}.
 */
type AppIOServer = IOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Window, in milliseconds, that Socket.io retains a disconnected client's state
 * so a brief network blip or tab-switch resumes without a fresh JWT handshake.
 */
const CONNECTION_RECOVERY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Hard-exit deadline, in milliseconds, applied once graceful shutdown begins;
 * aligned with Docker's default 10s SIGTERM→SIGKILL grace period.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Build the HTTP + WebSocket server, attach the Redis adapter, register socket
 * handlers, and begin listening. Resolves once the server is accepting
 * connections; rejects if the port cannot be bound (e.g. EADDRINUSE).
 */
async function bootstrap(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV, port: env.PORT }, 'Starting @app/api server');

  // 1. Build the Express application (helmet, cors, pino-http, body parser,
  //    routes, error-handler — see ./app.ts).
  const app = createApp();

  // 2. Wrap the Express app in a Node HTTP server so Socket.io can attach to
  //    the SAME TCP listener (per Rule 2 and AAP §0.6.2).
  const httpServer: HttpServer = createServer(app);

  // 3. Construct a typed Socket.io server on the same HTTP server. CORS is
  //    configured here for the WebSocket handshake; Express CORS is configured
  //    separately in ./app.ts for the HTTP routes.
  const io = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
    // Rule 2 — Real-time via WebSockets only. HTTP long-polling is forbidden,
    // so the transport list is restricted to the WebSocket upgrade. The client
    // (packages/web/src/lib/socket.ts) is pinned to the same single transport.
    transports: ['websocket'],
    connectionStateRecovery: {
      maxDisconnectionDuration: CONNECTION_RECOVERY_WINDOW_MS,
      skipMiddlewares: false,
    },
  });

  // 4. Attach the Redis adapter so emissions on any API instance reach
  //    subscribers connected to any other instance (Rule 2 — horizontal scale).
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.io Redis adapter attached');

  // 5. Expose the Socket.io server on the Express app so REST route handlers can
  //    retrieve it via `req.app.get('io')` and broadcast realtime events after a
  //    successful mutation (e.g. POST /api/messages -> message:new, the reaction
  //    routes -> reaction:added / reaction:removed). This MUST run before routes
  //    are exercised; otherwise `req.app.get('io')` is undefined and broadcasts
  //    silently no-op.
  app.set('io', io);

  // 6. Wire the JWT handshake middleware and every typed event handler
  //    (defined in ./sockets/index.ts and its handlers/ subfolder).
  registerSocketHandlers(io);

  // 7. Begin listening. Wrapped in a Promise so a bind failure (EADDRINUSE)
  //    rejects through bootstrap().catch() instead of going unobserved.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(env.PORT, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  logger.info({ port: env.PORT }, `API listening on http://localhost:${env.PORT}`);

  // 8. Register graceful-shutdown handlers only after we are listening, so a
  //    signal during bootstrap never tries to close a server that never opened.
  registerShutdownHandlers(httpServer, io);
}

/**
 * Install SIGTERM / SIGINT handlers that tear down the network, Redis, and
 * database layers in order, then exit. A hard-exit timer guarantees the process
 * never hangs on a stuck connection.
 *
 * @param httpServer - the Node HTTP server to stop accepting connections on.
 * @param io - the Socket.io server whose clients must be disconnected.
 */
function registerShutdownHandlers(httpServer: HttpServer, io: AppIOServer): void {
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, forcing exit');
      process.exit(1);
    }
    isShuttingDown = true;

    logger.info({ signal }, 'Received signal, beginning graceful shutdown');

    // Hard-exit if cleanup hangs. unref() so this timer never, on its own, keeps
    // the event loop (and therefore the process) alive after cleanup completes.
    const forceExitTimer = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    const cleanup = async (): Promise<void> => {
      try {
        // Stop accepting NEW connections immediately. Synchronous and not
        // awaited: Node's close callback only fires once every existing
        // connection — including long-lived WebSockets — has ended, and those
        // are drained by io.close() next, so awaiting here would deadlock.
        httpServer.close();
        logger.info('HTTP server stopped accepting new connections');

        // Disconnect every Socket.io client and finish closing the shared HTTP
        // server. socket.io's close() drops all sockets then closes the
        // underlying server, resolving even on a double-close.
        await io.close();
        logger.info('Socket.io server closed');

        // Release the Redis adapter pub/sub clients and the presence client.
        await disconnectRedisClients();
        logger.info('Redis clients disconnected');

        // Release the PostgreSQL connection pool.
        await prisma.$disconnect();
        logger.info('Prisma client disconnected');

        clearTimeout(forceExitTimer);
        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (err: unknown) {
        clearTimeout(forceExitTimer);
        logger.error(
          { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
          'Error during graceful shutdown',
        );
        process.exit(1);
      }
    };

    void cleanup();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap().catch((err: unknown) => {
  logger.fatal(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'Failed to bootstrap API server',
  );
  process.exit(1);
});
