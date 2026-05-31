import { Navigate, useParams } from 'react-router';

import { ChannelHeader } from '@/components/channels/ChannelHeader';
import { MessageComposer } from '@/components/messages/MessageComposer';
import { MessageList } from '@/components/messages/MessageList';
import { TypingIndicator } from '@/components/messages/TypingIndicator';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannels } from '@/hooks/useChannels';

/**
 * Channel message-timeline page, rendered at `/app/channels/:channelId` and
 * code-split through the router's `lazy(() => import('@/pages/Channel'))`.
 * Reproduces the main authenticated channel view from the reference
 * screenshots (Slack web Jul 2024 29 / 100): a stacked layout of channel
 * header, scrollable message timeline, typing indicator, and message composer.
 *
 * The active channel is resolved from {@link useChannels} by the `:channelId`
 * route segment read with {@link useParams}. The page renders one of four
 * states:
 *  - No `:channelId` segment → redirects to the workspace root (`/app`).
 *  - Channel list loading with no cached match yet → {@link Skeleton}
 *    placeholders for the header and a few message rows.
 *  - Loading settled with no matching channel → an {@link Empty} state.
 *  - Channel resolved → {@link ChannelHeader} above a {@link MessageList}
 *    timeline, with {@link TypingIndicator} and {@link MessageComposer}
 *    pinned to the bottom.
 */
export default function Channel() {
  const { channelId } = useParams<{ channelId: string }>();
  const { channels, isLoading } = useChannels();

  if (channelId === undefined) {
    return <Navigate to="/app" replace />;
  }

  const channel = channels.find((c) => c.id === channelId);

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

  if (channel === undefined) {
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
      <MessageList channelId={channelId} className="flex-1 min-h-0" />
      <TypingIndicator channelId={channelId} className="shrink-0 px-6" />
      <MessageComposer
        channelId={channelId}
        scopeName={channel.name}
        hideTypingIndicator
        className="shrink-0"
      />
    </div>
  );
}
