import * as React from 'react';
import { useNavigate, useParams } from 'react-router';
import { Lock } from 'lucide-react';

import type { ChannelSummary } from '@app/shared/types/channel';

import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Props for {@link ChannelListItem}.
 */
export interface ChannelListItemProps {
  /** The channel to render. Narrow shape: id, name, isPrivate, optional unreadCount. */
  channel: ChannelSummary;
  /** Optional className passthrough for the root `Item`. */
  className?: string;
}

/**
 * A single channel row in the sidebar's Channels section.
 *
 * Renders a `#` text prefix for public channels (or a {@link Lock} icon for
 * private channels), the channel name (truncated on overflow), and an optional
 * unread-count {@link Badge}. The row is highlighted when its channel id matches
 * the current `:channelId` route param, and navigates to
 * `/app/channels/:channelId` on click or keyboard activation (Enter/Space).
 *
 * Composed from the shadcn `Item` primitives. Behaves as an ARIA button: it is
 * focusable (`tabIndex={0}`), exposes `role="button"`, and marks the active row
 * with `aria-current="page"`.
 */
export function ChannelListItem({ channel, className }: ChannelListItemProps): React.JSX.Element {
  const params = useParams<{ channelId?: string }>();
  const navigate = useNavigate();
  const isActive = params.channelId === channel.id;

  const handleClick = React.useCallback((): void => {
    void navigate(`/app/channels/${channel.id}`);
  }, [navigate, channel.id]);

  return (
    <Item
      role="button"
      tabIndex={0}
      data-active={isActive ? '' : undefined}
      aria-current={isActive ? 'page' : undefined}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClick();
        }
      }}
      size="sm"
      className={cn(
        'cursor-pointer rounded-md px-2 py-1 text-sidebar-foreground',
        'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
        isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
        className,
      )}
    >
      <ItemMedia variant="default" className="opacity-70">
        {channel.isPrivate ? (
          <Lock aria-hidden="true" className="size-4" />
        ) : (
          <span aria-hidden="true" className="font-medium">
            #
          </span>
        )}
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="block w-full truncate">{channel.name}</ItemTitle>
      </ItemContent>
      {typeof channel.unreadCount === 'number' && channel.unreadCount > 0 ? (
        <Badge variant="default" className="ml-auto">
          {channel.unreadCount}
        </Badge>
      ) : null}
    </Item>
  );
}
