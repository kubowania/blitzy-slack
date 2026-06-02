import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { ChannelList } from '@/components/channels/ChannelList';
import { DmList } from '@/components/dms/DmList';
import { InvitePeople } from '@/components/invite/InvitePeople';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/**
 * Second column of the authenticated three-column app shell — the aubergine
 * workspace sidebar shown in screenshots 29 and 100, sitting between the
 * far-left workspace nav rail and the content column.
 *
 * It stacks, top to bottom: a fixed-height workspace-name header band (the
 * bold "Blitzy Slack" title with a disclosure chevron, mirroring the
 * "SLMobbin ▾" header in screenshots 29/100); a scrollable navigation region
 * containing the {@link ChannelList} (public + private channels the user
 * belongs to) above the {@link DmList} (the user's direct-message
 * conversations), divided by a {@link Separator}; and a pinned footer with the
 * invite action. The lists are wrapped in a {@link ScrollArea} so an
 * overflowing sidebar scrolls vertically while the header band and footer stay
 * fixed. The lists own all data fetching, section headings, and interactive
 * rows; this component contributes the sidebar surface, the workspace header
 * band, and the "Workspace navigation" landmark.
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
      {/* Workspace-name header band — the bold workspace title + disclosure
          chevron at the top of the sidebar (screenshots 29/100). Rendered as a
          non-heading band so it does not compete with the content column's
          `<h1>` channel title for the document's primary heading. */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-sidebar-border/60 px-4">
        <span className="truncate text-base font-bold tracking-tight text-sidebar-foreground">
          Blitzy Slack
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-sidebar-foreground/70" />
      </div>

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

      {/* Pinned footer action: invite people to the workspace (opens the
          email-entry dialog and, on submit, the "Invitation sent" modal). */}
      <div className="shrink-0 border-t border-sidebar-border/60 p-2">
        <InvitePeople className="h-11 text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground" />
      </div>
    </aside>
  );
}
