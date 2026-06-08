import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ReactionSummary } from '@app/shared/types/message';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { apiClient, type ApiError } from '@/lib/api-client';

/**
 * Props for {@link ReactionChip}.
 */
export interface ReactionChipProps {
  /** The message this reaction belongs to. */
  messageId: string;
  /** The aggregated reaction summary (server-computed). */
  reaction: ReactionSummary;
  /**
   * Optional resolver mapping a reactor's user id to a display name. When
   * supplied (and at least one id resolves) the chip's tooltip names the
   * reactors ("Alice and Bob reacted with 👍", AAP §0.5.2); otherwise it falls
   * back to a count-based label.
   */
  resolveDisplayName?: (userId: string) => string | undefined;
  /** Optional className for the outer button element. */
  className?: string;
}

/**
 * Formats a list of reactor display names into a natural-language sentence
 * naming who reacted with the emoji — "Alice reacted with 👍", "Alice and Bob
 * reacted with 👍", "Alice, Bob, and Carol reacted with 👍", or "Alice, Bob,
 * and 3 others reacted with 👍" for four or more. Defensive `?? ''` guards
 * satisfy `noUncheckedIndexedAccess` (array element access is `string |
 * undefined`).
 */
function formatReactors(names: readonly string[], emoji: string): string {
  const verb = `reacted with ${emoji}`;
  if (names.length === 1) {
    return `${names[0] ?? ''} ${verb}`;
  }
  if (names.length === 2) {
    return `${names[0] ?? ''} and ${names[1] ?? ''} ${verb}`;
  }
  if (names.length === 3) {
    return `${names[0] ?? ''}, ${names[1] ?? ''}, and ${names[2] ?? ''} ${verb}`;
  }
  const remaining = names.length - 3;
  const others = remaining === 1 ? '1 other' : `${remaining} others`;
  return `${names[0] ?? ''}, ${names[1] ?? ''}, ${names[2] ?? ''}, and ${others} ${verb}`;
}

/**
 * A single emoji reaction rendered as a Slack-style pill chip (the
 * `[👏 1]` chips beneath a message in the reference UI).
 *
 * The chip shows the emoji and the live reactor count. Clicking it toggles
 * the current user's reaction on the message:
 *
 *  - When the current user has NOT reacted, the click sends
 *    `POST /api/messages/:id/reactions` with `{ emoji }` (add).
 *  - When the current user HAS reacted, the click sends
 *    `DELETE /api/messages/:id/reactions/:emoji` (remove) — the emoji is a
 *    URL-encoded path segment, not a query-string parameter.
 *
 * The HTTP round-trip runs through a TanStack Query `useMutation`. The chip
 * applies an OPTIMISTIC update on click so the active styling and the count
 * flip instantly, well within the message-delivery budget. The optimistic
 * value is local-only and is NOT written back to the query cache here: the
 * server broadcasts `reaction:added` / `reaction:removed` over Socket.io and
 * the `useMessages` cache subscriber rewrites the message's reaction summary.
 * That cache write arrives as a fresh `reaction` prop, at which point the
 * local optimistic flag is cleared so the render reads authoritative props.
 *
 * On a failed request the optimistic flag is rolled back; on settle it is
 * cleared and the `['messages']` query key is passively invalidated as a
 * safety net (no eager refetch).
 */
