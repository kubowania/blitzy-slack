import * as React from 'react';
import { Plus } from 'lucide-react';

import { ChannelListItem } from './ChannelListItem';
import { CreateChannelDialog } from './CreateChannelDialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannels } from '@/hooks/useChannels';
import { cn } from '@/lib/utils';

/**
 * Props for {@link ChannelList}.
 */
export interface ChannelListProps {
  /** Optional className passthrough for the root `<section>` container. */
  className?: string;
}

/**
 * The "Channels" section of the workspace sidebar.
 *
 * Renders the section heading with an icon-only "+" trigger that opens the
 * {@link CreateChannelDialog}, followed by the current user's channels (sourced
 * from {@link useChannels}) as a list of {@link ChannelListItem} rows. Shows
 * skeleton placeholders while the initial fetch is in flight, an empty state
 * when the user has no channels, and an inline message on fetch failure. The
 * {@link CreateChannelDialog} stays mounted and is toggled by local state.
 */
export function ChannelList({ className }: ChannelListProps): React.JSX.Element {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = React.useState<boolean>(false);
  const { channels, isLoading, error } = useChannels();

  const showEmpty = !isLoading && error === null && channels.length === 0;
  const showList = !isLoading && error === null && channels.length > 0;

  return (
    <section aria-label="Channels" className={cn('flex flex-col gap-1 py-2', className)}>
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/70">
          Channels
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Create channel"
          className="size-6 text-sidebar-foreground hover:bg-sidebar-accent/50"
          onClick={() => {
            setIsCreateDialogOpen(true);
          }}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {isLoading ? (
        <div role="status" aria-label="Loading channels" className="flex flex-col gap-1 px-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7 w-full bg-sidebar-accent/30" />
          ))}
        </div>
      ) : null}

      {error !== null ? (
        <div className="px-2 py-2 text-xs text-destructive">
          Failed to load channels. {error.message}
        </div>
      ) : null}

      {showEmpty ? (
        <Empty className="border-none px-2 py-4 text-sidebar-foreground">
          <EmptyHeader>
            <EmptyTitle className="text-sm font-medium">No channels yet</EmptyTitle>
            <EmptyDescription className="text-xs text-sidebar-foreground/70">
              Create your first channel to get started.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {showList ? (
        <ul className="flex flex-col gap-0.5 px-2">
          {channels.map((channel) => (
            <li key={channel.id}>
              <ChannelListItem
                channel={{
                  id: channel.id,
                  name: channel.name,
                  isPrivate: channel.isPrivate,
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <CreateChannelDialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen} />
    </section>
  );
}
