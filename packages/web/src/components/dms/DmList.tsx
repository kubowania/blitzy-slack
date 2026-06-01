import * as React from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';

import { DmListItem } from '@/components/dms/DmListItem';
import { StartDmDialog } from '@/components/dms/StartDmDialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/useAuth';
import { useDms, DMS_QUERY_KEY } from '@/hooks/useDms';
import { useSocketEvent } from '@/hooks/useSocket';
import { cn } from '@/lib/utils';

import type { MessageWithAuthor } from '@app/shared/types/message';

const DM_ROUTE_PATTERN = /^\/app\/dms\/([^/]+)/;

/**
 * Extracts the DM id segment from the current route, or returns `null` if the
 * route is not a DM route.
 */
function activeDmIdFrom(pathname: string): string | null {
  const match = DM_ROUTE_PATTERN.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * Sidebar section that lists the current user's direct message conversations.
 *
 * - Fetches DMs via the shared {@link useDms} hook (`GET /api/dms`).
 * - Renders one DmListItem per DM with corner-positioned presence dots.
 * - Hosts the StartDmDialog modal, triggered by the "+" button.
 * - Refreshes the DM list on a `message:new` socket event ONLY when the message
 *   belongs to a direct message (`dmId !== null`) — channel/thread traffic does
 *   not invalidate the DM list.
 *
 * Visual reference: screenshots/Slack web Jul 2024 100.png (sidebar DM
 * section, immediately below Channels).
 */
export function DmList(): React.JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  // Ref to the "+" trigger so the dialog can restore focus to it on close.
  const dmTriggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Read side: the shared `useDms` hook owns the `['dms']` query + auth gating.
  const { dms, isLoading } = useDms();

  // Write side: only a NEW message that belongs to a DIRECT MESSAGE can change
  // the DM list (e.g. the first message of a freshly-started DM bumps it into
  // view). Channel and thread messages carry `dmId === null`, so invalidating
  // on every `message:new` would refetch the DM list for unrelated traffic.
  // Filtering on `dmId !== null` scopes the refetch to relevant events.
  const handleMessageNew = React.useCallback(
    (message: MessageWithAuthor): void => {
      if (message.dmId !== null) {
        void queryClient.invalidateQueries({ queryKey: DMS_QUERY_KEY });
      }
    },
    [queryClient],
  );

  useSocketEvent('message:new', handleMessageNew);

  const activeDmId = activeDmIdFrom(location.pathname);
  const isEmpty = !isLoading && dms.length === 0;
  const currentUserId = user?.id ?? '';

  const handleOpenDialog = React.useCallback((): void => {
    setIsDialogOpen(true);
  }, []);

  return (
    <section
      data-slot="dm-list"
      aria-label="Direct messages"
      aria-busy={isLoading}
      className="flex flex-col gap-1 px-2 py-2"
    >
      <header className="flex items-center justify-between px-2">
        <h2
          className={cn(
            'text-xs font-semibold uppercase tracking-wide',
            'text-sidebar-foreground/70',
          )}
        >
          Direct Messages
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={dmTriggerRef}
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-sidebar-foreground/70 hover:text-sidebar-foreground"
              aria-label="Start a direct message"
              onClick={handleOpenDialog}
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Start a direct message</TooltipContent>
        </Tooltip>
      </header>

      <div className="flex flex-col gap-0.5">
        {isLoading ? (
          <>
            {/* Visually-hidden live status so assistive tech announces the
                loading state the skeleton rows convey visually (the skeletons
                themselves are decorative). Paired with `aria-busy` on the
                section above. */}
            <span role="status" className="sr-only">
              Loading direct messages…
            </span>
            <DmListSkeletonRow />
            <DmListSkeletonRow />
            <DmListSkeletonRow />
          </>
        ) : null}

        {isEmpty ? (
          <Empty className="border-0 px-2 py-3">
            <EmptyTitle className="text-sm">No direct messages</EmptyTitle>
            <EmptyDescription className="text-xs">
              Start a DM to chat with teammates.
            </EmptyDescription>
          </Empty>
        ) : null}

        {!isLoading && dms.length > 0
          ? dms.map((dm) => (
              <DmListItem
                key={dm.id}
                dm={dm}
                currentUserId={currentUserId}
                isActive={dm.id === activeDmId}
              />
            ))
          : null}
      </div>

      <StartDmDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        triggerRef={dmTriggerRef}
      />
    </section>
  );
}

function DmListSkeletonRow(): React.JSX.Element {
  return (
    <div data-slot="dm-list-skeleton-row" className="flex items-center gap-2 px-2 py-1.5">
      <Skeleton className="size-7 rounded-full" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}
