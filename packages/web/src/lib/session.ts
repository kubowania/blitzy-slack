import { disconnectSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';
import { usePresenceStore } from '@/stores/presence.store';

/**
 * Single orchestration point for tearing down a session — used by BOTH the
 * explicit user-initiated logout (`useAuth.logout`) and the implicit
 * session-expiry path (`api-client` on a 401).
 *
 * Without this helper the two paths diverged: the API client's 401 branch
 * cleared only the auth store, leaving the authenticated WebSocket connected
 * and the presence map populated, so a re-login reused a stale socket and
 * showed stale presence dots. Centralizing the teardown guarantees every exit
 * from an authenticated session performs the SAME three steps in the SAME
 * order.
 *
 * Module placement avoids a circular import: this module imports the socket
 * singleton and the two stores; `api-client` and `useAuth` import THIS module.
 * None of `socket` / `auth.store` / `presence.store` import back into here.
 *
 * Steps:
 *   1. Clear the auth store (token + user) — also removes the persisted
 *      `localStorage` entry, so a page reload stays logged out.
 *   2. Disconnect and dispose the Socket.io singleton, so a later
 *      re-authentication builds a brand-new connection with the fresh JWT
 *      (a stale socket would keep emitting on the old identity).
 *   3. Clear the ephemeral presence map, so a re-login does not briefly render
 *      stale presence dots from the previous session.
 *
 * Idempotent: safe to call when already logged out (each step is a no-op).
 */
export function performLogout(): void {
  useAuthStore.getState().logout();
  disconnectSocket();
  usePresenceStore.getState().clear();
}
