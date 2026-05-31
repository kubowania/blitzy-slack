/**
 * Socket.io event handler for the presence-heartbeat family.
 *
 * Attaches a single `presence:heartbeat` listener to an authenticated socket.
 * On each heartbeat the handler refreshes the user's Redis TTL through
 * `recordHeartbeat` (the presence service) and broadcasts a `presence:update`
 * ONLY when the user's presence bucket actually transitioned
 * (online <-> away <-> offline). Per AAP §0.4.5 and §0.8.4 the broadcast is
 * transition-gated: a heartbeat that finds the user already `online` refreshes
 * the TTL silently and emits nothing.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `presence:heartbeat` (client -> server) — NO payload, NO ack
 *   - Emits:   `presence:update`    (server -> every peer authorized to observe
 *                                     the user: their member channels + DMs +
 *                                     the user's own `user:<id>` room)
 *   - Emits:   `error`              (server -> originating socket, on failure)
 *
 * Presence semantics (AAP §0.8.4): `online` < 60 s since last heartbeat,
 * `away` 60 s–5 min, `offline` >= 5 min. The client emits every
 * HEARTBEAT_INTERVAL_MS (30 s) while the tab is focused; the server records
 * each heartbeat without rate-limiting and lets the Redis TTL drive the
 * away/offline buckets.
 *
 * Transition broadcasts are fanned out by `broadcastPresenceUpdate`
 * (`../presence-broadcast.js`), which targets the user's authorized audience so
 * peers' sidebars and DM lists reconcile — not just the user's own tabs. The
 * Socket.io Redis adapter (AAP Rule 2) transparently fans every emit out to
 * recipients connected to any API instance.
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates presence tracking to `recordHeartbeat` and relies on the
 * server-level socket-auth middleware to populate `socket.data.userId`. The
 * disconnect-time `clearPresence` is the responsibility of `sockets/index.ts`,
 * NOT this handler.
 *
 * Structured logging (AAP §0.8.2 Gate 10) is emitted through the Pino `logger`
 * singleton with `component`, `event`, `socketId`, `userId`, and `latency`
 * fields. Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Server, Socket } from 'socket.io';

import { recordHeartbeat } from '../../services/presence.service.js';
import { ServiceError } from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { broadcastPresenceUpdate } from '../presence-broadcast.js';
import { ERROR, PRESENCE_HEARTBEAT, PRESENCE_UPDATE } from '@app/shared/constants/events';
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
 * Registers the presence-heartbeat listener on a connected, authenticated
 * socket.
 *
 * The listener is synchronous and delegates to its async handler with a `void`
 * prefix so the returned promise is intentionally not awaited: the
 * `presence:heartbeat` event is fire-and-forget (no ack), so the handler's
 * completion is never surfaced to the client (the `no-floating-promises` rule
 * is satisfied by the explicit `void`).
 *
 * @param io - The typed Socket.io server, used to fan `presence:update` out to
 *   the heart-beating user's authorized audience on a transition.
 * @param socket - The connecting socket whose heartbeat events are handled;
 *   provides `socket.data.userId` and `socket.id`.
 */
export function registerPresenceHandlers(io: AppServer, socket: AppSocket): void {
  socket.on(PRESENCE_HEARTBEAT, () => {
    void handleHeartbeat(io, socket);
  });
}

/**
 * Records one presence heartbeat and broadcasts a `presence:update` only on a
 * state transition.
 *
 * Flow:
 *   1. Record the heartbeat via `recordHeartbeat`, which refreshes the Redis
 *      TTL and returns the `{ previousState, currentState, lastSeenAt }` tuple
 *      (`currentState` is always `online` immediately after a heartbeat).
 *   2. When `previousState !== currentState` the user just transitioned (e.g.,
 *      `offline -> online` after a reconnect): fan `presence:update` out to the
 *      user's authorized audience (member channels + DMs + own room) via
 *      `broadcastPresenceUpdate`, and log the transition at `info`.
 *   3. Otherwise the user was already `online` and only the TTL was refreshed:
 *      log at `debug` (suppressed in production where the level is `info`) so
 *      heartbeat arrival stays observable in development without flooding prod.
 *
 * A thrown error indicates a Redis-connectivity failure — the presence service
 * treats a missing key as `offline` rather than throwing, so business logic
 * never raises here. The failure is logged and surfaced to the originating
 * socket via the reserved `error` event; the client recovers on its next
 * heartbeat, so no retry is attempted.
 *
 * @param io - The typed Socket.io server used for the transition broadcast.
 * @param socket - The originating socket (provides `socket.data.userId`).
 */
async function handleHeartbeat(io: AppServer, socket: AppSocket): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;

  try {
    const result = await recordHeartbeat(userId);

    if (result.previousState !== result.currentState) {
      const update: PresenceUpdate = {
        userId,
        state: result.currentState,
        lastSeenAt: result.lastSeenAt,
      };

      // Fan the transition out to every peer authorized to observe this user
      // (their member channels + DMs) AND the user's own tabs, so sidebars and
      // DM lists everywhere reconcile — not just the user's own room.
      await broadcastPresenceUpdate(io, userId, update);

      logger.info(
        {
          component: 'presence.handler',
          event: PRESENCE_UPDATE,
          socketId: socket.id,
          userId,
          previousState: result.previousState,
          currentState: result.currentState,
          lastSeenAt: result.lastSeenAt,
          latency: Date.now() - start,
        },
        'presence transition broadcast',
      );
    } else {
      logger.debug(
        {
          component: 'presence.handler',
          event: PRESENCE_HEARTBEAT,
          socketId: socket.id,
          userId,
          state: result.currentState,
          latency: Date.now() - start,
        },
        'presence heartbeat (no transition)',
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    const code =
      err instanceof ServiceError
        ? err.name.replace(/Error$/, '').toUpperCase() || 'SERVICE_ERROR'
        : 'INTERNAL_ERROR';

    logger.error(
      {
        component: 'presence.handler',
        event: PRESENCE_HEARTBEAT,
        socketId: socket.id,
        userId,
        code,
        err: message,
        latency: Date.now() - start,
      },
      'presence heartbeat failed',
    );

    socket.emit(ERROR, { code, message });
  }
}
