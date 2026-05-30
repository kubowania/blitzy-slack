import { useCallback } from 'react';

import type { AuthenticatedUser } from '@app/shared/types/user';

import { apiClient } from '@/lib/api-client';
import { disconnectSocket } from '@/lib/socket';
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
   * Sign out the current user.
   * Clears the auth store state, then disconnects the Socket.io singleton.
   * Idempotent: safe to call when no user is signed in.
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
 * Action callbacks (`login`, `register`, `logout`) are stable references
 * across renders (wrapped in {@link useCallback}) so they integrate cleanly
 * with `react-hook-form`'s `handleSubmit` and memoized children.
 *
 * `logout` is the single orchestration point that pairs the store's
 * `logout()` with {@link disconnectSocket}: the store clears identity, then
 * the Socket.io singleton is torn down so a later re-authentication builds a
 * fresh connection with the new token.
 */
export function useAuth(): UseAuthResult {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const storeLogin = useAuthStore((s) => s.login);
  const storeLogout = useAuthStore((s) => s.logout);

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

  const logout = useCallback((): void => {
    storeLogout();
    disconnectSocket();
  }, [storeLogout]);

  return {
    user,
    token,
    isAuthenticated: user !== null && token !== null,
    login,
    register,
    logout,
  };
}
