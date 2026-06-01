import * as React from 'react';
import { useLocation, useNavigate } from 'react-router';
import { MessageCircle } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { FilePreview } from '@/components/files/FilePreview';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator';
import { ReactionChip } from './ReactionChip';
import { ReactionPicker } from './ReactionPicker';
import { cn } from '@/lib/utils';

import type { MessageWithAuthor } from '@app/shared/types/message';

/**
 * Props for {@link MessageItem}.
 */
export interface MessageItemProps {
  /** The hydrated message to render (author, reactions, reply count, file). */
  message: MessageWithAuthor;
  /**
   * When `true`, suppresses the reply-in-thread button and the reply count
   * link. Used inside the ThreadPanel where threading is not recursive.
   */
  hideThreadActions?: boolean;
  /**
   * When `true`, this message is being rendered as a reply inside ThreadPanel.
   * Surfaced as the `data-thread-reply` attribute for downstream styling and
   * E2E selectors (no extra indentation in the PoC).
   */
  isThreadReply?: boolean;
  /** Forwarded className applied to the outer container. */
  className?: string;
}

/**
 * Renders the three timestamp representations used by the message header:
 *
 * - `display`  — the compact inline time ("11:04 AM") shown beside the author.
 * - `full`     — the fully localized absolute date ("Tuesday, July 23rd,
 *                2024 11:04 AM") shown on the first line of the hover tooltip.
 * - `relative` — the human-friendly distance ("about 2 hours ago") shown on
 *                the second line of the hover tooltip.
 */
function formatTimestamp(iso: string): {
  display: string;
  full: string;
  relative: string;
} {
  const date = new Date(iso);
  const display = format(date, 'h:mm a');
  const full = format(date, 'PPPP p');
  const relative = formatDistanceToNow(date, { addSuffix: true });
  return { display, full, relative };
}

/**
 * Derives avatar fallback initials from a display name, defensively handling
 * empty, whitespace-only, single-word, and multi-word inputs (e.g.
 * "Alice Smith" -> "AS", "Bob" -> "B", "" -> "?"). Written to satisfy the
 * `noUncheckedIndexedAccess` compiler option (array element access is
 * `string | undefined`).
 */
function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') {
    return '?';
  }
  const first = parts[0]?.charAt(0) ?? '';
  const last =
    parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * MessageItem — a single message row in a channel or DM timeline.
 *
 * Renders the author avatar (with a corner presence dot), the author display
 * name, an inline timestamp (with an absolute + relative tooltip), the message
 * body, an optional file-attachment preview, the aggregated reactions row, a
 * persistent thread reply-count link, and a hover-only action toolbar
 * (add-reaction + reply-in-thread).
 *
 * Messages are immutable in the PoC (AAP §0.7.2): no edit/delete affordances
 * are rendered. Visual reference: screenshots/Slack web Jul 2024 100.png.
 */
export function MessageItem({
  message,
  hideThreadActions = false,
  isThreadReply = false,
  className,
}: MessageItemProps): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { display, full, relative } = formatTimestamp(message.createdAt);

  // `void` discards the (possibly Promise) return of React Router 7's
  // `navigate`, satisfying the no-floating-promises lint rule. The current
  // channel/DM location is passed as `state.background` so the router renders
  // the thread as a Sheet over this conversation rather than replacing it.
  const handleOpenThread = React.useCallback(() => {
    void navigate(`/app/threads/${message.id}`, { state: { background: location } });
  }, [navigate, location, message.id]);

  const hasReactions = message.reactions.length > 0;
  const hasReplies = !hideThreadActions && message.replyCount > 0;
  const replyNoun = message.replyCount === 1 ? 'reply' : 'replies';

  return (
    <article
      id={`message-${message.id}`}
      data-slot="message-item"
      data-message-id={message.id}
      data-thread-reply={isThreadReply ? 'true' : 'false'}
      className={cn(
        // `min-w-0` lets this row shrink below its intrinsic content width;
        // long-string wrapping is enforced by `wrap-anywhere` on the body text
        // below. Together they keep a long unbroken URL inside the ScrollArea
        // viewport instead of widening the Radix scroll wrapper.
        'group relative flex min-w-0 gap-3 px-4 py-1.5',
        'transition-colors hover:bg-muted/50',
        className,
      )}
    >
      {/* Author avatar with corner presence dot */}
      <div className="relative shrink-0">
        <Avatar className="size-9">
          {message.author.avatarUrl !== null ? (
            <AvatarImage
              src={message.author.avatarUrl}
              alt={message.author.displayName}
            />
          ) : null}
          <AvatarFallback>
            {getInitials(message.author.displayName)}
          </AvatarFallback>
        </Avatar>
        <PresenceIndicator
          userId={message.author.id}
          className="absolute right-0 bottom-0"
        />
      </div>

      {/* Message body column */}
      <div className="min-w-0 flex-1">
        {/* Header: author name + inline timestamp */}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold text-foreground">
            {message.author.displayName}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <time
                dateTime={message.createdAt}
                className="cursor-default text-xs text-muted-foreground hover:underline"
              >
                {display}
              </time>
            </TooltipTrigger>
            <TooltipContent>
              <span className="block">{full}</span>
              <span className="block text-primary-foreground/70">
                {relative}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Message body (plain text; newlines preserved via `whitespace-pre-wrap`).
            `wrap-anywhere` (overflow-wrap: anywhere) breaks a long unbroken
            string/URL AND shrinks the element's intrinsic min-content width, so
            the Radix ScrollArea `display:table` wrapper stays at the viewport
            width instead of growing to the unbroken string. Rationale:
            /docs/decision-log.md. */}
        <div className="whitespace-pre-wrap wrap-anywhere text-sm text-foreground">
          {message.content}
        </div>

        {/* File attachment preview */}
        {message.file !== null ? (
          <div className="mt-2">
            <FilePreview file={message.file} />
          </div>
        ) : null}

        {/* Reactions row with an inline add-reaction trigger */}
        {hasReactions ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {message.reactions.map((reaction) => (
              <ReactionChip
                key={reaction.emoji}
                messageId={message.id}
                reaction={reaction}
              />
            ))}
            <ReactionPicker messageId={message.id} variant="chip" />
          </div>
        ) : null}

        {/* Persistent thread reply-count link */}
        {hasReplies ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenThread}
            className={cn(
              'mt-1 h-auto w-fit gap-1.5 px-2 py-1 text-xs font-medium has-[>svg]:px-2',
              'border border-transparent text-primary',
              'hover:border-border hover:bg-background hover:text-primary',
            )}
            aria-label={`${message.replyCount} ${replyNoun} — open thread`}
          >
            <MessageCircle className="size-3.5" />
            <span>
              {message.replyCount} {replyNoun}
            </span>
          </Button>
        ) : null}
      </div>

      {/* Action toolbar revealed on hover OR keyboard focus within the message
          (group-focus-within), so keyboard users get an equivalent reveal. */}
      <div
        className={cn(
          'absolute -top-3 right-4 z-10',
          'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
          'pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto',
          'flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-md',
        )}
        role="toolbar"
        aria-label="Message actions"
      >
        <ReactionPicker messageId={message.id} variant="icon" />
        {!hideThreadActions ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleOpenThread}
                aria-label="Reply in thread"
              >
                <MessageCircle className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reply in thread</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </article>
  );
}
