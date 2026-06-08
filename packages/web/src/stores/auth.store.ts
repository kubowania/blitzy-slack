import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { AuthenticatedUser } from '@app/shared/types/user';

/**
 * Shape of the Zustand auth store.
 *
 * The store holds the JWT bearer `token` and the authenticated `user`
 * identity (narrow shape from `@app/shared/types/user`). Both
 * fields are `null` when no user is signed in.
 *
 * The action surface (`setToken`, `setUser`, `login`, `logout`) is the
 * complete set of mutations; consumers MUST NOT reassign state directly.
 */
export interface AuthState {
  /** JWT bearer token, or `null` when no user is signed in. */
  token: string | null;
  /** Authenticated user identity, or `null` when no user is signed in. */
  user: AuthenticatedUser | null;
  /** Replace the token only; leaves `user` untouched. */
  setToken: (token: string | null) => void;
  /** Replace the user only; leaves `token` untouched. */
  setUser: (user: AuthenticatedUser | null) => void;
  /** Atomically set both token and user (called after successful login or registration). */
  login: (token: string, user: AuthenticatedUser) => void;
  /** Clear both token and user (also removes the persisted localStorage entry). */
  logout: () => void;
}

/**
 * Zustand auth store with localStorage persistence.
 *
 * Usage (React components) — prefer selector form to avoid over-rerenders:
 *
 *     const token = useAuthStore((s) => s.token);
 *     const login = useAuthStore((s) => s.login);
 *
 * Usage (non-React contexts, e.g. API client and Socket.io setup):
 *
 *     const token = useAuthStore.getState().token;
 *     useAuthStore.getState().logout();
 *
 * Persistence: the `token` and `user` fields are stored in `localStorage`
 * under the key `blitzy-slack-auth`. Action functions are NOT persisted.
 * On `logout`, both in-memory state and the persisted entry are cleared.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      login: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: 'blitzy-slack-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ token: state.token, user: state.user }),
      version: 1,
    },
  ),
);
