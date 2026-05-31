/**
 * ThreadPanel — the right-hand threaded-replies panel rendered inside a shadcn
 * `Sheet` (AAP §0.1.1 threads via `Message.parentId` self-reference; §0.6.3 the
 * panel is URL-driven and opens automatically on `/app/threads/:messageId`).
 *
 * Behavior:
 *   1. Fetches the thread (`{ parent, replies }`) via
 *      `GET /api/messages/:messageId/replies`, keyed by `['thread', id]` and
 *      disabled while the panel is closed.
 *   2. Renders the parent message at the top as a non-actionable
 *      {@link MessageItem} (`hideThreadActions` — threading is single-level per
 *      AAP §0.4.4).
 *   3. Renders the reply list with {@link MessageList} in override mode
 *      (`messagesOverride`), oldest-first per the `Thread.replies` contract.
 *   4. Joins the `thread:<parentMessageId>` Socket.io room on open and leaves it
 *      on close/unmount (the backend does not auto-join thread rooms), then
 *      subscribes to three server events and reconciles the cache directly
 *      (Rule 2 — real-time fan-out, never polling): `message:new` appends a
 *      reply when its `parentId` matches this thread; `reaction:added` and
 *      `reaction:removed` update reaction summaries on the parent or any reply,
 *      recomputing `hasCurrentUser` against the local viewer's id.
 *   5. Validates the fetched payload against `threadResponseSchema` so a
 *      server/client shape drift surfaces as a thrown error at the fetch
 *      boundary rather than a silent crash deep in the render tree.
 *   6. Mounts a {@link MessageComposer} at the bottom that posts replies scoped
 *      to `parentMessageId`.
 *   7. Closes through the `onClose` callback wired to the Sheet's
 *      `onOpenChange`; the parent route/shell owns where closing navigates to.
 *
 * Visual reference (Rule 1): screenshots/Slack web Jul 2024 29.png — a flush
 * three-section right panel (header → scrollable parent + replies → composer),
 * white content surface, subtle dividers.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { MessageItem } from './MessageItem';
import { MessageList } from './MessageList';
import { MessageComposer } from './MessageComposer';
import { useSocket, useSocketEvent } from '@/hooks/useSocket';
import { apiClient, type ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { threadResponseSchema } from '@app/shared/schemas/message';
import type { MessageWithAuthor, ReactionSummary, Thread } from '@app/shared/types/message';

/**
 * Props for {@link ThreadPanel}.
 */
export interface ThreadPanelProps {
  /** Whether the Sheet is open. */
  open: boolean;
  /** Called when the user requests to close the panel. */
  onClose: () => void;
  /** The parent message ID — used to fetch the thread. */
  parentMessageId: string;
  /** Optional className merged into the SheetContent. */
  className?: string;
}

/**
 * ThreadPanel — see the module docblock for the full behavioral contract.
 */
