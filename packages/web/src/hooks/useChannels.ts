import { useQuery } from '@tanstack/react-query';

import type { ChannelWithMembers } from '@app/shared/types/channel';

import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Normalized result shape returned by {@link useChannels}.
 *
 * This is the React-friendly projection of TanStack Query's
 * `UseQueryResult`: consumers read these five fields directly and never
 * touch the underlying `data`/`isPending`/`isError` boilerplate.
 */
export interface UseChannelsResult {
  /** Channels the authenticated user can see (public + private the user belongs to). Empty array while loading or on error. */
  channels: ChannelWithMembers[];
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
 * TanStack Query wrapper that fetches the authenticated user's channel list
 * from `GET /api/channels` and exposes it as the normalized
 * {@link UseChannelsResult} shape.
 *
 * Behavior:
 * - Auth-gated: the query is `enabled` only when the auth store holds a
 *   non-null `token`. Logged-out callers receive an empty `channels` array
 *   and `isLoading: false` without firing a network request.
 * - Cache key: `['channels']`. Mutation hooks and socket event handlers
 *   refresh this list by invalidating the same key via
 *   `queryClient.invalidateQueries({ queryKey: ['channels'] })`; this hook is
 *   the read side and performs no invalidation itself.
 * - The bearer token is attached automatically by `apiClient`, so the
 *   `queryFn` only needs the path.
 */
export function useChannels(): UseChannelsResult {
  const token = useAuthStore((s) => s.token);

  const query = useQuery<ChannelWithMembers[], Error>({
    queryKey: ['channels'],
    queryFn: () => apiClient.get<ChannelWithMembers[]>('/api/channels'),
    enabled: token !== null,
  });

  return {
    channels: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: async () => {
      await query.refetch();
    },
  };
}
