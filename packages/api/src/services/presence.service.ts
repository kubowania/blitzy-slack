/**
 * Presence service — Redis TTL-backed user presence tracking.
 *
 * Public surface:
 *   recordHeartbeat(userId)   → HeartbeatResult { previousState, currentState, lastSeenAt }
 *   getPresence(userId)       → PresenceState
 *   getPresenceMap(userIds)   → Record<userId, PresenceState>
 *   clearPresence(userId)     → void
 *
 * Behavioral contract:
 *  - Presence is NEVER persisted to Postgres; it is a real-time-only signal
 *    stored exclusively in Redis. The key shape is `presence:<userId>`, the
 *    value is the ISO 8601 timestamp of the last heartbeat, and the key TTL is
 *    the `AWAY_THRESHOLD_MS` window, after which a missing key is interpreted as
 *    `offline` (Redis garbage-collects fully-offline users without a cron job).
 *  - Bucketing (per AAP §0.8.4), lower bound inclusive, upper bound exclusive:
 *      online   — last heartbeat in [0, ONLINE_THRESHOLD_MS)
 *      away     — last heartbeat in [ONLINE_THRESHOLD_MS, AWAY_THRESHOLD_MS)
 *      offline  — no heartbeat OR last heartbeat in [AWAY_THRESHOLD_MS, ∞)
 *  - `recordHeartbeat` returns the (previousState, currentState) tuple so the
 *    presence socket handler can emit `presence:update` only on a STATE
 *    TRANSITION — not on every 30-second heartbeat.
 *
 * Layering and purity:
 *  - This module is a stateless bundle of functions; the only state lives in
 *    Redis. It uses the dedicated non-adapter `redisClient` (NOT `pubClient` /
 *    `subClient`, which are reserved for `@socket.io/redis-adapter`).
 *  - It imports no HTTP/WS framework, never touches the Express response or any
 *    Socket.io surface, and never throws application errors: a missing presence
 *    key is `offline`, a valid state rather than an error. Redis connectivity
 *    errors propagate unmodified for the caller / error-handler to log.
 *
 * Decision rationale (TTL backing, single-string value, exclusive boundaries,
 * etc.) lives in /docs/decision-log.md per the Explainability rule and is
 * intentionally not duplicated here.
 */

import { redisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

import { ONLINE_THRESHOLD_MS, AWAY_THRESHOLD_MS } from '@app/shared/constants/limits';
import type { PresenceState } from '@app/shared/types/presence';

/**
 * Redis key namespace for presence entries. Format: `presence:<userId>`.
 */
const PRESENCE_KEY_PREFIX = 'presence:';

/**
 * TTL applied to each presence key, in seconds. Aligned to `AWAY_THRESHOLD_MS`
 * so a key survives exactly as long as it can still influence the computed
 * state; once it expires the user is `offline` by definition anyway.
 */
const PRESENCE_TTL_SECONDS = Math.ceil(AWAY_THRESHOLD_MS / 1000);

/**
 * Build the Redis key for a user's presence entry.
 *
 * @param userId - database id of the user
 * @returns the namespaced Redis key `presence:<userId>`
 */
function presenceKey(userId: string): string {
  return `${PRESENCE_KEY_PREFIX}${userId}`;
}

/**
 * Map an ISO 8601 last-seen timestamp (or `null` for "no heartbeat") to a
 * {@link PresenceState}. This is the canonical bucketing logic shared by
 * {@link getPresence}, {@link getPresenceMap}, and {@link recordHeartbeat}.
 *
 * Returns `offline` when the input is `null` or cannot be parsed (a malformed
 * value, e.g. from manual `redis-cli` debugging, is treated defensively as
 * offline rather than throwing).
 *
 * @param lastSeenIso - ISO 8601 timestamp string, or `null` when no key exists
 * @returns the bucketed presence state
 */
function stateFromLastSeen(lastSeenIso: string | null): PresenceState {
  if (lastSeenIso === null) {
    return 'offline';
  }
  const lastSeenMs = Date.parse(lastSeenIso);
  if (Number.isNaN(lastSeenMs)) {
    return 'offline';
  }
  const ageMs = Date.now() - lastSeenMs;
  if (ageMs < ONLINE_THRESHOLD_MS) return 'online';
  if (ageMs < AWAY_THRESHOLD_MS) return 'away';
  return 'offline';
}

/**
 * Result of {@link recordHeartbeat}: the state on either side of the write plus
 * the timestamp persisted to Redis. The presence socket handler compares
 * `previousState` with `currentState` to decide whether to broadcast.
 */
export interface HeartbeatResult {
  /** The presence state BEFORE this heartbeat was recorded. */
  previousState: PresenceState;
  /** The presence state AFTER this heartbeat was recorded (always 'online'). */
  currentState: PresenceState;
  /** ISO 8601 timestamp written to Redis as the new last-seen value. */
  lastSeenAt: string;
}

/**
 * Record a presence heartbeat for a user.
 *
 * Reads the previous last-seen value, writes `presence:<userId>` = now (ISO
 * 8601) with a `PRESENCE_TTL_SECONDS` TTL, and returns the
 * `{ previousState, currentState }` tuple so the caller can broadcast a
 * `presence:update` only on a transition.
 *
 * The read-then-write pair is intentionally non-atomic: the only contention is
 * two near-simultaneous heartbeats from the same user, which compute identical
 * states, so there is no correctness hazard. Repeated heartbeats inside
 * `ONLINE_THRESHOLD_MS` yield `previousState === currentState === 'online'`
 * (no transition). A transition is logged once at `debug` level — heartbeats
 * are high-frequency, so non-transitions are deliberately silent.
 *
 * @param userId - database id of the heart-beating user
 * @returns the previous/current state tuple and the persisted timestamp
 */
export async function recordHeartbeat(userId: string): Promise<HeartbeatResult> {
  const key = presenceKey(userId);
  const previousIso = await redisClient.get(key);
  const previousState = stateFromLastSeen(previousIso);

  const nowIso = new Date().toISOString();
  await redisClient.setex(key, PRESENCE_TTL_SECONDS, nowIso);

  // A successful write means the user is online right now, so the post-write
  // state is always 'online'; no re-read is required.
  const currentState: PresenceState = 'online';

  if (previousState !== currentState) {
    logger.debug({ userId, previousState, currentState }, 'presence.transition');
  }

  return { previousState, currentState, lastSeenAt: nowIso };
}

/**
 * Read the current presence state for a single user.
 *
 * @param userId - database id of the user to look up
 * @returns the user's presence state; `offline` when no key exists or the
 *          stored value is malformed
 */
export async function getPresence(userId: string): Promise<PresenceState> {
  const key = presenceKey(userId);
  const lastSeenIso = await redisClient.get(key);
  return stateFromLastSeen(lastSeenIso);
}

/**
 * Read presence states for many users in a single Redis round-trip.
 *
 * Uses `MGET` so a sidebar or DM list can render dozens of presence dots
 * without paying N latency hops (Gate 9). Every requested id is present in the
 * returned record; ids with no heartbeat key map to `offline`. An empty input
 * short-circuits to `{}` without touching Redis.
 *
 * @param userIds - database ids whose presence to resolve
 * @returns a record mapping each requested userId to its presence state
 */
export async function getPresenceMap(
  userIds: readonly string[],
): Promise<Record<string, PresenceState>> {
  if (userIds.length === 0) {
    return {};
  }

  const keys = userIds.map(presenceKey);
  const values = await redisClient.mget(...keys);

  const result: Record<string, PresenceState> = {};
  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    if (userId === undefined) {
      continue;
    }
    const value = values[i] ?? null;
    result[userId] = stateFromLastSeen(value);
  }
  return result;
}

/**
 * Force-remove a user's presence key, transitioning them to `offline`
 * immediately. Intended for the socket disconnect handler once a user has no
 * remaining connected sockets. Idempotent: deleting an absent key is a no-op.
 *
 * @param userId - database id of the user to mark offline
 */
export async function clearPresence(userId: string): Promise<void> {
  const key = presenceKey(userId);
  await redisClient.del(key);
  logger.debug({ userId }, 'presence.cleared');
}
