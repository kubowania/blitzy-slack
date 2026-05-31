/**
 * Paginated message-timeline hook for channels and direct messages.
 *
 * This hook owns the message-list data for a single channel OR DM and combines
 * three concerns behind one API:
 *
 *   1. Cursor-based pagination — TanStack Query `useInfiniteQuery` loads
 *      `PAGE_SIZE` messages per page using an opaque string cursor (the encoded
 *      `(createdAt, id)` of the oldest already-loaded message).
 *   2. Infinite scroll — a `sentinelRef` callback ref drives an
 *      `IntersectionObserver` mounted at the TOP (older end) of the message
 *      list; when the sentinel approaches the viewport the hook loads the next
 *      older page.
 *   3. Real-time updates — Socket.io subscriptions mutate the TanStack cache
 *      via `setQueryData` so the timeline re-renders without an HTTP refetch:
 *        - `message:new` prepends in-scope top-level messages into the first page.
 *        - `reaction:added` / `reaction:removed` patch the `reactions` array of
 *          the affected message wherever it lives across the loaded pages.
 *
 * Consumed by the channel and direct-message pages. Returns a flattened
 * `messages` array (newest first), pagination state, an error, and the sentinel
 * ref for the scroll trigger.
 */
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { PAGE_SIZE } from '@app/shared/constants/limits';
import type { MessageWithAuthor, ReactionSummary } from '@app/shared/types/message';

import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

import { useSocketEvent } from './useSocket';

/**
 * Options selecting the timeline scope. EXACTLY ONE of `channelId` / `dmId`
 * should be provided; when neither is set the hook stays idle.
 */
export interface UseMessagesOptions {
  /** Channel id for a channel timeline. Mutually exclusive with `dmId`. */
  channelId?: string;
  /** DM id for a direct-message timeline. Mutually exclusive with `channelId`. */
  dmId?: string;
}

/**
 * One page of the message timeline as returned by the API. Messages are ordered
 * newest-first within a page; `nextCursor` points at the next OLDER page and is
 * `null` once the oldest message has been reached.
 */
interface MessagesPage {
  messages: MessageWithAuthor[];
  nextCursor: string | null;
}

/**
 * Public result shape returned by {@link useMessages}.
 */
export interface UseMessagesResult {
  /** Flattened messages from every loaded page, newest first. */
  messages: MessageWithAuthor[];
  /** Whether the initial page is loading. */
  isLoading: boolean;
  /** Whether ANY fetch (initial or pagination) is in flight. */
  isFetching: boolean;
  /** Whether a pagination fetch is currently in flight. */
  isFetchingNextPage: boolean;
  /** Whether more older pages exist. */
  hasNextPage: boolean;
  /** Manual trigger for the next older page; normally invoked by the sentinel observer. */
  fetchNextPage: () => Promise<void>;
  /** Query error, if any. */
  error: Error | null;
  /**
   * Callback ref to attach to a sentinel element at the TOP of the message
   * list. When the sentinel approaches the viewport the hook calls
   * {@link UseMessagesResult.fetchNextPage} to load older messages.
   */
  sentinelRef: (node: HTMLElement | null) => void;
}

/**
 * Paginated message timeline for a channel or DM.
 *
 * Pagination uses `useInfiniteQuery` keyed by `['messages', scopeKey]` where
 * `scopeKey` is `'channel:<id>'` or `'dm:<id>'`, isolating cache entries per
 * conversation. The fetch is gated on an authenticated token and a resolved
 * scope.
 *
 * The `message:new` subscription prepends only top-level (`parentId === null`)
 * messages that match this hook's scope, de-duplicating by id before inserting
 * into the first page. Thread replies and messages for other conversations are
 * ignored.
 *
 * The `reaction:added` / `reaction:removed` subscriptions patch the `reactions`
 * array of the affected message in place, searching every loaded page by id.
 * Because the reaction events carry only a `messageId` (no scope), each mounted
 * `useMessages` instance updates its cache ONLY when it actually contains the
 * message; events for messages in other conversations (or thread replies, which
 * never appear in this timeline) are no-ops. `hasCurrentUser` is recomputed
 * against the local viewer's id rather than trusting the broadcast payload.
 *
 * @param options - The channel or DM whose timeline to load.
 * @returns The flattened messages, pagination state, error, and sentinel ref.
 */