export function ReactionChip({
  messageId,
  reaction,
  resolveDisplayName,
  className,
}: ReactionChipProps): React.JSX.Element {
  const queryClient = useQueryClient();

  // Local optimistic state. `null` means "no pending optimistic toggle" — the
  // chip renders directly from the server-provided `reaction` prop. A boolean
  // means the user just clicked and we are showing the predicted state until
  // the socket-driven cache update reconciles it back to `null`.
  const [optimisticActive, setOptimisticActive] = React.useState<boolean | null>(null);

  // Effective `hasCurrentUser` after applying any optimistic toggle. `??`
  // falls back to the server value only when no optimistic toggle is pending
  // (`null`); an explicit optimistic `false` is preserved, not overridden.
  const isActive = optimisticActive ?? reaction.hasCurrentUser;

  // Effective reactor count after applying any optimistic toggle. The delta is
  // computed against the server's `hasCurrentUser` so repeated optimistic
  // renders never double-count.
  const optimisticCount =
    optimisticActive === null
      ? reaction.count
      : optimisticActive
        ? reaction.count + (reaction.hasCurrentUser ? 0 : 1)
        : reaction.count - (reaction.hasCurrentUser ? 1 : 0);

  const mutation = useMutation<void, ApiError, { add: boolean }>({
    mutationFn: async ({ add }) => {
      if (add) {
        await apiClient.post<ReactionSummary>(`/api/messages/${messageId}/reactions`, {
          emoji: reaction.emoji,
        });
      } else {
        // The emoji is a URL PATH segment (the canonical reaction-removal
        // contract), encoded with encodeURIComponent so multi-byte emoji are
        // safely percent-escaped within the path.
        await apiClient.del<void>(
          `/api/messages/${messageId}/reactions/${encodeURIComponent(reaction.emoji)}`,
        );
      }
    },
    onError: () => {
      // Roll back the optimistic toggle; the authoritative state will still
      // arrive via the socket-driven cache update if the server later succeeds.
      setOptimisticActive(null);
    },
    onSettled: () => {
      // Clear the optimistic flag so subsequent renders read from props (the
      // socket-driven cache write is the source of truth for the chip state).
      setOptimisticActive(null);
      // Passive safety net: mark the message lists stale without forcing an
      // immediate refetch — `useMessages` decides if/when to refetch.
      void queryClient.invalidateQueries({
        queryKey: ['messages'],
        exact: false,
        refetchType: 'none',
      });
    },
  });

  const handleClick = React.useCallback(() => {
    // Ignore clicks while a toggle is already in flight to avoid sending a
    // conflicting add/remove before the first request settles.
    if (mutation.isPending) {
      return;
    }
    const willBecomeActive = !isActive;
    // Apply the optimistic state synchronously before kicking off the request
    // so the UI updates on the same render as the click.
    setOptimisticActive(willBecomeActive);
    mutation.mutate({ add: willBecomeActive });
  }, [isActive, mutation]);

  // Resolve the reactor display names when a resolver is supplied. Empty when
  // none is provided (e.g. inside the thread panel) or when none resolve.
  const reactorNames = React.useMemo<string[]>(() => {
    if (resolveDisplayName === undefined) {
      return [];
    }
    const names: string[] = [];
    for (const userId of reaction.userIds) {
      const name = resolveDisplayName(userId);
      if (name !== undefined && name.length > 0) {
        names.push(name);
      }
    }
    return names;
  }, [resolveDisplayName, reaction.userIds]);

  // Hover / screen-reader label: name the reactors when resolvable, otherwise
  // fall back to the count-based pluralization.
  const countLabel =
    optimisticCount === 1
      ? `${reaction.emoji} reaction (1 person)`
      : `${reaction.emoji} reaction (${optimisticCount} people)`;
  const tooltipLabel =
    reactorNames.length > 0 ? formatReactors(reactorNames, reaction.emoji) : countLabel;

  return (
    // shadcn `Tooltip` (self-providing) hosts the reactor-name hint (AAP §0.5.2
    // maps hover hints to Tooltip). The chip itself is composed from the shadcn
    // `Button` primitive (variant="ghost") with pill classes so it inherits the
    // design-system focus-visible ring, transition, and disabled treatment.
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClick}
          disabled={mutation.isPending}
          aria-pressed={isActive}
          aria-label={tooltipLabel}
          data-slot="reaction-chip"
          data-active={isActive}
          className={cn(
            'h-6 gap-1 rounded-full border px-2 py-0.5 text-xs',
            isActive
              ? 'border-primary bg-primary/10 text-primary hover:bg-primary/15'
              : 'border-transparent bg-muted text-foreground hover:bg-muted/80',
            className,
          )}
        >
          {/* The emoji is decorative for assistive tech; the accessible name
              comes from `aria-label`, which names the reactors (or the count). */}
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="font-medium tabular-nums">{optimisticCount}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}
