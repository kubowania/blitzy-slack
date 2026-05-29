import { create } from 'zustand';

import type { PresenceState, PresenceUpdate } from '@app/shared/types/presence';

/**
 * Shape of the Zustand presence store.
 *
 * `presenceMap` keys are user database ids (cuid); values are the user's
 * current presence state as broadcast by the API via the Socket.io
 * `presence:update` event. Unknown users (not yet observed) are treated
 * as `'offline'` by `getPresence`.
 */
export interface PresenceStoreState {
  /** userId -> current presence state. Replaced (new reference) on every mutation. */
  presenceMap: Map<string, PresenceState>;
  /** Set the presence state for a single user. */
  setPresence: (userId: string, state: PresenceState) => void;
  /** Apply a batch of presence updates in a single state transition. */
  setBulkPresence: (entries: PresenceUpdate[]) => void;
  /** Read the presence state for a user; returns `'offline'` for unknown users. */
  getPresence: (userId: string) => PresenceState;
  /** Reset the presence map to empty (used on logout and on socket reconnect). */
  clear: () => void;
}

/**
 * Zustand store holding the live presence map.
 *
 * Usage (React components) — prefer selector form to avoid over-rerenders:
 *
 *     const status = usePresenceStore((s) => s.getPresence(userId));
 *     const setPresence = usePresenceStore((s) => s.setPresence);
 *
 * Usage (non-React contexts, e.g. socket event handlers):
 *
 *     usePresenceStore.getState().setPresence(userId, 'online');
 *     usePresenceStore.getState().setBulkPresence(updates);
 *
 * The store is intentionally NOT persisted — presence is ephemeral and
 * reconstructed when the Socket.io connection is re-established.
 */
export const usePresenceStore = create<PresenceStoreState>()((set, get) => ({
  presenceMap: new Map<string, PresenceState>(),

  setPresence: (userId, state) =>
    set((current) => {
      const next = new Map(current.presenceMap);
      next.set(userId, state);
      return { presenceMap: next };
    }),

  setBulkPresence: (entries) =>
    set((current) => {
      const next = new Map(current.presenceMap);
      for (const entry of entries) {
        next.set(entry.userId, entry.state);
      }
      return { presenceMap: next };
    }),

  getPresence: (userId) => get().presenceMap.get(userId) ?? 'offline',

  clear: () => set({ presenceMap: new Map<string, PresenceState>() }),
}));
