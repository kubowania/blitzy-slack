/**
 * Presence service — Redis TTL-backed user presence tracking.
 *
 * Public surface:
 *   recordHeartbeat(userId)        → HeartbeatResult { previousState, currentState, lastSeenAt }
 *   getPresence(userId)            → PresenceState
 *   getPresenceMap(userIds)        → Record<userId, PresenceState>
 *   clearPresence(userId)          → void
 *   collectPresenceTransitions()   → PresenceTransition[]  (passive away/offline drift)
 *
 * Behavioral contract:
 *  - Presence is NEVER persisted to Postgres; it is a real-time-only signal
 *    stored exclusively in Redis. The key shape is `presence:<userId>`, the
 *    value is a JSON document `{ lastSeenMs, state }` (epoch-ms of the last
 *    heartbeat plus the write-time bucket), and the key TTL is the
 *    `AWAY_THRESHOLD_MS` window, after which a missing key is interpreted as
 *    `offline` (Redis garbage-collects fully-offline users without a cron job).
 *  - `lastSeenMs` is the authoritative age signal: read-time state is always
 *    re-derived from `Date.now() - lastSeenMs`. The persisted `state` is the
 *    LAST-BROADCAST bucket (written `online` by a heartbeat, advanced to `away`
 *    by the sweep); it is compared against the freshly-derived live bucket to
 *    detect a passive transition, and is never trusted as the live bucket
 *    itself because it would go stale as the clock advances between reads.
 *  - A passive transition (a user who stops heart-beating drifts
 *    `online → away → offline` with no further client traffic) is surfaced by
 *    `collectPresenceTransitions`, invoked on an interval by the socket-layer
 *    presence sweep so peers' sidebars reconcile without any client poll.
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
 * Extra time, in milliseconds, a presence key is retained PAST
 * `AWAY_THRESHOLD_MS` so the presence sweep can observe the `away → offline`
 * boundary crossing and broadcast it before the key vanishes. Without this
 * grace the key would expire at exactly the away→offline boundary and the
 * transition could never be observed (the PRES-001 root cause).
 */
const PRESENCE_OFFLINE_GRACE_MS = 30_000;

/**
 * TTL applied to each presence key, in seconds. Spans the full `away` window
 * plus `PRESENCE_OFFLINE_GRACE_MS` so a key lingers briefly into the `offline`
 * window — long enough for the sweep to emit the `away → offline` transition —
 * before Redis garbage-collects it.
 */
const PRESENCE_TTL_SECONDS = Math.ceil((AWAY_THRESHOLD_MS + PRESENCE_OFFLINE_GRACE_MS) / 1000);

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
  /**
   * The last presence bucket BROADCAST for this user. Written `online` by a
   * heartbeat and advanced to `away` by the presence sweep on a passive
   * transition. The sweep compares this against the LIVE bucket (always
   * re-derived from `lastSeenMs`) to detect an unbroadcast transition; this
   * field is never trusted as the live bucket itself.
   */
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

/**
 * A passive presence transition detected by {@link collectPresenceTransitions}:
 * a user whose LIVE bucket has drifted past the bucket last broadcast for them,
 * with no client traffic to announce it. Mirrors the `presence:update` payload
 * so the socket-layer sweep can fan it out verbatim.
 */
export interface PresenceTransition {
  /** Database id of the user whose presence drifted. */
  userId: string;
  /** The new LIVE bucket (`away` on the online→away drift, `offline` thereafter). */
  state: PresenceState;
  /** ISO 8601 timestamp of the user's last heartbeat. */
  lastSeenAt: string;
}

/**
 * Detect every user whose LIVE presence bucket has passively drifted past the
 * bucket last broadcast for them, persist the drift, and return the transitions
 * for the caller to broadcast.
 *
 * A heartbeat only broadcasts `offline/away → online`; the reverse drift
 * (`online → away → offline`) happens with NO client traffic, so without an
 * active observer it would never reach peers (the PRES-001 defect). This
 * function is that observer:
 *
 *   1. `SCAN` the `presence:*` keyspace (cursor-based, non-blocking — never
 *      `KEYS`, which would stall the Redis event loop at scale).
 *   2. For each key, re-derive the live bucket via {@link resolveState} and
 *      compare it to the persisted last-broadcast `state`.
 *   3. On a drift, either:
 *        - `online → away`: rewrite the record with `state: 'away'` (preserving
 *          `lastSeenMs` and refreshing the extended TTL) so the next sweep
 *          treats the away bucket as already broadcast, OR
 *        - `away → offline`: `DEL` the key (an offline user holds no live
 *          presence; the extended TTL guarantees the key is still present to be
 *          observed here before Redis would GC it).
 *   4. Collect the `{ userId, state, lastSeenAt }` transition for the caller.
 *
 * Purity: this function performs Redis reads/writes ONLY. It never touches
 * Socket.io — the io fan-out is owned by the socket-layer sweep that calls it,
 * preserving the service-below-sockets dependency direction. A non-conforming
 * or expired key is skipped, never thrown on.
 *
 * @returns the list of passive transitions to broadcast (empty when no user
 *   drifted since the last sweep)
 */
export async function collectPresenceTransitions(): Promise<PresenceTransition[]> {
  // Enumerate presence keys with a cursor-based SCAN so a large keyspace never
  // blocks Redis. COUNT is a hint, not a hard page size, so the loop continues
  // until the cursor returns to '0'.
  const userIds: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redisClient.scan(
      cursor,
      'MATCH',
      `${PRESENCE_KEY_PREFIX}*`,
      'COUNT',
      200,
    );
    cursor = next;
    for (const key of keys) {
      userIds.push(key.slice(PRESENCE_KEY_PREFIX.length));
    }
  } while (cursor !== '0');

  if (userIds.length === 0) {
    return [];
  }

  const transitions: PresenceTransition[] = [];

  for (const userId of userIds) {
    const key = presenceKey(userId);
    const record = parsePresenceRecord(await redisClient.get(key));
    if (record === null) {
      // The key expired between SCAN and GET — Redis already GC'd the user to
      // offline, so there is nothing left to transition.
      continue;
    }

    const liveState = resolveState(record);
    if (liveState === record.state) {
      // The last-broadcast bucket still matches the live bucket: a recent
      // heartbeat keeps the user online, or a prior sweep already broadcast and
      // persisted the away bucket. Nothing to emit.
      continue;
    }

    const lastSeenAt = new Date(record.lastSeenMs).toISOString();

    if (liveState === 'offline') {
      await redisClient.del(key);
    } else {
      const advanced: PresenceRecord = { lastSeenMs: record.lastSeenMs, state: liveState };
      await redisClient.setex(key, PRESENCE_TTL_SECONDS, JSON.stringify(advanced));
    }

    transitions.push({ userId, state: liveState, lastSeenAt });
    logger.debug({ userId, previousState: record.state, currentState: liveState }, 'presence.sweep.transition');
  }

  return transitions;
}
