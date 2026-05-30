/**
 * Socket.io server composition for the `@app/api` package.
 *
 * Exposes a single entry point, {@link registerSocketHandlers}, that wires the
 * JWT handshake middleware and every per-connection event handler onto an
 * already-constructed Socket.io `Server`. The parent module
 * (`packages/api/src/index.ts`) owns server construction: it creates the HTTP
 * server, instantiates the typed `Server` (CORS + connectionStateRecovery), and
 * attaches the `@socket.io/redis-adapter`; it then hands the fully-configured
 * `io` to this module exactly once.
 *
 * Responsibilities (AAP §0.4.5 Real-Time Event Contract, Rule 2):
 *   - Apply the JWT handshake middleware (`io.use(socketAuth)`) so every
 *     connection authenticates before any connection handler fires.
 *   - On each authenticated connection: auto-join the owner's `user:<id>` room,
 *     register the channel / message / presence / reaction handler families,
 *     and install the disconnect handler.
 *   - On disconnect: clear the Redis-backed presence state ONLY when the
 *     disconnecting socket was the user's last live socket (multi-tab safety).
 *
 * Layering: this module touches neither Prisma, Redis, nor Express directly. Its
 * only service dependency is `clearPresence`, invoked from the Socket.io-only
 * disconnect lifecycle. Structured logging (AAP §0.8.2 Gate 10) flows through
 * the Pino `logger` with `component`, `event`, `socketId`, and `userId` fields.
 * Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Server, Socket } from 'socket.io';

import { logger } from '../config/logger.js';
import { socketAuth } from '../middleware/socket-auth.js';
import { clearPresence } from '../services/presence.service.js';
import { registerChannelHandlers } from './handlers/channel.handler.js';
import { registerMessageHandlers } from './handlers/message.handler.js';
import { registerPresenceHandlers } from './handlers/presence.handler.js';
import { registerReactionHandlers } from './handlers/reaction.handler.js';
import { userRoom } from './rooms.js';

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Registers the JWT handshake middleware and all per-connection event handlers
 * on a fully-constructed Socket.io server.
 *
 * Invoked exactly once by `packages/api/src/index.ts` after the server has been
 * created and the Redis adapter attached. Returns synchronously (`void`):
 * handler registration performs no asynchronous setup.
 *
 * Flow:
 *   1. `io.use(socketAuth)` — authenticate every connection at the server level
 *      before any connection handler fires; `socketAuth` populates
 *      `socket.data.userId` and `socket.data.email`.
 *   2. `io.on('connection', ...)` — for each authenticated socket: auto-join the
 *      owner's `user:<id>` room, log the connection, register the four
 *      event-family handler factories, and install the disconnect handler.
 *   3. The disconnect handler clears presence only when the user has no
 *      remaining live sockets (multi-tab safety).
 *
 * @param io - The typed Socket.io server to wire handlers onto.
 */
export function registerSocketHandlers(io: AppServer): void {
  io.use(socketAuth);

  io.on('connection', (socket: AppSocket) => {
    const connectedAt = Date.now();

    // Auto-join the owner's user room so targeted broadcasts reach every tab and
    // the disconnect handler can count the user's remaining live sockets. The
    // join is fire-and-forget: the in-memory adapter resolves synchronously and
    // the Redis adapter resolves before any disconnect for this socket.
    void socket.join(userRoom(socket.data.userId));

    logger.info(
      {
        component: 'sockets',
        event: 'connection',
        socketId: socket.id,
        userId: socket.data.userId,
      },
      'Socket connected',
    );

    // Wire the per-socket event-family listeners. Registration order is
    // irrelevant because event names do not collide across families.
    registerChannelHandlers(io, socket);
    registerMessageHandlers(io, socket);
    registerPresenceHandlers(io, socket);
    registerReactionHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      const sessionMs = Date.now() - connectedAt;
      // Capture the identity before the async work: `socket.data` may be cleared
      // once the disconnect event has fired in some Socket.io versions.
      const userId = socket.data.userId;
      const userRoomKey = userRoom(userId);

      // The disconnect event fires after the socket has left its rooms, so the
      // post-disconnect membership of the user room reflects the user's
      // remaining live sockets. Clear presence only when none remain. The chain
      // ends in `.catch(...)` so a Redis failure is logged, never thrown as an
      // unhandled rejection (we are already on the disconnect path).
      io.in(userRoomKey)
        .fetchSockets()
        .then(async (remainingSockets) => {
          if (remainingSockets.length === 0) {
            await clearPresence(userId);
            logger.info(
              {
                component: 'sockets',
                event: 'presence:cleared',
                socketId: socket.id,
                userId,
                reason,
                sessionMs,
              },
              'Cleared presence on last-socket disconnect',
            );
          } else {
            logger.debug(
              {
                component: 'sockets',
                event: 'disconnect',
                socketId: socket.id,
                userId,
                reason,
                sessionMs,
                remainingSockets: remainingSockets.length,
              },
              'Socket disconnected; user still has other sockets',
            );
          }
        })
        .catch((err: unknown) => {
          logger.error(
            {
              component: 'sockets',
              event: 'disconnect',
              socketId: socket.id,
              userId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to clear presence on disconnect',
          );
        });

      logger.info(
        {
          component: 'sockets',
          event: 'disconnect',
          socketId: socket.id,
          userId,
          reason,
          sessionMs,
        },
        'Socket disconnected',
      );
    });
  });

  logger.info(
    {
      component: 'sockets',
      event: 'handlers:registered',
    },
    'Socket.io handlers registered',
  );
}
