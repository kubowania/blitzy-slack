/**
 * Typed, React-safe bindings for the singleton Socket.io client.
 *
 * Three hooks share one concern — access to the singleton connection from
 * `@/lib/socket`:
 *
 *   - `useConnectSocket()` — mount ONCE at the authenticated app shell; drives
 *     the auth-gated connect/disconnect lifecycle and surfaces connection
 *     transitions as Sonner toasts.
 *   - `useSocket()` — component-level access to the live socket, connection
 *     state, the most recent connection error, and a typed `emit` helper.
 *   - `useSocketEvent(event, handler)` — component-scoped subscription to a
 *     server-emitted event using a stable listener with a fresh handler closure.
 *
 * Every `emit`/`on` is typed through the shared `ClientToServerEvents` /
 * `ServerToClientEvents` contracts (AAP §0.8.4). This is the only hooks module
 * that calls `getSocket()` directly; all other hooks consume the exports here.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared/types/socket-events';

import { getSocket, type AppSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Stable Sonner toast ids, one per socket lifecycle transition. Passing a fixed
 * `id` updates a toast in place instead of stacking a new one on every event.
 */
const SOCKET_TOAST_IDS = {
  disconnected: 'socket-disconnected',
  reconnecting: 'socket-reconnecting',
  reconnected: 'socket-reconnected',
  connectError: 'socket-connect-error',
} as const;

/**
 * Public result shape returned by {@link useSocket}.
 */
export interface UseSocketResult {
  /** The singleton socket instance, or `null` when unauthenticated. */
  socket: AppSocket | null;
  /** Live connection state. */
  isConnected: boolean;
  /** Most recent connection error message, or `null`. */
  connectionError: string | null;
  /**
   * Typed emit helper. The payload tuple is resolved from
   * `ClientToServerEvents[E]`. No-ops while the user is logged out (no socket);
   * Socket.io v4 buffers emits across transient disconnects.
   */
  emit: <E extends keyof ClientToServerEvents>(
    event: E,
    ...args: Parameters<ClientToServerEvents[E]>
  ) => void;
}

/**
 * Connection state shared by every {@link useSocket} caller. The singleton
 * socket has one global connection status, exposed below as a module-level
 * pub/sub that backs a `useSyncExternalStore` subscription.
 */
interface ConnectionState {
  isConnected: boolean;
  error: string | null;
}

let connectionState: ConnectionState = { isConnected: false, error: null };
const connectionListeners = new Set<() => void>();

/** Replace the connection snapshot and notify every subscriber. */
function setConnectionState(next: ConnectionState): void {
  connectionState = next;
  for (const listener of connectionListeners) {
    listener();
  }
}

/** Register a `useSyncExternalStore` subscriber; returns its unsubscribe fn. */
function subscribeConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

/** Current connection snapshot; reference is stable between transitions. */
function getConnectionSnapshot(): ConnectionState {
  return connectionState;
}

/** Guards against stacking duplicate lifecycle listeners on the singleton. */
let lifecycleAttached = false;

/**
 * Attach connect/disconnect/connect_error listeners to the singleton socket
 * once, mapping each transition to the shared connection state and a
 * deduplicated Sonner toast.
 */
function attachLifecycleListeners(socket: AppSocket): void {
  if (lifecycleAttached) {
    return;
  }
  lifecycleAttached = true;

  socket.on('connect', () => {
    setConnectionState({ isConnected: true, error: null });
    toast.dismiss(SOCKET_TOAST_IDS.disconnected);
    toast.dismiss(SOCKET_TOAST_IDS.connectError);
  });

  socket.on('disconnect', (reason) => {
    setConnectionState({ isConnected: false, error: null });
    if (reason !== 'io client disconnect') {
      toast.error('Connection lost. Attempting to reconnect…', {
        id: SOCKET_TOAST_IDS.disconnected,
        duration: Infinity,
      });
    }
  });

  socket.on('connect_error', (err) => {
    setConnectionState({ isConnected: false, error: err.message });
    toast.error(`Connection error: ${err.message}`, {
      id: SOCKET_TOAST_IDS.connectError,
    });
  });
}

/** Detach the lifecycle listeners attached by {@link attachLifecycleListeners}. */
function detachLifecycleListeners(socket: AppSocket): void {
  if (!lifecycleAttached) {
    return;
  }
  lifecycleAttached = false;
  socket.off('connect');
  socket.off('disconnect');
  socket.off('connect_error');
}

/**
 * Mount ONCE at the authenticated app shell (e.g. the workspace shell).
 * Connects the singleton when a token is present and detaches the lifecycle
 * listeners when the token clears or the shell unmounts. Idempotent — repeated
 * mounts are no-ops. Does not disconnect on cleanup; the orchestrated logout
 * disconnect lives in the auth-store logout flow.
 */
export function useConnectSocket(): void {
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (token === null) {
      setConnectionState({ isConnected: false, error: null });
      return undefined;
    }
    const socket = getSocket();
    attachLifecycleListeners(socket);
    if (!socket.connected) {
      socket.connect();
    } else {
      setConnectionState({ isConnected: true, error: null });
    }
    return () => {
      detachLifecycleListeners(socket);
    };
  }, [token]);
}

/**
 * Component-level access to the singleton socket. Returns the live socket (or
 * `null` when unauthenticated), the current connection state, the most recent
 * connection error, and a typed {@link UseSocketResult.emit} helper. Use
 * {@link useSocketEvent} for typed event subscriptions.
 */
export function useSocket(): UseSocketResult {
  const token = useAuthStore((s) => s.token);
  const { isConnected, error } = useSyncExternalStore(
    subscribeConnection,
    getConnectionSnapshot,
    getConnectionSnapshot,
  );

  const socket = token !== null ? getSocket() : null;

  const emit = useCallback(
    <E extends keyof ClientToServerEvents>(
      event: E,
      ...args: Parameters<ClientToServerEvents[E]>
    ): void => {
      if (socket === null) {
        return;
      }
      (socket.emit as (e: E, ...a: Parameters<ClientToServerEvents[E]>) => void)(event, ...args);
    },
    [socket],
  );

  return { socket, isConnected, connectionError: error, emit };
}

/**
 * Component-scoped subscription to a server-emitted event. The handler is
 * captured via a ref, so the listener registers ONCE per (component, event)
 * pair while always invoking the latest handler closure. Cleanup runs on
 * unmount, on `event` change, or when authentication clears.
 */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
): void {
  const token = useAuthStore((s) => s.token);
  const handlerRef = useRef<ServerToClientEvents[E]>(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (token === null) {
      return undefined;
    }
    const socket = getSocket();
    const stableListener = ((...args: Parameters<ServerToClientEvents[E]>): void => {
      const fn = handlerRef.current as (...a: Parameters<ServerToClientEvents[E]>) => void;
      fn(...args);
    }) as ServerToClientEvents[E];
    (socket.on as (ev: E, listener: ServerToClientEvents[E]) => void)(event, stableListener);
    return () => {
      (socket.off as (ev: E, listener: ServerToClientEvents[E]) => void)(event, stableListener);
    };
  }, [event, token]);
}
