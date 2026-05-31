/**
 * Client-side presence layer for the Blitzy Slack web client.
 *
 * This module owns three concerns, each exposed as a dedicated hook so that
 * consumers mount only what they need (AAP §0.1.1, §0.6.2, §0.8.4):
 *
 *   - `usePresence(userId)` — component-level selector returning the live
 *     `PresenceState` for a single user (defaults to `'offline'`). Called from
 *     every avatar/badge so a status change for one user re-renders only the
 *     components bound to THAT user (Zustand selector subscription).
 *   - `usePresenceHeartbeat()` — app-shell orchestrator that emits the
 *     parameter-less `presence:heartbeat` event every `HEARTBEAT_INTERVAL_MS`
 *     while the tab is visible, pausing on `visibilitychange → hidden` and
 *     resuming (with an immediate beat) on `→ visible`.
 *   - `usePresenceSubscription()` — single global `presence:update → store`
 *     wiring that fans server broadcasts out to every selector.
 *   - `useHydratePresence(userIds)` — one-shot initial fetch of the presence
 *     map for a set of visible users (`GET /api/presence?userIds=`), seeding the
 *     store BEFORE any live broadcast arrives so dots are correct on first paint.
 *   - `useInitPresence()` — composite that mounts the subscription and the
 *     heartbeat together; the recommended entry point for the workspace shell.
 *
 * The socket lifecycle is reached exclusively through the `useSocket` /
 * `useSocketEvent` bindings (never `getSocket()` directly), and presence is
 * computed server-side from Redis TTL — the client only emits heartbeats and
 * reads broadcast transitions. Rationale for the design choices in this file
 * is recorded in /docs/decision-log.md, not in these comments.
 */
import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { HEARTBEAT_INTERVAL_MS } from '@app/shared/constants/limits';
import type { PresenceState } from '@app/shared/types/presence';

import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { usePresenceStore, type PresenceEntry } from '@/stores/presence.store';

import { useSocket, useSocketEvent } from './useSocket';

/**
 * Object form of a single user's presence, retained as a public type for
 * consumers that prefer a named field over the bare union. `usePresence`
 * itself returns the bare {@link PresenceState} for ergonomics; a future
 * `usePresenceDetail` variant may return this shape extended with
 * `lastSeenAt`.
 */
export interface UsePresenceResult {
  /** Current presence state for the queried userId; defaults to 'offline' for unknown users. */
  state: PresenceState;
}

/**
 * Component-level selector that returns the current presence state for a user.
 *
 * The presence map is owned by `usePresenceStore`. This hook subscribes the
 * calling component to changes for the SPECIFIC userId (via Zustand's selector
 * subscription), so a component that calls `usePresence('a')` does NOT
 * re-render when user 'b' goes online. Unknown users (not yet broadcast by the
 * server) resolve to `'offline'` via the store's `getPresence` default.
 *
 * @param userId - Database id (cuid) of the user whose presence to read.
 * @returns The user's live presence state.
 */
export function usePresence(userId: string): PresenceState {
  return usePresenceStore((s) => s.getPresence(userId));
}

/**
 * Presence heartbeat emitter. Mount ONCE at the authenticated app shell level
 * (e.g. inside `Workspace.tsx`).
 *
 * Emits `presence:heartbeat` every `HEARTBEAT_INTERVAL_MS` while the tab is
 * visible; pauses the interval when the tab becomes hidden and resumes it on
 * focus, firing an immediate heartbeat so `'online'` is restored without
 * waiting a full interval. The effect is a no-op while the user is logged out
 * (`token === null`) or while the socket is disconnected (`!isConnected`).
 */
export function usePresenceHeartbeat(): void {
  const { emit, isConnected } = useSocket();
  const token = useAuthStore((s) => s.token);

  const sendHeartbeat = useCallback((): void => {
    emit('presence:heartbeat');
  }, [emit]);

  useEffect(() => {
    if (token === null || !isConnected) {
      return undefined;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (intervalId !== null) {
        return;
      }
      sendHeartbeat();
      intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const stop = (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, [token, isConnected, sendHeartbeat]);
}

/**
 * Global `presence:update` → presence store wiring. Mount ONCE at the
 * authenticated app shell level alongside {@link usePresenceHeartbeat}.
 *
 * Every `presence:update` broadcast from the server is written into the
 * presence store via `setPresence`, where it is read by every
 * {@link usePresence} selector. A single subscription fans out to N readers
 * through Zustand's selector subscriptions, avoiding one socket listener per
 * avatar.
 */
export function usePresenceSubscription(): void {
  const setPresence = usePresenceStore((s) => s.setPresence);

  useSocketEvent('presence:update', (update) => {
    setPresence(update.userId, update.state);
  });
}

/**
 * One-shot presence-map hydration for a set of users. Mount where a list of
 * users becomes visible (e.g. the sidebar member/DM lists) so their presence
 * dots are correct on first paint, closing the gap before the server's
 * transition broadcasts arrive.
 *
 * Fetches `GET /api/presence?userIds=<csv>` and seeds the store via
 * `setBulkPresence`. The query is keyed on the ORDER-INDEPENDENT set of ids, so
 * it refetches only when the membership of the set actually changes — not when
 * the caller passes a new array reference with the same contents. Disabled
 * while logged out (`token === null`) or when the set is empty. Every returned
 * id (including those with no live heartbeat → `offline`) is written, so the
 * store reflects an authoritative snapshot rather than defaulting unknowns.
 *
 * @param userIds - database ids of the users whose presence to hydrate.
 */
export function useHydratePresence(userIds: readonly string[]): void {
  const token = useAuthStore((s) => s.token);
  const setBulkPresence = usePresenceStore((s) => s.setBulkPresence);

  // Order-independent, value-stable key: re-sorting an array of the same ids
  // yields the same string, so the query does not refetch on a mere reference
  // change. Cheap for the modest id counts a sidebar renders.
  const idsKey = [...userIds].sort().join(',');

  useQuery({
    queryKey: ['presence', 'hydrate', idsKey],
    enabled: token !== null && idsKey.length > 0,
    queryFn: async (): Promise<Record<string, PresenceState>> => {
      const map = await apiClient.get<Record<string, PresenceState>>(
        `/api/presence?userIds=${encodeURIComponent(idsKey)}`,
      );
      const entries: PresenceEntry[] = Object.entries(map).map(([userId, state]) => ({
        userId,
        state,
      }));
      setBulkPresence(entries);
      return map;
    },
  });
}

/**
 * Composite hook combining {@link usePresenceSubscription} and
 * {@link usePresenceHeartbeat}. Mount ONCE at the authenticated app shell
 * (e.g. inside `Workspace.tsx`) to bootstrap presence.
 *
 * After this hook is mounted, every component can read user presence via
 * {@link usePresence}.
 */
export function useInitPresence(): void {
  usePresenceSubscription();
  usePresenceHeartbeat();
}
