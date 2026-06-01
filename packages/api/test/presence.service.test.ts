/**
 * @file packages/api/test/presence.service.test.ts
 *
 * Jest service-level (unit) tests for the presence service:
 *   - recordHeartbeat(userId)  → { previousState, currentState, lastSeenAt }
 *   - getPresence(userId)      → PresenceState
 *   - getPresenceMap(userIds)  → Record<userId, PresenceState>
 *   - clearPresence(userId)    → void
 *
 * These tests drive the presence functions DIRECTLY (not through the
 * `GET /api/presence` HTTP route exercised by presence.test.ts). The route-level
 * suite only ever observes freshly-registered users, which always read as
 * `offline`; the read-time bucket transitions (`away`, `offline-after-expiry`),
 * the single-user `getPresence` getter, the empty-`getPresenceMap` short-circuit,
 * and the malformed-Redis-record parse fallbacks are only reachable by seeding
 * Redis to a specific `lastSeenMs` and invoking the service function directly.
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             type-only imports use `import type`; every promise is awaited).
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts. Presence
 *             keys are keyed by the registered user's real id.
 *   Gate 13 — Lifts `services/presence.service.ts` line coverage past the ≥80%
 *             per-file floor (QA Checkpoint #2 finding C2).
 *
 * AAP refs: §0.1.1 (presence online/away/offline), §0.4.5 (presence:update),
 *           §0.8.4 (presence semantics: online <60s, away <5min, offline after),
 *           §0.8.2 Gate 13.
 *
 * Behavioral contract (verified against services/presence.service.ts):
 *   - The Redis key is `presence:<userId>` and the value is a JSON document
 *     `{ lastSeenMs, state }`. Read-time state is ALWAYS re-derived from
 *     `Date.now() - lastSeenMs`, so the persisted `state` is never trusted as
 *     the live bucket.
 *   - Bucketing (lower bound inclusive, upper bound exclusive): online in
 *     [0, 60s), away in [60s, 5min), offline at [5min, ∞) or when the key is
 *     absent/malformed.
 *   - `recordHeartbeat` writes `lastSeenMs = now`, returns currentState
 *     `'online'`, and reports the pre-write state so the socket handler can
 *     broadcast only on a transition.
 *
 * Rationale for the non-trivial test decisions (driving the service directly to
 * reach the read-time buckets, seeding Redis with an aged `lastSeenMs`, the
 * surgical per-key Redis teardown) lives in /docs/decision-log.md per the
 * Explainability rule, not in these comments.
 */

import {
  getPresence,
  getPresenceMap,
  recordHeartbeat,
  clearPresence,
} from '../src/services/presence.service.js';
import { cleanDatabase, closeTestResources, registerUser, redisClient } from './setup.js';

/** Mirror of the service's private key namespace (`presence:<userId>`). */
function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

/**
 * Presence keys touched by the current test, deleted in `afterEach` so the suite
 * leaves Redis at `dbsize 0` (the service has no per-test DB hook for Redis).
 */
const touchedKeys = new Set<string>();

/** Seed a well-formed presence record with an explicit age and write-time state. */
async function seedRecord(userId: string, lastSeenMs: number, state: string): Promise<void> {
  const key = presenceKey(userId);
  touchedKeys.add(key);
  await redisClient.set(key, JSON.stringify({ lastSeenMs, state }));
}

/** Seed an arbitrary RAW (possibly malformed) Redis value for a presence key. */
async function seedRaw(userId: string, raw: string): Promise<void> {
  const key = presenceKey(userId);
  touchedKeys.add(key);
  await redisClient.set(key, raw);
}

/** Register a user (Rule 4) and remember its key for teardown. */
async function registerTrackedUser(): Promise<string> {
  const { user } = await registerUser();
  touchedKeys.add(presenceKey(user.id));
  return user.id;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  const keys = [...touchedKeys];
  touchedKeys.clear();
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
});

afterAll(async () => {
  await closeTestResources();
});

