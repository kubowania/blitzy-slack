/**
 * Presence DTOs shared between @app/api (server) and @app/web
 * (client).
 *
 * Per AAP §0.8.4 presence semantics:
 *   - `online`  — last heartbeat received less than 60 s ago
 *   - `away`    — last heartbeat received 60 s–5 min ago
 *   - `offline` — no heartbeat for 5 min or longer
 *
 * The client emits `presence:heartbeat` every 30 s while the tab is focused
 * (HEARTBEAT_INTERVAL_MS in `../constants/limits.ts`). The server tracks
 * last-seen timestamps in Redis with TTL and broadcasts `presence:update`
 * events when a user's bucket transitions.
 *
 * This file is part of the LEAF shared package (AAP §0.4.3) and MUST NOT
 * import from @app/db, @app/api, or @app/web.
 */

/**
 * User presence state.
 *
 * Declared as a string-literal type alias union (NOT a TypeScript `enum`)
 * to avoid runtime emit under `isolatedModules: true` per AAP Rule 3.
 */
export type PresenceState = 'online' | 'away' | 'offline';

/**
 * Broadcast payload emitted as the Socket.io `presence:update` event when
 * a user's presence bucket transitions.
 *
 * Subscribers (typically the web client's presence store) replace the
 * `userId` → `state` entry in their local presence map and re-render any
 * components bound to that user's status indicator.
 */
export interface PresenceUpdate {
  /** Database id of the user whose presence transitioned. */
  userId: string;
  /** New presence state after the transition. */
  state: PresenceState;
  /**
   * ISO 8601 timestamp of the most-recent heartbeat the server received
   * for this user. Useful for tooltip display ("Last seen 3 minutes ago").
   */
  lastSeenAt: string;
}
