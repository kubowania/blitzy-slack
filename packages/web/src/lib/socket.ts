import { io, type Socket } from 'socket.io-client';

import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared/types/socket-events';

import { useAuthStore } from '@/stores/auth.store';

/**
 * Typed Socket.io client interface.
 *
 * NOTE the inverted generic order vs. the server:
 *   - Server: Socket<ClientToServerEvents, ServerToClientEvents, ...>
 *   - Client: Socket<ServerToClientEvents, ClientToServerEvents>
 *
 * The first generic on the CLIENT describes what the client RECEIVES
 * (i.e., events the server emits), and the second describes what the
 * client EMITS. See packages/shared/src/types/socket-events.ts for the
 * canonical interface declarations and rationale.
 */
type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Module-level singleton holding the active Socket.io client, or `null`
 * when no connection has been established (initial state) or after
 * `disconnectSocket()` has been called (post-logout).
 */
let socket: AppSocket | null = null;

/**
 * Lazy accessor for the Socket.io client.
 *
 * On first invocation (when the singleton is `null`):
 *   1. Reads the JWT from the Zustand auth store via the non-React
 *      `useAuthStore.getState()` accessor.
 *   2. Throws if no token is present (caller MUST guarantee the user is
 *      authenticated before requesting the socket).
 *   3. Constructs a typed `Socket` against `VITE_WS_URL` with the JWT
 *      passed in `handshake.auth.token`. The server-side handshake
 *      middleware (`packages/api/src/middleware/socket-auth.ts`) reads
 *      this token and populates `socket.data.userId` / `socket.data.email`.
 *   4. Configures Socket.io's built-in reconnection so transient network
 *      blips are recovered automatically.
 *
 * On subsequent invocations, returns the cached singleton without
 * reconstructing — preserving event subscribers and room memberships.
 */
export function getSocket(): AppSocket {
  if (socket !== null) {
    return socket;
  }

  const token = useAuthStore.getState().token;
  if (token === null) {
    throw new Error(
      'getSocket() called without an authenticated session. ' +
        'Ensure useAuthStore.getState().token is set before connecting.',
    );
  }

  const url = import.meta.env.VITE_WS_URL;

  socket = io(url, {
    auth: { token },
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling'],
  });

  return socket;
}

/**
 * Disconnects the Socket.io singleton and clears the module-level
 * reference. Called by the auth store's `logout()` action so a
 * subsequent `getSocket()` call (after re-authentication) constructs a
 * brand-new connection with the fresh JWT.
 *
 * Safe to call multiple times or when no socket is connected.
 */
export function disconnectSocket(): void {
  if (socket === null) {
    return;
  }
  socket.disconnect();
  socket.removeAllListeners();
  socket = null;
}
