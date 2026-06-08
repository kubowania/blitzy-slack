import { useCallback } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { AuthenticatedUser, UserResponse } from '@app/shared/types/user';

import { apiClient, type ApiError } from '@/lib/api-client';
import { performLogout } from '@/lib/session';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Narrow shape of a successful `POST /api/auth/login` and
 * `POST /api/auth/register` response.
 *
 * The API returns `{ token, user }`; `user` is projected to
 * {@link AuthenticatedUser} — the same identity shape the auth store holds.
 * The wider self profile (`GET /api/auth/me`) is owned by a separate
 * TanStack Query cache, not this hook.
 */
interface AuthResponse {
  /** JWT bearer token issued by the API. */
  token: string;
  /** Authenticated user identity returned alongside the token. */
  user: AuthenticatedUser;
}

/**
 * TanStack Query key for the authenticated self profile (`GET /api/auth/me`).
 * Exported so callers can invalidate it after a profile mutation.
 */
export const ME_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Fetch the authenticated self view (`GET /api/auth/me`) and project it to the
 * narrow {@link AuthenticatedUser} identity the auth store holds.
 *
 * A 401 here means the persisted token is no longer valid; the shared
 * `api-client` interceptor runs `performLogout()` on that 401, so this function
 * never has to clear state itself — it simply rejects and the cleared auth
 * state propagates to subscribers.
 */
async function fetchMe(): Promise<AuthenticatedUser> {
  const me = await apiClient.get<UserResponse>('/api/auth/me');
  return {
    id: me.id,
    email: me.email,
    displayName: me.displayName,
    avatarUrl: me.avatarUrl,
  };
}

/**
 * Return value of {@link useAuth}: the curated authentication surface a
 * component needs, decoupled from the underlying Zustand store shape.
 */
export interface UseAuthResult {
  /** Authenticated user identity (the JWT principal), or `null` when no user is signed in. */
  user: AuthenticatedUser | null;
  /** JWT bearer token, or `null` when no user is signed in. */
  token: string | null;
  /** `true` when both token and user are present in the store. */
  isAuthenticated: boolean;
  /**
   * Authenticate with email + password.
   * Calls `POST /api/auth/login`, then atomically stores the returned
   * `{ token, user }` in the auth store. Throws `ApiError` on failure;
   * the calling component should `try`/`catch` and surface a toast.
   */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Register a new user.
   * Calls `POST /api/auth/register`, then atomically stores the returned
   * `{ token, user }` in the auth store. Throws `ApiError` on failure
   * (e.g. `409 Conflict` for an existing email).
   */
  register: (email: string, password: string, displayName: string) => Promise<void>;
  /**
   * Re-verify the persisted session against `GET /api/auth/me` and refresh the
   * stored identity. Call on app mount (e.g. from the authenticated shell) so a
   * session restored from `localStorage` is validated: a still-valid token
   * refreshes `user`, while an expired/invalid token yields a 401 that the
   * shared `api-client` turns into a full `performLogout()`. Throws `ApiError`
   * on failure (callers may ignore — the logout side effect already ran).
   */
  refresh: () => Promise<void>;
  /**
   * Sign out the current user via the shared `performLogout()` orchestration:
   * clears the auth store, disconnects the Socket.io singleton, AND clears the
   * presence map. Idempotent: safe to call when no user is signed in.
   */
  logout: () => void;
}

/**
 * Read and mutate the authenticated-user state — the canonical
 * authentication surface for React components.
 *
 * Read fields (`user`, `token`, `isAuthenticated`) re-render the consuming
 * component on auth-state changes via Zustand selectors.
 *
 * Action callbacks (`login`, `register`, `refresh`, `logout`) are stable
 * references across renders (wrapped in {@link useCallback}) so they integrate
 * cleanly with `react-hook-form`'s `handleSubmit` and memoized children.
 *
 * `logout` delegates to the shared `performLogout()` orchestration so the store
 * reset, Socket.io teardown, and presence-map clear always happen together —
 * the same path the `api-client` 401 interceptor uses, keeping user-initiated
 * and session-expiry logout identical. `refresh` re-verifies a persisted
 * session against `GET /api/auth/me`.
 */
export function useAuth(): UseAuthResult {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const storeLogin = useAuthStore((s) => s.login);
  const storeSetUser = useAuthStore((s) => s.setUser);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const response = await apiClient.post<AuthResponse>('/api/auth/login', {
        email,
        password,
      });
      storeLogin(response.token, response.user);
    },
    [storeLogin],
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string): Promise<void> => {
      const response = await apiClient.post<AuthResponse>('/api/auth/register', {
        email,
        password,
        displayName,
      });
      storeLogin(response.token, response.user);
    },
    [storeLogin],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const identity = await fetchMe();
    storeSetUser(identity);
  }, [storeSetUser]);

  const logout = useCallback((): void => {
    // Full teardown (auth store + socket + presence) via the shared orchestrator.
    performLogout();
  }, []);

  return {
    user,
    token,
    isAuthenticated: user !== null && token !== null,
    login,
    register,
    refresh,
    logout,
  };
}

/**
 * Declarative companion to {@link useAuth.refresh}: a TanStack Query that
 * verifies the persisted session against `GET /api/auth/me` and syncs the
 * stored identity, fetching only when a token is present.
 *
 * Intended to be mounted once by the authenticated shell so a session restored
 * from `localStorage` is validated on load. On success the auth store's `user`
 * is refreshed; on a 401 the shared `api-client` interceptor runs
 * `performLogout()`, which clears the token and disables this query.
 *
 * @returns the TanStack Query result for the self profile.
 */
export function useMe(): UseQueryResult<AuthenticatedUser, ApiError> {
  const token = useAuthStore((s) => s.token);
  const storeSetUser = useAuthStore((s) => s.setUser);

  return useQuery<AuthenticatedUser, ApiError>({
    queryKey: ME_QUERY_KEY,
    enabled: token !== null,
    queryFn: async (): Promise<AuthenticatedUser> => {
      const identity = await fetchMe();
      storeSetUser(identity);
      return identity;
    },
  });
}
