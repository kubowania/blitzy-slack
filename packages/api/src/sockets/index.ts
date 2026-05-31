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
 *   - On each authenticated connection: auto-join the owner's `user:<id>` room
 *     and every authorized channel/DM room, register the channel / message /
 *     presence / reaction / typing handler families, and install the disconnect
 *     handler.
 *   - On disconnect: clear the Redis-backed presence state ONLY when the
 *     disconnecting socket was the user's last live socket (multi-tab safety),
 *     then fan an `offline` presence:update out to the user's peers.
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
import { listMemberChannelIds } from '../services/channels.service.js';
import { listDmIds } from '../services/dms.service.js';
import { registerChannelHandlers } from './handlers/channel.handler.js';
import { registerMessageHandlers } from './handlers/message.handler.js';
import { registerPresenceHandlers } from './handlers/presence.handler.js';
import { registerReactionHandlers } from './handlers/reaction.handler.js';
import { registerTypingHandlers } from './handlers/typing.handler.js';
import { broadcastPresenceUpdate } from './presence-broadcast.js';
import { channelRoom, dmRoom, userRoom } from './rooms.js';

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import type { PresenceUpdate } from '@app/shared/types/presence';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Subscribe a freshly-connected socket to every room it is authorized to
 * receive realtime events from: each channel the user is a MEMBER of
 * (`channel:<id>`) and each DM conversation they participate in (`dm:<id>`).
 *
 * Without these joins, room-targeted broadcasts (`message:new`, `reaction:*`,
 * `typing:*`) emitted by the REST routes and socket handlers never reach the
 * recipient sockets — the connection only ever joined its own `user:<id>` room.
 * Membership is resolved through the service layer (the same membership rule
 * `assertChannelAccess` enforces), so a socket is never subscribed to a channel
 * the user has not joined or a DM they do not participate in.
 *
 * Thread rooms (`thread:<parentId>`) are intentionally NOT auto-joined here:
 * they are scoped to an open thread panel and are joined/left on demand by the
 * channel handler's room lifecycle, not at connect time.
 *
 * The function resolves once all joins have been issued. Errors (e.g. a Redis
 * blip while resolving membership) are caught and logged rather than thrown, so
 * a transient failure degrades to "no auto-join" instead of dropping the
 * connection; the client's explicit `channel:join` events remain a fallback.
 *
 * @param socket - the authenticated socket to subscribe.
 */
async function autoJoinAuthorizedRooms(socket: AppSocket): Promise<void> {
  const userId = socket.data.userId;
  try {
    const [channelIds, dmIds] = await Promise.all([
      listMemberChannelIds(userId),
      listDmIds(userId),
    ]);

    const rooms = [
      ...channelIds.map((channelId) => channelRoom(channelId)),
      ...dmIds.map((dmId) => dmRoom(dmId)),
    ];

    if (rooms.length > 0) {
      await socket.join(rooms);
    }

    logger.debug(
      {
        component: 'sockets',
        event: 'rooms:joined',
        socketId: socket.id,
        userId,
        channelCount: channelIds.length,
        dmCount: dmIds.length,
      },
      'Socket auto-joined authorized channel/DM rooms',
    );
  } catch (err: unknown) {
    logger.error(
      {
        component: 'sockets',
        event: 'rooms:join_failed',
        socketId: socket.id,
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to auto-join authorized rooms',
    );
  }
}

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

    // Auto-join every channel the user is a member of and every DM they
    // participate in, so room-targeted broadcasts (message:new, reaction:*,
    // typing:*) reach this socket. Fire-and-forget: the membership lookup is a
    // fast indexed query and any failure is logged, never thrown.
    void autoJoinAuthorizedRooms(socket);

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
    // irrelevant because event names do not collide across families. The typing
    // handler needs only the socket (its broadcasts use `socket.to(room)`).
    registerChannelHandlers(io, socket);
    registerMessageHandlers(io, socket);
    registerPresenceHandlers(io, socket);
    registerReactionHandlers(io, socket);
    registerTypingHandlers(socket);

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

            // The user just went fully offline: fan an `offline`
            // presence:update out to every peer authorized to observe them
            // (member channels + DMs + own room) so their sidebars and DM
            // lists flip the presence dot. Without this, peers would keep
            // showing the user as online until their own page reload, because
            // the clearPresence above only removes the Redis key — it emits
            // nothing on its own.
            const offlineUpdate: PresenceUpdate = {
              userId,
              state: 'offline',
              lastSeenAt: new Date().toISOString(),
            };
            await broadcastPresenceUpdate(io, userId, offlineUpdate);

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
