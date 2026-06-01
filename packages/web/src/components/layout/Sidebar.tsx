import * as React from 'react';

import { ChannelList } from '@/components/channels/ChannelList';
import { DmList } from '@/components/dms/DmList';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/**
 * Second column of the authenticated three-column app shell — the aubergine
 * workspace sidebar shown in screenshots 29 and 100, sitting between the
 * far-left workspace nav rail and the content column.
 *
 * It is a pure layout container: a fixed-width (`w-64`) full-height `<aside>`
 * that stacks the {@link ChannelList} (public + private channels the user
 * belongs to) above the {@link DmList} (the user's direct-message
 * conversations), divided by a {@link Separator}. Both lists are wrapped in a
 * {@link ScrollArea} so an overflowing sidebar scrolls vertically while the
 * surrounding shell stays fixed. The lists own all data fetching, section
 * headings, and interactive rows; this component contributes only the sidebar
 * surface and the "Workspace navigation" landmark.
 *
 * Standard `<aside>` attributes (including `className`) are forwarded so the app
 * shell can compose layout; the sidebar supplies its own aubergine palette via
 * the `sidebar-*` design tokens.
 */
export function Sidebar({ className, ...props }: React.ComponentProps<'aside'>) {
  return (
    <aside
      className={cn(
        'flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar-bg text-sidebar-foreground',
        className,
      )}
      {...props}
    >
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <nav
          className="flex w-full min-w-0 flex-col gap-2 px-2 py-4"
          aria-label="Workspace navigation"
        >
          <ChannelList />
          <Separator className="my-2 bg-sidebar-border/60" />
          <DmList />
        </nav>
      </ScrollArea>
    </aside>
  );
}