export function useMessages(options: UseMessagesOptions): UseMessagesResult {
  const { channelId, dmId } = options;
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);
  // The local viewer's id. Reaction broadcasts carry a `ReactionSummary` whose
  // `hasCurrentUser` reflects the REACTOR, not this viewer, so the cache update
  // recomputes `hasCurrentUser` against this id from the authoritative
  // `userIds` list.
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const scopeKey =
    channelId !== undefined ? `channel:${channelId}` : dmId !== undefined ? `dm:${dmId}` : null;
  const queryKey = ['messages', scopeKey] as const;

  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    InfiniteData<MessagesPage>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    initialPageParam: null,
    enabled: token !== null && scopeKey !== null,
    queryFn: async ({ pageParam }): Promise<MessagesPage> => {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (pageParam !== null) {
        params.set('cursor', pageParam);
      }
      const path =
        channelId !== undefined
          ? `/api/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`
          : `/api/dms/${encodeURIComponent(dmId ?? '')}/messages?${params.toString()}`;
      return await apiClient.get<MessagesPage>(path);
    },
    getNextPageParam: (lastPage): string | null => lastPage.nextCursor,
  });

  const messages = (query.data?.pages ?? []).flatMap((page) => page.messages);

  const fetchNextPage = useCallback(async (): Promise<void> => {
    if (!query.hasNextPage || query.isFetchingNextPage) {
      return;
    }
    await query.fetchNextPage();
  }, [query]);

  useSocketEvent('message:new', (incoming): void => {
    const inScope =
      incoming.parentId === null &&
      ((channelId !== undefined && incoming.channelId === channelId) ||
        (dmId !== undefined && incoming.dmId === dmId));
    if (!inScope) {
      return;
    }
    queryClient.setQueryData<InfiniteData<MessagesPage>>(
      queryKey,
      (current): InfiniteData<MessagesPage> | undefined => {
        if (current === undefined) {
          return current;
        }
        const [firstPage, ...restPages] = current.pages;
        if (firstPage === undefined) {
          return current;
        }
        if (firstPage.messages.some((m) => m.id === incoming.id)) {
          return current;
        }
        const updatedFirstPage: MessagesPage = {
          ...firstPage,
          messages: [incoming, ...firstPage.messages],
        };
        return {
          ...current,
          pages: [updatedFirstPage, ...restPages],
        };
      },
    );
  });

  /**
   * Patches the `reactions` array of a single message within the page-aware
   * infinite-query cache. Maps over every loaded page and applies `mutate` to
   * the matching message's reactions; returns the cache unchanged when the
   * message is not present in this timeline (the reaction belongs to another
   * conversation or a thread reply this hook does not render).
   *
   * Implemented with `map`/`some` (no indexed access) so it is sound under
   * `noUncheckedIndexedAccess`.
   */
  const updateMessageReactions = (
    messageId: string,
    mutate: (reactions: ReactionSummary[]) => ReactionSummary[],
  ): void => {
    queryClient.setQueryData<InfiniteData<MessagesPage>>(
      queryKey,
      (current): InfiniteData<MessagesPage> | undefined => {
        if (current === undefined) {
          return current;
        }
        let didChange = false;
        const pages = current.pages.map((page): MessagesPage => {
          if (!page.messages.some((m) => m.id === messageId)) {
            return page;
          }
          didChange = true;
          return {
            ...page,
            messages: page.messages.map((m) =>
              m.id === messageId ? { ...m, reactions: mutate(m.reactions) } : m,
            ),
          };
        });
        if (!didChange) {
          return current;
        }
        return { ...current, pages };
      },
    );
  };

  useSocketEvent('reaction:added', ({ messageId, reaction }): void => {
    updateMessageReactions(messageId, (reactions) => {
      // Recompute `hasCurrentUser` for THIS viewer from the authoritative
      // `userIds`; the broadcast payload's flag reflects the reactor.
      const normalized: ReactionSummary = {
        ...reaction,
        hasCurrentUser: currentUserId !== null && reaction.userIds.includes(currentUserId),
      };
      if (!reactions.some((r) => r.emoji === normalized.emoji)) {
        return [...reactions, normalized];
      }
      return reactions.map((r) => (r.emoji === normalized.emoji ? normalized : r));
    });
  });

  useSocketEvent('reaction:removed', ({ messageId, emoji, userId }): void => {
    updateMessageReactions(messageId, (reactions) =>
      // Drop `userId` from the matching chip; remove the chip entirely once its
      // last reactor leaves. `flatMap` returning `[]` deletes; `[entry]` keeps.
      reactions.flatMap((r): ReactionSummary[] => {
        if (r.emoji !== emoji) {
          return [r];
        }
        const nextUserIds = r.userIds.filter((id) => id !== userId);
        if (nextUserIds.length === 0) {
          return [];
        }
        return [
          {
            ...r,
            userIds: nextUserIds,
            count: nextUserIds.length,
            hasCurrentUser: currentUserId !== null && nextUserIds.includes(currentUserId),
          },
        ];
      }),
    );
  });

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelNodeRef = useRef<HTMLElement | null>(null);

  const sentinelRef = useCallback(
    (node: HTMLElement | null): void => {
      if (observerRef.current !== null) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      sentinelNodeRef.current = node;
      if (node === null) {
        return;
      }
      const observer = new IntersectionObserver(
        (entries): void => {
          const entry = entries[0];
          if (entry?.isIntersecting === true) {
            void fetchNextPage();
          }
        },
        { rootMargin: '200px 0px 0px 0px' },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [fetchNextPage],
  );

  useEffect(() => {
    return () => {
      if (observerRef.current !== null) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  return {
    messages,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage,
    error: query.error,
    sentinelRef,
  };
}
