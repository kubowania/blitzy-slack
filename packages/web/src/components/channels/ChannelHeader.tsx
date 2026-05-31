import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, MoreVertical } from 'lucide-react';
import { toast } from 'sonner';

import type { ChannelSummary } from '@app/shared/types/channel';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Props for {@link ChannelHeader}.
 */
export interface ChannelHeaderProps {
  /** Channel summary (id, name, public/private flag) used to render the header. */
  channel: ChannelSummary;
  /** Optional className passthrough merged onto the root `<header>` element. */
  className?: string;
}

/**
 * Top bar of a channel view, rendered above the message timeline by the
 * channel page.
 *
 * Layout (left to right):
 *  - A `#` text prefix for public channels, or a {@link Lock} icon for private
 *    channels, followed by the channel name as the page's primary `<h1>`.
 *  - An overflow ("kebab") menu on the trailing edge.
 *
 * The overflow {@link DropdownMenu} exposes a destructive "Leave channel"
 * action. Selecting it opens a controlled confirmation {@link Dialog}; on
 * confirmation the component POSTs `/api/channels/:id/leave` through
 * {@link apiClient}. On success it invalidates the cached `['channels']` list
 * so the sidebar refetches, shows a confirmation toast, closes the dialog, and
 * navigates to the workspace landing route. On failure it surfaces the error
 * message via a toast.
 *
 * Both icons and the `#` glyph are marked `aria-hidden`; a visually hidden
 * `sr-only` span announces the channel's public/private state to assistive
 * technology.
 */
export function ChannelHeader({ channel, className }: ChannelHeaderProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = React.useState<boolean>(false);

  const leaveChannelMutation = useMutation<void, Error, string>({
    mutationFn: async (channelId) => {
      await apiClient.post<void>(`/api/channels/${encodeURIComponent(channelId)}/leave`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success(`You left #${channel.name}`);
      setIsLeaveDialogOpen(false);
      void navigate('/app');
    },
    onError: (err) => {
      toast.error(err.message.length > 0 ? err.message : 'Failed to leave channel');
    },
  });

  const handleLeaveConfirm = (): void => {
    leaveChannelMutation.mutate(channel.id);
  };

  const isLeaving = leaveChannelMutation.isPending;

  return (
    <header
      className={cn(
        'flex items-center justify-between gap-4 border-b border-border bg-background px-4 py-3',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {channel.isPrivate ? (
            <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <span aria-hidden="true" className="text-base font-semibold text-muted-foreground">
              #
            </span>
          )}
          <h1 className="truncate text-base font-semibold text-foreground">{channel.name}</h1>
          <span className="sr-only">
            {channel.isPrivate ? 'private channel' : 'public channel'}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Channel options">
              <MoreVertical aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                setIsLeaveDialogOpen(true);
              }}
            >
              Leave channel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={isLeaveDialogOpen} onOpenChange={setIsLeaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave #{channel.name}?</DialogTitle>
            <DialogDescription>
              You won’t receive any new messages from this channel. You can rejoin later if it’s a
              public channel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setIsLeaveDialogOpen(false);
              }}
              disabled={isLeaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleLeaveConfirm}
              disabled={isLeaving}
            >
              {isLeaving ? 'Leaving…' : 'Leave channel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
