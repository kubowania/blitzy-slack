/**
 * TypingIndicator — the subtle "Alice is typing…" line rendered immediately
 * above the message composer for the active channel or DM (AAP §0.5.4 typing
 * indicator gap inventory; Rule 1 screenshot parity).
 *
 * Behaviour:
 *   1. Subscribes to scope-bound typing events through {@link useTyping}
 *      (channelId OR dmId). The hook owns the socket lifecycle, throttling and
 *      remote-user expiry; this component only consumes the `typingUsers` list.
 *   2. Filters the local user out of that list so the indicator never reports
 *      "you are typing" back to yourself (Slack UX parity).
 *   3. Resolves the remaining user ids to display names via the optional
 *      `resolveDisplayName` callback, falling back to "Someone" when the caller
 *      cannot name a user.
 *   4. Formats the names with English natural-language rules (1 / 2 / 3 / 4+).
 *   5. Renders three staggered pulsing dots alongside the sentence.
 *
 * Real-time data reaches this component exclusively through the `useTyping`
 * hook (Rule 2 — no direct Socket.io access here). When no other user is
 * typing the component renders nothing. Design rationale for this component is
 * recorded in /docs/decision-log.md, not in these comments.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';
import { useTyping } from '@/hooks/useTyping';
import { useAuth } from '@/hooks/useAuth';

/**
 * Props for {@link TypingIndicator}.
 *
 * Provide EXACTLY ONE of `channelId` or `dmId` to scope the subscription;
 * this mirrors the {@link useTyping} contract.
 */
export interface TypingIndicatorProps {
  /** Channel scope. Mutually exclusive with `dmId`. */
  channelId?: string;
  /** DM scope. Mutually exclusive with `channelId`. */
  dmId?: string;
  /**
   * Optional resolver that maps a userId to a display name.
   * Caller typically derives this from channel.members or DM.participants.
   * Returns `undefined` if the user is not known to the caller.
   */
  resolveDisplayName?: (userId: string) => string | undefined;
  /** Forwarded className. */
  className?: string;
}

/**
 * Renders the live typing indicator for the scoped channel/DM, or `null` when
 * no other user is currently typing.
 */
export function TypingIndicator({
  channelId,
  dmId,
  resolveDisplayName,
  className,
}: TypingIndicatorProps): React.JSX.Element | null {
  // Scope-bound subscription. useTyping handles both subscription and filtering by scope.
  const { typingUsers } = useTyping({ channelId, dmId });
  const { user: currentUser } = useAuth();

  // Filter out current user.
  const otherUserIds = React.useMemo(() => {
    if (currentUser === null) {
      return typingUsers;
    }
    return typingUsers.filter((id) => id !== currentUser.id);
  }, [typingUsers, currentUser]);

  if (otherUserIds.length === 0) {
    return null;
  }

  // Resolve display names with fallback.
  const names = otherUserIds.map((id) => {
    if (resolveDisplayName !== undefined) {
      const resolved = resolveDisplayName(id);
      if (resolved !== undefined && resolved.length > 0) {
        return resolved;
      }
    }
    return 'Someone';
  });

  const sentence = formatTypingSentence(names);

  return (
    <div
      data-slot="typing-indicator"
      className={cn(
        'flex items-center gap-1 px-4 py-1 h-5',
        'text-xs italic text-muted-foreground',
        className,
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span>{sentence}</span>
      <TypingDots />
    </div>
  );
}

/**
 * Formats a list of display names into a natural-language "… is/are typing"
 * sentence. Beyond three typists the names collapse to a generic phrase to
 * keep the indicator compact (Slack parity).
 */
function formatTypingSentence(names: readonly string[]): string {
  switch (names.length) {
    case 0:
      // Defensive — caller filters length 0 above.
      return '';
    case 1:
      return `${names[0]} is typing`;
    case 2:
      return `${names[0]} and ${names[1]} are typing`;
    case 3:
      return `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
    default:
      return 'Several people are typing';
  }
}

/**
 * Three pulsing dots with staggered animation delays. Decorative only — hidden
 * from assistive technology since the adjacent sentence already announces the
 * typing state via the `role="status"` live region.
 */
function TypingDots(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <span className="size-1 rounded-full bg-current animate-pulse [animation-delay:0ms]" />
      <span className="size-1 rounded-full bg-current animate-pulse [animation-delay:200ms]" />
      <span className="size-1 rounded-full bg-current animate-pulse [animation-delay:400ms]" />
    </span>
  );
}
