import * as React from 'react';
import { SmilePlus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { apiClient, type ApiError } from '@/lib/api-client';
import { EmojiPicker } from './EmojiPicker';
import type { ReactionSummary } from '@app/shared/types/message';

/**
 * Props for {@link ReactionPicker}.
 */
export interface ReactionPickerProps {
  /** The message this picker adds reactions to. */
  messageId: string;
  /**
   * Visual variant. `chip` mimics the inline reaction-chip placeholder shown at
   * the end of a message's reaction row; `icon` is a hover-toolbar icon button.
   * Defaults to `chip`.
   */
  variant?: 'chip' | 'icon';
  /** Optional className applied to the trigger button. */
  className?: string;
}

/**
 * ReactionPicker — the "Add reaction" trigger that opens the {@link EmojiPicker}
 * popover so a user can attach a NEW emoji reaction to a message.
 *
 * It renders the faint smiley+plus affordance ([+ 😀]) seen in the reference UI:
 *  - `chip` (default): a pill-shaped button sized to sit inline at the end of a
 *    message's existing reaction-chip row.
 *  - `icon`: a ghost icon button (with an "Add reaction" tooltip) intended for
 *    the per-message hover toolbar.
 *
 * Selecting an emoji issues `POST /api/messages/:id/reactions { emoji }`. The
 * server persists the reaction and broadcasts a `reaction:added` Socket.io
 * event; the `useMessages` cache subscriber applies that event so the message's
 * reaction chips re-render in real time. This component owns ONLY the HTTP
 * trigger — it performs no optimistic cache mutation of its own.
 */
export function ReactionPicker({
  messageId,
  variant = 'chip',
  className,
}: ReactionPickerProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState<boolean>(false);

  // POST /api/messages/:id/reactions. Generics: <success, error, variables> —
  // the variable is the selected emoji (string), the success payload is the
  // server-computed aggregated ReactionSummary, errors surface as ApiError.
  const mutation = useMutation<ReactionSummary, ApiError, string>({
    mutationFn: async (emoji: string) => {
      return apiClient.post<ReactionSummary>(`/api/messages/${messageId}/reactions`, { emoji });
    },
    onError: (error: ApiError) => {
      toast.error('Failed to add reaction', {
        description: error.message,
      });
    },
    onSettled: () => {
      // Passive invalidation — useMessages refreshes on next focus, and the
      // real-time `reaction:added` socket event updates the chips instantly.
      void queryClient.invalidateQueries({
        queryKey: ['messages'],
        exact: false,
        refetchType: 'none',
      });
    },
  });

  const handleSelect = React.useCallback(
    (emoji: string) => {
      mutation.mutate(emoji);
      setOpen(false);
    },
    [mutation],
  );

  // The icon variant composes a Radix Tooltip together with the EmojiPicker's
  // Popover onto a single Button. EmojiPicker renders the supplied trigger inside
  // `<PopoverTrigger asChild>`, so the Tooltip provider wraps the EmojiPicker and
  // the Button is wrapped in `<TooltipTrigger asChild>`. The resulting
  // `PopoverTrigger asChild` -> `TooltipTrigger asChild` -> Button chain forwards
  // both triggers' props (open-toggle and hover hint) to the same button, while
  // `TooltipContent` is a sibling of the EmojiPicker within the same Tooltip.
  if (variant === 'icon') {
    return (
      <Tooltip>
        <EmojiPicker
          trigger={
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn('size-7', className)}
                disabled={mutation.isPending}
                aria-label="Add reaction"
                data-slot="reaction-picker-trigger"
              >
                <SmilePlus className="size-4" />
              </Button>
            </TooltipTrigger>
          }
          onSelect={handleSelect}
          open={open}
          onOpenChange={setOpen}
          align="start"
          side="top"
        />
        <TooltipContent>Add reaction</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <EmojiPicker
      trigger={
        <button
          type="button"
          disabled={mutation.isPending}
          aria-label="Add reaction"
          data-slot="reaction-picker-trigger"
          className={cn(
            'rounded-full px-2 py-0.5 text-xs h-6',
            'inline-flex items-center gap-1',
            'border border-transparent bg-muted/50 text-muted-foreground',
            'hover:bg-muted hover:text-foreground transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mutation.isPending && 'opacity-60 cursor-wait',
            className,
          )}
        >
          <SmilePlus className="size-3.5" />
          <span aria-hidden="true">+</span>
        </button>
      }
      onSelect={handleSelect}
      open={open}
      onOpenChange={setOpen}
      align="start"
      side="top"
    />
  );
}
