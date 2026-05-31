import * as React from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { MessageSquareText } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { MessageItem } from './MessageItem';
import { useMessages } from '@/hooks/useMessages';
import { cn } from '@/lib/utils';

import type { MessageWithAuthor } from '@app/shared/types/message';

/**
 * Props for {@link MessageList}.
 *
 * The list operates in one of two mutually exclusive modes:
 *
 * - **Live mode** — exactly one of `channelId` / `dmId` is supplied and the
 *   component drives a cursor-paginated, real-time timeline via the
 *   {@link useMessages} hook (Socket.io `message:new` updates are applied to
 *   the React Query cache inside the hook, so this component re-renders
 *   without an HTTP refetch).
 * - **Override mode** — `messagesOverride` is supplied (e.g., by a thread
 *   panel that fetches replies from a separate endpoint). The hook result is
 *   ignored, the supplied array is rendered directly, and cursor pagination is
 *   disabled.
 */
export interface MessageListProps {
  /** Channel scope. Mutually exclusive with `dmId`. */
  channelId?: string;
  /** DM scope. Mutually exclusive with `channelId`. */
  dmId?: string;
  /**
   * Optional thread parent. When set, every rendered {@link MessageItem} hides
   * its thread actions and is flagged as a thread reply. Consumed by the
   * thread panel; reserved for future use and defaults to `undefined`.
   */
  parentMessageId?: string;
  /**
   * Optional override list of messages — used by a thread panel that fetches
   * replies separately. When provided, the list does NOT call
   * {@link useMessages} for its data and renders this array directly (already
   * ordered oldest-first per the `Thread.replies` contract). Cursor pagination
   * is disabled.
   */
  messagesOverride?: readonly MessageWithAuthor[];
  /** Optional empty-state title customization. Defaults to "No messages yet". */
  emptyLabel?: string;
  /** Optional className applied to the outer container. */
  className?: string;
}

/**
 * A single rendered row of the timeline: either a hydrated message or a
 * day-boundary date separator. Modeled as a discriminated union so the render
 * loop can switch on `kind` with exhaustive type narrowing.
 */
type ListRow =
  | { kind: 'message'; message: MessageWithAuthor }
  | { kind: 'separator'; dayKey: string; label: string };

/**
 * Produces the human-friendly label shown in a date separator:
 * `isToday` -> "Today", `isYesterday` -> "Yesterday", otherwise the fully
 * spelled date (e.g. "Tuesday, July 23, 2024").
 */
function getDateSeparatorLabel(iso: string): string {
  const date = new Date(iso);
  if (isToday(date)) {
    return 'Today';
  }
  if (isYesterday(date)) {
    return 'Yesterday';
  }
  return format(date, 'EEEE, MMMM d, yyyy');
}

/**
 * Stable day-bucket key (`yyyy-MM-dd`) used to detect when consecutive
 * messages cross a calendar-day boundary and therefore need a separator.
 */
function getDayKey(iso: string): string {
  const date = new Date(iso);
  return format(date, 'yyyy-MM-dd');
}

/**
 * Walks an oldest-first message array and interleaves a date separator before
 * the first message of each new calendar day, yielding a flat list of rows for
 * the timeline to render.
 *
 * Callers MUST pass messages in display order (oldest -> newest). The
 * {@link useMessages} hook returns newest-first, so {@link MessageList}
 * reverses before calling this helper; thread-panel override arrays already
 * arrive oldest-first.
 */
function groupMessagesWithSeparators(messages: readonly MessageWithAuthor[]): readonly ListRow[] {
  if (messages.length === 0) {
    return [];
  }
  const result: ListRow[] = [];
  let lastDayKey: string | null = null;
  for (const message of messages) {
    const dayKey = getDayKey(message.createdAt);
    if (dayKey !== lastDayKey) {
      result.push({
        kind: 'separator',
        dayKey,
        label: getDateSeparatorLabel(message.createdAt),
      });
      lastDayKey = dayKey;
    }
    result.push({ kind: 'message', message });
  }
  return result;
}

/**
 * Props for the file-scoped {@link DateSeparator}.
 */
interface DateSeparatorProps {
  label: string;
}

/**
 * A centered date pill straddling a full-width divider line, matching the
 * "Today" / date separators in the Slack reference screenshots (Rule 1). The
 * divider line is decorative (`aria-hidden`); the pill text is the accessible
 * label.
 */
function DateSeparator({ label }: DateSeparatorProps): React.JSX.Element {
  return (
    <div data-slot="date-separator" className="relative my-3 flex items-center justify-center px-4">
      <div className="absolute inset-x-4 top-1/2 border-t border-border" aria-hidden="true" />
      <span className="relative z-10 rounded-full border border-border bg-background px-3 py-0.5 text-xs font-medium text-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * A single placeholder row approximating the avatar + author + body layout of
 * a real message. Six of these are stacked during the initial fetch so the
 * timeline reserves space and signals progress (history load &lt;1s, Gate 9).
 */
function MessageSkeleton(): React.JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-1.5" data-slot="message-skeleton">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    </div>
  );
}

/**
 * Terminal banner rendered at the very top of the timeline once every older
 * page has been loaded (`hasNextPage === false`), telling the user they have
 * reached the start of the conversation.
 */
function BeginningOfChannel(): React.JSX.Element {
  return (
    <div
      data-slot="beginning-of-channel"
      className="px-4 py-3 text-xs text-muted-foreground italic"
    >
      You&apos;re at the beginning of the conversation.
    </div>
  );
}

