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
 *    value is a JSON document `{ lastSeenMs, state }` (epoch-ms of the last
 *    heartbeat plus the write-time bucket), and the key TTL is the
 *    `AWAY_THRESHOLD_MS` window, after which a missing key is interpreted as
 *    `offline` (Redis garbage-collects fully-offline users without a cron job).
 *  - `lastSeenMs` is the authoritative age signal: read-time state is always
 *    re-derived from `Date.now() - lastSeenMs` (the persisted `state` is the
 *    write-time classification, retained for the payload contract and for
 *    debugging — it is never trusted as the live bucket because it would go
 *    stale as the clock advances past the online window between reads).
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
 * Persisted Redis presence document. Stored as `JSON.stringify`-ed JSON under
 * `presence:<userId>`; `lastSeenMs` is the epoch-millisecond timestamp of the
 * last heartbeat and `state` is the bucket computed at write time (always
 * `online` immediately after a heartbeat).
 */
interface PresenceRecord {
  /** Epoch milliseconds of the last recorded heartbeat. */
  lastSeenMs: number;
  /** Presence bucket classified at write time. */
  state: PresenceState;
}

/**
 * Bucket an age (milliseconds since the last heartbeat) into a
 * {@link PresenceState}. Lower bound inclusive, upper bound exclusive, per
 * AAP §0.8.4.
 *
 * @param ageMs - milliseconds elapsed since the last heartbeat
 * @returns the bucketed presence state
 */
function bucketFromAge(ageMs: number): PresenceState {
  if (ageMs < ONLINE_THRESHOLD_MS) return 'online';
  if (ageMs < AWAY_THRESHOLD_MS) return 'away';
  return 'offline';
}

/**
 * Parse a raw Redis value into a {@link PresenceRecord}, or `null` when the key
 * is absent or the stored value is malformed.
 *
 * Defensive by design: a missing key, non-JSON text (e.g. a legacy bare ISO
 * string or a manual `redis-cli` edit), or a JSON document without a numeric
 * `lastSeenMs` all resolve to `null` (→ `offline`) rather than throwing.
 *
 * @param raw - the raw string read from Redis, or `null` when no key exists
 * @returns the parsed record, or `null` when absent/malformed
 */
function parsePresenceRecord(raw: string | null): PresenceRecord | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as { lastSeenMs?: unknown; state?: unknown };
  if (typeof candidate.lastSeenMs !== 'number' || Number.isNaN(candidate.lastSeenMs)) {
    return null;
  }
  const storedState: PresenceState =
    candidate.state === 'online' || candidate.state === 'away' || candidate.state === 'offline'
      ? candidate.state
      : 'online';
  return { lastSeenMs: candidate.lastSeenMs, state: storedState };
}

/**
 * Resolve the LIVE presence state from a parsed record (or `null` for "no
 * heartbeat"). The bucket is always re-derived from the current clock so a
 * record written 4 minutes ago correctly reads as `away`, and one written 6
 * minutes ago reads as `offline`, even though it was stored as `online`.
 *
 * This is the canonical resolution shared by {@link getPresence},
 * {@link getPresenceMap}, and {@link recordHeartbeat}.
 *
 * @param record - the parsed presence record, or `null` when the key is absent
 * @returns the bucketed presence state for "now"
 */
function resolveState(record: PresenceRecord | null): PresenceState {
  if (record === null) {
    return 'offline';
  }
  // Guard against a future timestamp (clock skew between API instances): a
  // negative age means the heartbeat is "now or later", i.e. online.
  const ageMs = Math.max(0, Date.now() - record.lastSeenMs);
  return bucketFromAge(ageMs);
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
  const previousState = resolveState(parsePresenceRecord(await redisClient.get(key)));

  // A successful write means the user is online right now, so the post-write
  // state is always 'online'; no re-read is required. The JSON document records
  // both the epoch-ms timestamp (the authoritative age signal) and the
  // write-time bucket, satisfying the `{ lastSeenMs, state }` payload contract.
  const now = Date.now();
  const currentState: PresenceState = 'online';
  const record: PresenceRecord = { lastSeenMs: now, state: currentState };
  await redisClient.setex(key, PRESENCE_TTL_SECONDS, JSON.stringify(record));

  if (previousState !== currentState) {
    logger.debug({ userId, previousState, currentState }, 'presence.transition');
  }

  return { previousState, currentState, lastSeenAt: new Date(now).toISOString() };
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
  const raw = await redisClient.get(key);
  return resolveState(parsePresenceRecord(raw));
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
    result[userId] = resolveState(parsePresenceRecord(value));
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
