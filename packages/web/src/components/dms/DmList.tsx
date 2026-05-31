import * as React from 'react';
import { useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';

import { DmListItem } from '@/components/dms/DmListItem';
import { StartDmDialog } from '@/components/dms/StartDmDialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/useAuth';
import { useSocketEvent } from '@/hooks/useSocket';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';

import type { DMWithParticipants } from '@app/shared/types/dm';

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
 * - Fetches DMs via TanStack Query against `GET /api/dms`.
 * - Renders one DmListItem per DM with corner-positioned presence dots.
 * - Hosts the StartDmDialog modal, triggered by the "+" button.
 * - Invalidates the DM list cache on socket events that may create a new DM
 *   visible to the current user (new message in a DM the user participates in).
 *
 * Visual reference: screenshots/Slack web Jul 2024 100.png (sidebar DM
 * section, immediately below Channels).
 */
export function DmList(): React.JSX.Element {
  const { user } = useAuth();
  const token = useAuthStore((state) => state.token);
  const location = useLocation();
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = React.useState(false);

  const dmsQuery = useQuery<DMWithParticipants[], Error>({
    queryKey: ['dms'],
    queryFn: () => apiClient.get<DMWithParticipants[]>('/api/dms'),
    enabled: token !== null,
    staleTime: 30_000,
  });

  const invalidateDms = React.useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['dms'] });
  }, [queryClient]);

  useSocketEvent('message:new', invalidateDms);

  const activeDmId = activeDmIdFrom(location.pathname);
  const dms = dmsQuery.data ?? [];
  const isLoading = dmsQuery.isLoading && token !== null;
  const isEmpty = !isLoading && dms.length === 0;
  const currentUserId = user?.id ?? '';

  const handleOpenDialog = React.useCallback((): void => {
    setIsDialogOpen(true);
  }, []);

  return (
    <section
      data-slot="dm-list"
      aria-label="Direct messages"
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

      <StartDmDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
    </section>
  );
}

function DmListSkeletonRow(): React.JSX.Element {
  return (
    <div
      data-slot="dm-list-skeleton-row"
      className="flex items-center gap-2 px-2 py-1.5"
    >
      <Skeleton className="size-7 rounded-full" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}
