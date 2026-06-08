/**
 * Passive-presence sweep for the `@app/api` package.
 *
 * A `presence:heartbeat` only ever drives a user FORWARD to `online`; the
 * reverse drift — a user who closes their laptop and stops heart-beating,
 * sliding `online → away → offline` — produces NO client traffic, so without a
 * server-side observer those transitions never reach peers (the PRES-001
 * defect: a sidebar dot stays green forever).
 *
 * This module is that observer. {@link startPresenceSweep} installs a single
 * interval timer per process; each tick calls
 * {@link collectPresenceTransitions} (the pure Redis side of the presence
 * service) to detect and persist any passive drift, then fans each transition
 * out through {@link broadcastPresenceUpdate} — the identical audience-resolution
 * path the heartbeat handler uses, so peers' sidebars and DM lists reconcile.
 *
 * Layering: the Redis scan/read/write lives in the presence SERVICE; this
 * socket-layer module owns only the timer and the Socket.io fan-out, keeping
 * the service-below-sockets dependency direction intact. The Socket.io Redis
 * adapter (AAP Rule 2) fans every emit out to peers connected to any API
 * instance, and — because {@link collectPresenceTransitions} both DELETES the
 * offline key and advances the away marker atomically per user — running the
 * sweep on multiple instances is safe (a transition is observed and cleared
 * once; a redundant `presence:update` for the same terminal state is harmless).
 *
 * Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Server } from 'socket.io';

import { collectPresenceTransitions } from '../services/presence.service.js';
import { logger } from '../config/logger.js';
import { broadcastPresenceUpdate } from './presence-broadcast.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Interval between presence sweeps, in milliseconds. Comfortably shorter than
 * the presence service's `PRESENCE_OFFLINE_GRACE_MS` retention window so a key
 * is observed at least once while it lingers in the `offline` window, and short
 * enough that a passive `online → away` drift propagates well within the 5 s
 * presence budget (AAP Gate 9).
 */
const PRESENCE_SWEEP_INTERVAL_MS = 15_000;

/**
 * The single per-process sweep timer, or `null` when the sweep is not running.
 * Module-scoped so {@link startPresenceSweep} is idempotent and
 * {@link stopPresenceSweep} can tear the timer down for a graceful shutdown or
 * test cleanup.
 */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single presence sweep: collect every passive transition from the
 * service and broadcast each one to its authorized audience.
 *
 * Broadcasts are awaited sequentially; the transition set per tick is bounded
 * by the number of users who drifted in one interval, so sequential fan-out is
 * cheap and avoids a burst of concurrent Redis audience lookups.
 *
 * @param io - The typed Socket.io server used for the `presence:update` fan-out.
 */
export async function sweepPresenceTransitions(io: AppServer): Promise<void> {
  const transitions = await collectPresenceTransitions();

  for (const transition of transitions) {
    await broadcastPresenceUpdate(io, transition.userId, {
      userId: transition.userId,
      state: transition.state,
      lastSeenAt: transition.lastSeenAt,
    });

    logger.info(
      {
        component: 'presence.sweep',
        userId: transition.userId,
        currentState: transition.state,
        lastSeenAt: transition.lastSeenAt,
      },
      'presence passive transition broadcast',
    );
  }
}

/**
 * Start the per-process presence sweep loop. Idempotent: a second call while a
 * sweep is already running is a no-op, so wiring it from the once-per-server
 * `registerSocketHandlers` is safe even if that function were ever invoked
 * twice.
 *
 * The timer is `unref`-ed so it never by itself keeps the Node process alive —
 * process lifetime is owned by the HTTP/Socket.io server, and tests that import
 * the sockets layer are not held open by a dangling interval. A rejected sweep
 * (e.g. a transient Redis error) is logged and swallowed so one failed tick
 * never tears the loop down; the next tick retries.
 *
 * @param io - The typed Socket.io server passed through to each sweep tick.
 */
export function startPresenceSweep(io: AppServer): void {
  if (sweepTimer !== null) {
    return;
  }

  sweepTimer = setInterval(() => {
    void sweepPresenceTransitions(io).catch((err: unknown) => {
      logger.error(
        {
          component: 'presence.sweep',
          err: err instanceof Error ? err.message : String(err),
        },
        'presence sweep tick failed',
      );
    });
  }, PRESENCE_SWEEP_INTERVAL_MS);

  sweepTimer.unref();

  logger.info(
    {
      component: 'presence.sweep',
      intervalMs: PRESENCE_SWEEP_INTERVAL_MS,
    },
    'presence sweep started',
  );
}

/**
 * Stop the presence sweep loop if it is running. Idempotent. Intended for
 * graceful shutdown and for test teardown so an `unref`-ed interval does not
 * outlive the suite that started it.
 */
export function stopPresenceSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