describe('presence.service — getPresence read-time buckets', () => {
  it('returns "online" immediately after a heartbeat', async () => {
    const userId = await registerTrackedUser();
    await recordHeartbeat(userId);

    await expect(getPresence(userId)).resolves.toBe('online');
  });

  it('returns "away" for a heartbeat aged into the [60s, 5min) window', async () => {
    const userId = await registerTrackedUser();
    // 2 minutes ago: past ONLINE_THRESHOLD_MS (60s), under AWAY_THRESHOLD_MS (5min).
    await seedRecord(userId, Date.now() - 120_000, 'online');

    await expect(getPresence(userId)).resolves.toBe('away');
  });

  it('returns "offline" for a heartbeat aged beyond the 5min window', async () => {
    const userId = await registerTrackedUser();
    // 6 minutes ago: past AWAY_THRESHOLD_MS (5min).
    await seedRecord(userId, Date.now() - 360_000, 'online');

    await expect(getPresence(userId)).resolves.toBe('offline');
  });

  it('returns "offline" when no presence key exists', async () => {
    const userId = await registerTrackedUser();

    await expect(getPresence(userId)).resolves.toBe('offline');
  });
});

describe('presence.service — getPresence malformed-record fallbacks', () => {
  it('returns "offline" for a non-JSON Redis value', async () => {
    const userId = await registerTrackedUser();
    await seedRaw(userId, 'not-json{{');

    await expect(getPresence(userId)).resolves.toBe('offline');
  });

  it('returns "offline" for a JSON value that is not an object', async () => {
    const userId = await registerTrackedUser();
    await seedRaw(userId, '12345');

    await expect(getPresence(userId)).resolves.toBe('offline');
  });

  it('returns "offline" for a JSON object missing a numeric lastSeenMs', async () => {
    const userId = await registerTrackedUser();
    await seedRaw(userId, JSON.stringify({ state: 'online' }));

    await expect(getPresence(userId)).resolves.toBe('offline');
  });

  it('tolerates an invalid stored "state" (re-derives the live bucket)', async () => {
    const userId = await registerTrackedUser();
    // lastSeenMs is fresh, so the live bucket is "online" regardless of the
    // unrecognized stored state, which falls back to "online" at parse time.
    await seedRecord(userId, Date.now(), 'bogus-state');

    await expect(getPresence(userId)).resolves.toBe('online');
  });
});

describe('presence.service — recordHeartbeat transitions', () => {
  it('reports an offline→online transition for a first heartbeat', async () => {
    const userId = await registerTrackedUser();

    const result = await recordHeartbeat(userId);

    expect(result.previousState).toBe('offline');
    expect(result.currentState).toBe('online');
    expect(typeof result.lastSeenAt).toBe('string');
    expect(Number.isNaN(Date.parse(result.lastSeenAt))).toBe(false);
  });

  it('reports no transition (online→online) on a second immediate heartbeat', async () => {
    const userId = await registerTrackedUser();

    await recordHeartbeat(userId);
    const second = await recordHeartbeat(userId);

    expect(second.previousState).toBe('online');
    expect(second.currentState).toBe('online');
  });
});

describe('presence.service — getPresenceMap', () => {
  it('short-circuits to an empty record for an empty id list (no Redis round-trip)', async () => {
    await expect(getPresenceMap([])).resolves.toEqual({});
  });

  it('resolves mixed buckets for several users in one call', async () => {
    const onlineId = await registerTrackedUser();
    const awayId = await registerTrackedUser();
    const offlineId = await registerTrackedUser();

    await recordHeartbeat(onlineId);
    await seedRecord(awayId, Date.now() - 120_000, 'online');
    // offlineId is left without a heartbeat key → offline.

    const map = await getPresenceMap([onlineId, awayId, offlineId]);

    expect(map[onlineId]).toBe('online');
    expect(map[awayId]).toBe('away');
    expect(map[offlineId]).toBe('offline');
    expect(Object.keys(map)).toHaveLength(3);
  });
});

describe('presence.service — clearPresence', () => {
  it('removes the key so the user reads as "offline" again', async () => {
    const userId = await registerTrackedUser();
    await recordHeartbeat(userId);
    await expect(getPresence(userId)).resolves.toBe('online');

    await clearPresence(userId);

    await expect(getPresence(userId)).resolves.toBe('offline');
  });
});