/**
 * MessageList — the scrollable, infinite-paginated, real-time message timeline
 * for a channel or DM (AAP §0.1.1 cursor-based 50/page; §0.6.3 IntersectionObserver
 * scroll trigger). Visual reference: screenshots/Slack web Jul 2024 29.png and
 * screenshots/Slack web Jul 2024 100.png (Rule 1).
 *
 * Renders, in order: a top sentinel that the {@link useMessages} observer uses
 * to load older pages, a paging spinner, a "beginning of channel" banner once
 * exhausted, then the messages themselves with date separators injected at
 * each calendar-day boundary. Falls back to a skeleton list during the initial
 * fetch, a shadcn `Empty` state when there are no messages, and a destructive
 * `Alert` when the fetch errors.
 *
 * Real-time delivery (Rule 2) is handled inside {@link useMessages} via
 * `setQueryData` (never polling, never `invalidate`), preserving the &lt;500ms
 * delivery budget; this component simply renders the resulting list.
 */
export function MessageList({
  channelId,
  dmId,
  parentMessageId,
  messagesOverride,
  emptyLabel,
  className,
}: MessageListProps): React.JSX.Element {
  // When `messagesOverride` is supplied we bypass the data hook entirely.
  const useOverride = messagesOverride !== undefined;

  // Hooks must run unconditionally (Rules of Hooks). In override mode we still
  // call useMessages but with an empty scope so it stays idle, and we ignore
  // every field it returns.
  const hookResult = useMessages(useOverride ? {} : { channelId, dmId });

  const isLoading = useOverride ? false : hookResult.isLoading;
  const isFetchingNextPage = useOverride ? false : hookResult.isFetchingNextPage;
  const hasNextPage = useOverride ? false : hookResult.hasNextPage;
  const error = useOverride ? null : hookResult.error;
  const sentinelRef = useOverride ? null : hookResult.sentinelRef;

  // Display order is oldest -> newest (top -> bottom), matching Slack. The hook
  // returns messages newest-first (it prepends on `message:new`), so reverse a
  // shallow copy for the timeline; thread-override arrays already arrive
  // oldest-first and are rendered as-is.
  const displayMessages = React.useMemo<readonly MessageWithAuthor[]>(() => {
    if (useOverride) {
      return messagesOverride ?? [];
    }
    return [...hookResult.messages].reverse();
  }, [useOverride, messagesOverride, hookResult.messages]);

  // Derived rows: messages interleaved with day-boundary date separators.
  const rows = React.useMemo<readonly ListRow[]>(
    () => groupMessagesWithSeparators(displayMessages),
    [displayMessages],
  );

  const messageCount = displayMessages.length;

  // ===== Empty state — no messages and nothing in flight or errored. =====
  if (!isLoading && error === null && messageCount === 0) {
    return (
      <div
        data-slot="message-list-empty"
        className={cn('flex h-full items-center justify-center', className)}
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareText className="size-6" />
            </EmptyMedia>
            <EmptyTitle>{emptyLabel ?? 'No messages yet'}</EmptyTitle>
            <EmptyDescription>Be the first to say hello.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // ===== Error state — the fetch failed. =====
  if (error !== null) {
    return (
      <div className={cn('p-4', className)}>
        <Alert variant="destructive" data-slot="message-list-error">
          <AlertTitle>Couldn&apos;t load messages</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // ===== Loading state — initial fetch with no cached messages yet. =====
  if (isLoading && messageCount === 0) {
    return (
      <div
        data-slot="message-list-loading"
        className={cn('flex flex-col gap-3 p-4', className)}
        aria-busy="true"
      >
        {Array.from({ length: 6 }).map((_, idx) => (
          <MessageSkeleton key={idx} />
        ))}
      </div>
    );
  }

  // ===== Main timeline. =====
  return (
    <ScrollArea data-slot="message-list" className={cn('h-full', className)}>
      {/* Accessible live region: announces Socket.io-delivered messages to
          screen readers as they arrive. `role="log"` marks an append-only
          chat timeline; `aria-live="polite"` queues announcements without
          interrupting; `aria-relevant="additions text"` limits announcements
          to newly added nodes (not removals/reorders from pagination). The
          surrounding Radix ScrollArea is untouched, so keyboard scrolling is
          preserved. */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Messages"
        className="flex flex-col py-2"
      >
        {/* Top sentinel: the useMessages IntersectionObserver attaches here to
            load older pages when the user scrolls up. Live mode only. */}
        {sentinelRef !== null && hasNextPage ? (
          <div ref={sentinelRef} data-slot="message-list-sentinel" className="h-1" />
        ) : null}

        {/* Pagination spinner while an older page is being fetched. */}
        {isFetchingNextPage ? (
          <div className="flex justify-center py-2" data-slot="message-list-paging">
            <Spinner />
          </div>
        ) : null}

        {/* Start-of-conversation banner once every older page is loaded. */}
        {!hasNextPage && !useOverride ? <BeginningOfChannel /> : null}

        {rows.map((row) => {
          if (row.kind === 'separator') {
            return <DateSeparator key={`sep-${row.dayKey}`} label={row.label} />;
          }
          return (
            <MessageItem
              key={row.message.id}
              message={row.message}
              hideThreadActions={parentMessageId !== undefined}
              isThreadReply={parentMessageId !== undefined}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