export function ThreadPanel({
  open,
  onClose,
  parentMessageId,
  className,
}: ThreadPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const { emit } = useSocket();
  // The local viewer's id; reaction broadcasts carry a `hasCurrentUser` that
  // reflects the REACTOR, so cache updates recompute it against this id.
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const queryKey: readonly unknown[] = ['thread', parentMessageId];

  // Fetch parent + replies, disabled while the panel is closed. The raw
  // response is validated through `threadResponseSchema` (a `ZodError` at the
  // fetch boundary if the server shape drifts).
  const threadQuery = useQuery<Thread, ApiError>({
    queryKey,
    queryFn: async (): Promise<Thread> =>
      apiClient.get(`/api/messages/${parentMessageId}/replies`, {
        schema: threadResponseSchema,
      }),
    enabled: open,
    staleTime: 30_000,
  });

  // Thread rooms are not auto-joined by the backend, so the panel explicitly
  // joins `thread:<parentMessageId>` while open and leaves on close/unmount.
  // Without this subscription, reactions on replies (broadcast to the thread
  // room only) would never reach an open panel.
  React.useEffect(() => {
    if (!open) {
      return undefined;
    }
    emit('thread:join', parentMessageId);
    return () => {
      emit('thread:leave', parentMessageId);
    };
  }, [open, parentMessageId, emit]);

  // Real-time: when a new message arrives whose `parentId` is this thread,
  // append it to the cached replies array (idempotent against duplicate
  // emissions).
  useSocketEvent('message:new', (incoming: MessageWithAuthor) => {
    if (incoming.parentId !== parentMessageId) {
      return;
    }
    queryClient.setQueryData<Thread>(queryKey, (prev) => {
      if (prev === undefined) {
        return prev;
      }
      if (prev.replies.some((reply) => reply.id === incoming.id)) {
        return prev;
      }
      return {
        ...prev,
        replies: [...prev.replies, incoming],
      };
    });
  });

  // Real-time: a reaction was added to the parent OR to any reply.
  useSocketEvent('reaction:added', ({ messageId, reaction }) => {
    queryClient.setQueryData<Thread>(queryKey, (prev) => {
      if (prev === undefined) {
        return prev;
      }
      return updateReactionsInThread(prev, messageId, reaction.emoji, reaction, currentUserId);
    });
  });

  // Real-time: a reaction was removed from the parent OR from any reply.
  useSocketEvent('reaction:removed', ({ messageId, emoji, userId }) => {
    queryClient.setQueryData<Thread>(queryKey, (prev) => {
      if (prev === undefined) {
        return prev;
      }
      return removeReactionFromThread(prev, messageId, emoji, userId, currentUserId);
    });
  });

  // The reply composer scopes its typing events to the parent's channel/DM.
  const parentScope = React.useMemo<{
    channelId: string | undefined;
    dmId: string | undefined;
  }>(() => {
    const data = threadQuery.data;
    if (data === undefined) {
      return { channelId: undefined, dmId: undefined };
    }
    return {
      channelId: data.parent.channelId ?? undefined,
      dmId: data.parent.dmId ?? undefined,
    };
  }, [threadQuery.data]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className={cn('flex w-full flex-col gap-0 p-0 sm:max-w-md', className)}
        data-slot="thread-panel"
      >
        <SheetHeader className="space-y-0.5 border-b border-border px-4 py-3">
          <SheetTitle>Thread</SheetTitle>
          <SheetDescription>
            {threadQuery.data !== undefined ? (
              <span>
                {threadQuery.data.replies.length}{' '}
                {threadQuery.data.replies.length === 1 ? 'reply' : 'replies'}
              </span>
            ) : (
              <span>Loading replies...</span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {threadQuery.isLoading ? (
            <ThreadSkeleton />
          ) : threadQuery.error !== null ? (
            <div className="p-4">
              <Alert variant="destructive" data-slot="thread-error">
                <AlertTitle>Couldn&apos;t load thread</AlertTitle>
                <AlertDescription>{threadQuery.error.message}</AlertDescription>
              </Alert>
            </div>
          ) : threadQuery.data !== undefined ? (
            <ThreadBody thread={threadQuery.data} parentMessageId={parentMessageId} />
          ) : null}
        </div>

        <div className="border-t border-border" data-slot="thread-composer">
          <MessageComposer
            channelId={parentScope.channelId}
            dmId={parentScope.dmId}
            parentMessageId={parentMessageId}
            hideTypingIndicator
            scopeName={undefined}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Props for the file-scoped {@link ThreadBody}.
 */
interface ThreadBodyProps {
  thread: Thread;
  parentMessageId: string;
}

/**
 * ThreadBody — the scrollable region holding the parent message, a "X replies"
 * divider, and the reply list. Kept internal because it has no use outside the
 * panel and shares the parent's data shape.
 */
function ThreadBody({ thread, parentMessageId }: ThreadBodyProps): React.JSX.Element {
  const replyCount = thread.replies.length;

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col py-2">
        {/* Parent message — non-actionable inside the thread (single-level). */}
        <MessageItem message={thread.parent} hideThreadActions />

        {/* Replies divider header — only when at least one reply exists. */}
        {replyCount > 0 ? (
          <div className="my-2 flex items-center gap-3 px-4" data-slot="thread-replies-header">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </span>
            <Separator className="flex-1" />
          </div>
        ) : null}

        {/* Reply list (oldest-first per the Thread contract), override mode. */}
        <MessageList
          parentMessageId={parentMessageId}
          messagesOverride={thread.replies}
          emptyLabel="No replies yet"
        />
      </div>
    </ScrollArea>
  );
}

/**
 * ThreadSkeleton — the loading placeholder shown during the thread's initial
 * fetch: a parent-message skeleton, a divider, then three reply-row skeletons.
 */
function ThreadSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true" data-slot="thread-skeleton">
      <div className="flex gap-3">
        <Skeleton className="size-9 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      </div>
      <Separator />
      {Array.from({ length: 3 }).map((_, idx) => (
        <div key={idx} className="flex gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Returns a copy of `thread` with the reaction summary for `(messageId, emoji)`
 * replaced by `newSummary` (or appended when the message has no summary for
 * that emoji yet). `hasCurrentUser` is recomputed from the authoritative
 * `userIds` against `currentUserId` (the broadcast payload's flag reflects the
 * reactor, not this viewer). Applies to the parent and every reply; messages
 * whose id does not match are returned unchanged. Pure — never mutates input.
 */
function updateReactionsInThread(
  thread: Thread,
  messageId: string,
  emoji: string,
  newSummary: ReactionSummary,
  currentUserId: string | null,
): Thread {
  const normalized: ReactionSummary = {
    ...newSummary,
    hasCurrentUser: currentUserId !== null && newSummary.userIds.includes(currentUserId),
  };
  const updateOne = (message: MessageWithAuthor): MessageWithAuthor => {
    if (message.id !== messageId) {
      return message;
    }
    const existingIdx = message.reactions.findIndex((r) => r.emoji === emoji);
    if (existingIdx === -1) {
      return { ...message, reactions: [...message.reactions, normalized] };
    }
    const nextReactions = [...message.reactions];
    nextReactions[existingIdx] = normalized;
    return { ...message, reactions: nextReactions };
  };
  return {
    parent: updateOne(thread.parent),
    replies: thread.replies.map(updateOne),
  };
}

/**
 * Returns a copy of `thread` with `userId` removed from the `(messageId, emoji)`
 * reaction. When that was the last reactor, the summary is dropped entirely;
 * otherwise the count and reactor list are decremented and `hasCurrentUser` is
 * recomputed from the remaining `userIds` against `currentUserId`. Applies to
 * the parent and every reply; non-matching messages are returned unchanged.
 * Pure — never mutates its input.
 */
function removeReactionFromThread(
  thread: Thread,
  messageId: string,
  emoji: string,
  userId: string,
  currentUserId: string | null,
): Thread {
  const updateOne = (message: MessageWithAuthor): MessageWithAuthor => {
    if (message.id !== messageId) {
      return message;
    }
    const idx = message.reactions.findIndex((r) => r.emoji === emoji);
    if (idx === -1) {
      return message;
    }
    // `noUncheckedIndexedAccess` types indexed access as `T | undefined`; the
    // `findIndex` result guarantees presence, so narrow defensively.
    const existing = message.reactions[idx];
    if (existing === undefined) {
      return message;
    }
    const nextUserIds = existing.userIds.filter((id) => id !== userId);
    if (nextUserIds.length === 0) {
      return {
        ...message,
        reactions: message.reactions.filter((_, i) => i !== idx),
      };
    }
    const nextReactions = [...message.reactions];
    nextReactions[idx] = {
      ...existing,
      userIds: nextUserIds,
      count: nextUserIds.length,
      hasCurrentUser: currentUserId !== null && nextUserIds.includes(currentUserId),
    };
    return { ...message, reactions: nextReactions };
  };
  return {
    parent: updateOne(thread.parent),
    replies: thread.replies.map(updateOne),
  };
}
