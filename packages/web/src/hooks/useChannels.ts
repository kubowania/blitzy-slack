import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import type { CreateChannelInput } from '@app/shared/schemas/channel';
import type { Channel, ChannelSummary, ChannelWithMembers } from '@app/shared/types/channel';

import { apiClient, type ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

/**
 * TanStack Query cache key for the authenticated user's channel list.
 *
 * Exported so mutation hooks and socket event handlers can invalidate the
 * exact same key (`['channels']`) that {@link useChannels} reads from.
 */
export const CHANNELS_QUERY_KEY = ['channels'] as const;

/**
 * Normalized result shape returned by {@link useChannels}.
 *
 * This is the React-friendly projection of TanStack Query's
 * `UseQueryResult`: consumers read these five fields directly and never
 * touch the underlying `data`/`isPending`/`isError` boilerplate.
 */
export interface UseChannelsResult {
  /**
   * Channels the authenticated user can see (public + private the user
   * belongs to). Each entry is the lightweight {@link ChannelSummary} DTO
   * returned by `GET /api/channels`, NOT the hydrated `ChannelWithMembers`
   * shape (which is only returned by the channel-detail endpoint). Empty
   * array while loading or on error.
   */
  channels: ChannelSummary[];
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
 * - Cache key: {@link CHANNELS_QUERY_KEY} (`['channels']`). The mutation hooks
 *   in this module ({@link useCreateChannel}, {@link useJoinChannel},
 *   {@link useLeaveChannel}) refresh this list by invalidating the same key;
 *   this hook is the read side and performs no invalidation itself.
 * - Response type is `ChannelSummary[]`, matching the backend contract for
 *   `GET /api/channels` (see `packages/api/src/routes/channels.ts`). The
 *   bearer token is attached automatically by `apiClient`, so the `queryFn`
 *   only needs the path.
 */
export function useChannels(): UseChannelsResult {
  const token = useAuthStore((s) => s.token);

  const query = useQuery<ChannelSummary[], Error>({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: () => apiClient.get<ChannelSummary[]>('/api/channels'),
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

/**
 * TanStack Query cache-key factory for a single channel's hydrated detail.
 *
 * Keyed `['channels', channelId]` — namespaced under the same `'channels'` root
 * as {@link CHANNELS_QUERY_KEY} but distinguished by the id segment, so a detail
 * fetch never collides with (or overwrites) the channel-list cache. Exported so
 * callers can target the exact entry for invalidation.
 */
export const CHANNEL_DETAIL_QUERY_KEY = (channelId: string) => ['channels', channelId] as const;

/**
 * TanStack Query wrapper that fetches a single channel's hydrated detail from
 * `GET /api/channels/:id` and returns the {@link ChannelWithMembers} shape (base
 * channel fields plus the member list and the precomputed `memberCount`).
 *
 * Behavior:
 * - Auth- and param-gated: the query is `enabled` only when the auth store holds
 *   a non-null `token` AND a `channelId` is provided. A logged-out caller or an
 *   absent route param yields `undefined` data with `isLoading: false` and fires
 *   no network request.
 * - Cache key: {@link CHANNEL_DETAIL_QUERY_KEY} (`['channels', channelId]`),
 *   distinct from the `['channels']` list key so the two never overwrite each
 *   other.
 * - Response type is `ChannelWithMembers`, matching the backend contract for the
 *   channel-detail endpoint (the only channel endpoint that returns the member
 *   list and `memberCount`). The bearer token is attached automatically by
 *   `apiClient`, so the `queryFn` only needs the path.
 *
 * The backend enforces the channel-detail ACL (public → any authenticated user;
 * private → member only); a `403`/`404` surfaces through the returned query's
 * `error`, which the channel page renders as a not-found Empty state.
 */
export function useChannel(
  channelId: string | undefined,
): UseQueryResult<ChannelWithMembers, Error> {
  const token = useAuthStore((s) => s.token);

  return useQuery<ChannelWithMembers, Error>({
    queryKey: CHANNEL_DETAIL_QUERY_KEY(channelId ?? ''),
    queryFn: () =>
      apiClient.get<ChannelWithMembers>(`/api/channels/${encodeURIComponent(channelId ?? '')}`),
    enabled: token !== null && channelId !== undefined,
  });
}

/**
 * Mutation hook that creates a channel via `POST /api/channels`.
 *
 * The request body is the shared {@link CreateChannelInput} (validated by
 * `createChannelSchema` on both the form and the API). The backend returns the
 * base {@link Channel} DTO (NOT `ChannelWithMembers`); the hook is typed
 * accordingly so callers cannot read members/memberCount that the create
 * endpoint does not send. On success it invalidates {@link CHANNELS_QUERY_KEY}
 * so the sidebar list refetches and shows the new channel.
 */
export function useCreateChannel(): UseMutationResult<Channel, ApiError, CreateChannelInput> {
  const queryClient = useQueryClient();

  return useMutation<Channel, ApiError, CreateChannelInput>({
    mutationFn: (input) => apiClient.post<Channel>('/api/channels', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
  });
}

/**
 * Mutation hook that joins a channel via `POST /api/channels/:id/join`.
 *
 * The mutation variable is the target channel id. The backend returns the base
 * {@link Channel} DTO. On success it invalidates {@link CHANNELS_QUERY_KEY} so
 * the newly joined channel appears in the sidebar list.
 */
export function useJoinChannel(): UseMutationResult<Channel, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<Channel, ApiError, string>({
    mutationFn: (channelId) =>
      apiClient.post<Channel>(`/api/channels/${encodeURIComponent(channelId)}/join`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
  });
}

/**
 * Mutation hook that leaves a channel via `POST /api/channels/:id/leave`.
 *
 * The mutation variable is the target channel id. The backend returns
 * `{ ok: true }`. On success it invalidates {@link CHANNELS_QUERY_KEY} so the
 * left channel disappears from the sidebar list.
 */
export function useLeaveChannel(): UseMutationResult<{ ok: true }, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: (channelId) =>
      apiClient.post<{ ok: true }>(`/api/channels/${encodeURIComponent(channelId)}/leave`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
  });
}
