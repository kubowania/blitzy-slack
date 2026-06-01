import * as React from 'react';
import { Navigate, useParams } from 'react-router';

import { ChannelHeader } from '@/components/channels/ChannelHeader';
import { MessageComposer } from '@/components/messages/MessageComposer';
import { MessageList } from '@/components/messages/MessageList';
import { TypingIndicator } from '@/components/messages/TypingIndicator';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannel } from '@/hooks/useChannels';
import { useSocket } from '@/hooks/useSocket';

/**
 * Channel message-timeline page, rendered at `/app/channels/:channelId` and
 * code-split through the router's `lazy(() => import('@/pages/Channel'))`.
 * Reproduces the main authenticated channel view from the reference
 * screenshots (Slack web Jul 2024 29 / 100): a stacked layout of channel
 * header, scrollable message timeline, typing indicator, and message composer.
 *
 * The active channel's hydrated detail (including the member list and
 * `memberCount` that {@link ChannelHeader} renders) is fetched from
 * `GET /api/channels/:id` through {@link useChannel}, keyed by the `:channelId`
 * route segment read with {@link useParams}. The page renders one of four
 * states:
 *  - No `:channelId` segment → redirects to the workspace root (`/app`).
 *  - Detail loading with no cached value yet → {@link Skeleton} placeholders for
 *    the header and a few message rows.
 *  - Fetch error (e.g. a `403`/`404` from the channel-detail ACL) or settled
 *    with no channel → an {@link Empty} not-found state.
 *  - Channel resolved → {@link ChannelHeader} above a {@link MessageList}
 *    timeline, with {@link TypingIndicator} and {@link MessageComposer}
 *    pinned to the bottom.
 *
 * On mount (and on socket reconnect) the page subscribes its live socket to the
 * `channel:<channelId>` broadcast room via the typed `channel:join` event so
 * channels created or joined mid-session receive real-time updates without a
 * reconnect (Rule 2). The socket is intentionally not unsubscribed on unmount;
 * that trade-off is recorded in /docs/decision-log.md.
 */
export default function Channel() {
  const { channelId } = useParams<{ channelId: string }>();
  const { data: channel, isLoading, error } = useChannel(channelId);
  const { emit, isConnected } = useSocket();

  // Subscribe the live socket to this channel's room. Connection-time auto-join
  // only covers channels the user already belonged to when the socket connected,
  // so a channel created/joined mid-session is subscribed here. channel:join is
  // idempotent and re-fires on reconnect (isConnected dep). The socket is not
  // unsubscribed on unmount, by design — see docs/decision-log.md.
  React.useEffect(() => {
    if (channelId === undefined || !isConnected) {
      return;
    }
    emit('channel:join', channelId, () => {
      // Advisory ack; a failed join is surfaced by the server `error` event.
    });
  }, [channelId, isConnected, emit]);

  // Maps a user id to its display name from the channel's hydrated member list.
  // Drives named typing indicators ("Alice is typing…", AAP §0.1.1) and named
  // reactor tooltips on reaction chips (AAP §0.5.2). Memoized on the member
  // list so it stays referentially stable across unrelated re-renders. Declared
  // before the early returns to satisfy the Rules of Hooks (`channel` may be
  // undefined while the detail query is in flight).
  const members = channel?.members;
  const resolveDisplayName = React.useCallback(
    (userId: string): string | undefined =>
      members?.find((member) => member.user.id === userId)?.user.displayName,
    [members],
  );

  if (channelId === undefined) {
    return <Navigate to="/app" replace />;
  }

  if (isLoading && channel === undefined) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="ml-auto h-6 w-16" />
        </header>
        <div className="flex flex-1 flex-col justify-end gap-2 px-6 py-4">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-12 w-1/2" />
          <Skeleton className="h-12 w-3/4" />
        </div>
      </div>
    );
  }

  if (error !== null || channel === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyTitle>Channel not found</EmptyTitle>
            <EmptyDescription>
              The channel you’re looking for doesn’t exist or you don’t have access.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <ChannelHeader channel={channel} />
      <MessageList
        channelId={channelId}
        resolveDisplayName={resolveDisplayName}
        className="flex-1 min-h-0"
      />
      <TypingIndicator
        channelId={channelId}
        resolveDisplayName={resolveDisplayName}
        className="shrink-0 px-6"
      />
      <MessageComposer
        channelId={channelId}
        scopeName={channel.name}
        hideTypingIndicator
        className="shrink-0"
      />
    </div>
  );
}
