/**
 * Typing-indicator orchestration for the Blitzy Slack web client.
 *
 * A single hook, {@link useTyping}, owns both directions of the "Alice is
 * typing…" experience for one channel OR one DM context (AAP §0.1.1, §0.4.5):
 *
 *   - Outgoing: `notifyTyping()` is called on every composer keystroke. The
 *     hook throttles the `typing:start` Socket.io emission to once per
 *     `THROTTLE_INTERVAL_MS` while the user types continuously, and schedules a
 *     `typing:stop` after `INACTIVITY_TIMEOUT_MS` of silence. `stopTyping()`
 *     forces an immediate `typing:stop` (composer blur or message submit).
 *   - Incoming: the hook subscribes to `typing:start` / `typing:stop` scoped to
 *     the active `channelId`/`dmId`, maintains the `typingUsers` render list
 *     (excluding the local user), and auto-expires each entry after
 *     `REMOTE_EXPIRY_MS` so a dropped `typing:stop` cannot leave a stale
 *     indicator.
 *
 * The socket lifecycle is reached exclusively through the `useSocket` /
 * `useSocketEvent` bindings (never `getSocket()` directly). Rationale for the
 * tuning and design choices in this file is recorded in
 * /docs/decision-log.md, not in these comments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ServerToClientEvents } from '@app/shared/types/socket-events';

import { useAuthStore } from '@/stores/auth.store';

import { useSocket, useSocketEvent } from './useSocket';

/**
 * Minimum delay between successive outgoing `typing:start` emissions while the
 * user types continuously. The first keystroke after a stop emits immediately.
 */
const THROTTLE_INTERVAL_MS = 3_000;

/**
 * Idle window after the last `notifyTyping()` call before the hook
 * auto-emits `typing:stop`.
 */
const INACTIVITY_TIMEOUT_MS = 5_000;

/**
 * Window after a received `typing:start` before a remote user is auto-removed
 * from `typingUsers` when no renewal (or `typing:stop`) arrives — the
 * missed-stop safety net.
 */
const REMOTE_EXPIRY_MS = 5_000;

/**
 * Incoming `typing:start` / `typing:stop` payload shapes, derived from the
 * canonical Server→Client event contract so the scope-matching guard is
 * statically verified against the single-source-of-truth interface. Both
 * events carry the `{ userId, channelId?, dmId? }` shape.
 */
type TypingStartPayload = Parameters<ServerToClientEvents['typing:start']>[0];
type TypingStopPayload = Parameters<ServerToClientEvents['typing:stop']>[0];

/**
 * Parameter shape for {@link useTyping}. Provide EXACTLY ONE of `channelId` or
 * `dmId`; when neither is supplied the hook is a no-op (empty `typingUsers`,
 * inert `notifyTyping`/`stopTyping`).
 */
export interface UseTypingOptions {
  /** Channel ID — provide for channel typing indicators. Mutually exclusive with `dmId`. */
  channelId?: string;
  /** Direct message ID — provide for DM typing indicators. Mutually exclusive with `channelId`. */
  dmId?: string;
}

/**
 * Return shape of {@link useTyping}.
 */
export interface UseTypingResult {
  /** User ids currently typing in this channel/DM, excluding the local user. */
  typingUsers: string[];
  /**
   * Call on EACH keystroke in the composer. Throttles the outgoing
   * `typing:start` to once per `THROTTLE_INTERVAL_MS` while the user is
   * actively typing, and schedules a `typing:stop` after
   * `INACTIVITY_TIMEOUT_MS` of no further calls.
   */
  notifyTyping: () => void;
  /**
   * Call on composer blur or after submit to immediately emit `typing:stop`
   * and reset the local throttle state.
   */
  stopTyping: () => void;
}

/**
 * Typing-indicator orchestration for a channel or DM context.
 *
 * Outgoing throttle:
 *   - The first `notifyTyping()` call emits `typing:start` immediately.
 *   - Subsequent calls within `THROTTLE_INTERVAL_MS` are suppressed.
 *   - After `INACTIVITY_TIMEOUT_MS` without further calls, `typing:stop` is
 *     auto-emitted.
 *
 * Incoming expiry:
 *   - Each received `typing:start` resets a per-user expiry timer.
 *   - After `REMOTE_EXPIRY_MS` without a renewal, the user is removed from
 *     `typingUsers` even if `typing:stop` is missed.
 *
 * Returns a no-op `notifyTyping` / `stopTyping` and an empty `typingUsers`
 * when neither `channelId` nor `dmId` is provided.
 *
 * @param options - Exactly one of `channelId` or `dmId`.
 * @returns The live `typingUsers` list and the `notifyTyping` / `stopTyping` actions.
 */
export function useTyping(options: UseTypingOptions): UseTypingResult {
  const { channelId, dmId } = options;
  const { emit } = useSocket();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const lastEmitAtRef = useRef<number>(0);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteExpiryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scope = useMemo<{ channelId?: string; dmId?: string } | null>(() => {
    if (channelId !== undefined) {
      return { channelId };
    }
    if (dmId !== undefined) {
      return { dmId };
    }
    return null;
  }, [channelId, dmId]);

  const matchesScope = useCallback(
    (payload: TypingStartPayload | TypingStopPayload): boolean => {
      if (channelId !== undefined) {
        return payload.channelId === channelId;
      }
      if (dmId !== undefined) {
        return payload.dmId === dmId;
      }
      return false;
    },
    [channelId, dmId],
  );

  const clearInactivityTimer = useCallback((): void => {
    if (inactivityTimerRef.current !== null) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);

  const stopTyping = useCallback((): void => {
    clearInactivityTimer();
    lastEmitAtRef.current = 0;
    if (scope !== null) {
      emit('typing:stop', scope);
    }
  }, [emit, scope, clearInactivityTimer]);

  const notifyTyping = useCallback((): void => {
    if (scope === null) {
      return;
    }
    const now = Date.now();
    if (now - lastEmitAtRef.current >= THROTTLE_INTERVAL_MS) {
      emit('typing:start', scope);
      lastEmitAtRef.current = now;
    }
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      lastEmitAtRef.current = 0;
      emit('typing:stop', scope);
      inactivityTimerRef.current = null;
    }, INACTIVITY_TIMEOUT_MS);
  }, [emit, scope, clearInactivityTimer]);

  useSocketEvent('typing:start', (payload) => {
    if (!matchesScope(payload)) {
      return;
    }
    if (currentUserId !== null && payload.userId === currentUserId) {
      return;
    }
    setTypingUsers((prev) => (prev.includes(payload.userId) ? prev : [...prev, payload.userId]));
    const timers = remoteExpiryTimersRef.current;
    const existing = timers.get(payload.userId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    timers.set(
      payload.userId,
      setTimeout(() => {
        setTypingUsers((prev) => prev.filter((id) => id !== payload.userId));
        timers.delete(payload.userId);
      }, REMOTE_EXPIRY_MS),
    );
  });

  useSocketEvent('typing:stop', (payload) => {
    if (!matchesScope(payload)) {
      return;
    }
    setTypingUsers((prev) => prev.filter((id) => id !== payload.userId));
    const timers = remoteExpiryTimersRef.current;
    const existing = timers.get(payload.userId);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.delete(payload.userId);
    }
  });

  useEffect(() => {
    const timers = remoteExpiryTimersRef.current;
    return () => {
      clearInactivityTimer();
      timers.forEach((timer) => {
        clearTimeout(timer);
      });
      timers.clear();
      setTypingUsers([]);
    };
  }, [channelId, dmId, clearInactivityTimer]);

  return { typingUsers, notifyTyping, stopTyping };
}
