import { useQuery } from '@tanstack/react-query';

import type { DMWithParticipants } from '@app/shared/types/dm';

import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

/**
 * TanStack Query cache key for the authenticated user's direct-message list.
 *
 * Exported so socket event handlers (e.g. the `message:new` listener in
 * {@link DmList}) and any future DM mutation hooks invalidate the exact same
 * key (`['dms']`) that {@link useDms} reads from, instead of duplicating the
 * literal. This mirrors the `CHANNELS_QUERY_KEY` pattern in `useChannels.ts`.
 */
export const DMS_QUERY_KEY = ['dms'] as const;

/**
 * Normalized result shape returned by {@link useDms}.
 *
 * This is the React-friendly projection of TanStack Query's `UseQueryResult`:
 * consumers read these five fields directly and never touch the underlying
 * `data`/`isPending`/`isError` boilerplate. The shape intentionally matches
 * `UseChannelsResult` so the two sidebar sections share one mental model.
 */
export interface UseDmsResult {
  /**
   * Direct-message conversations the authenticated user participates in. Each
   * entry is the {@link DMWithParticipants} DTO returned by `GET /api/dms`
   * (the DM plus its two participants). Empty array while loading or on error.
   */
  dms: DMWithParticipants[];
  /** `true` while the initial fetch is in flight with no cached data yet; `false` on subsequent refetches. */
  isLoading: boolean;
  /** `true` while ANY fetch is in flight (initial OR refetch); drives a refresh spinner. */
  isFetching: boolean;
  /** The fetch error, or `null` on success or while loading. */
  error: Error | null;
  /** Imperative refetch reduced to a `Promise<void>`; callers read fresh data from the next render. */
  refetch: () => Promise<void>;
}

/**
 * TanStack Query wrapper that fetches the authenticated user's direct-message
 * list from `GET /api/dms` and exposes it as the normalized {@link UseDmsResult}
 * shape.
 *
 * Behavior:
 * - Auth-gated: the query is `enabled` only when the auth store holds a
 *   non-null `token`. Logged-out callers receive an empty `dms` array and
 *   `isLoading: false` without firing a network request.
 * - Cache key: {@link DMS_QUERY_KEY} (`['dms']`). The `message:new` socket
 *   handler in {@link DmList} refreshes this list by invalidating the same key
 *   — but ONLY for messages that belong to a DM (`dmId !== null`), so channel
 *   and thread traffic no longer trigger needless DM refetches. This hook is
 *   the read side and performs no invalidation itself.
 * - `staleTime` of 30s matches the previous inline query so a freshly fetched
 *   list is not immediately considered stale by an unrelated invalidation.
 * - Response type is `DMWithParticipants[]`, matching the backend contract for
 *   `GET /api/dms` (see `packages/api/src/routes/dms.ts`). The bearer token is
 *   attached automatically by `apiClient`, so the `queryFn` only needs the path.
 */
export function useDms(): UseDmsResult {
  const token = useAuthStore((state) => state.token);

  const query = useQuery<DMWithParticipants[], Error>({
    queryKey: DMS_QUERY_KEY,
    queryFn: () => apiClient.get<DMWithParticipants[]>('/api/dms'),
    enabled: token !== null,
    staleTime: 30_000,
  });

  return {
    dms: query.data ?? [],
    isLoading: query.isLoading && token !== null,
    isFetching: query.isFetching,
    error: query.error,
    refetch: async () => {
      await query.refetch();
    },
  };
}
