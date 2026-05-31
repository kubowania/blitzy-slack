/**
 * Direct-message conversation page, rendered at `/app/dms/:dmId` and code-split
 * through the router's `lazy(() => import('@/pages/DirectMessage'))`. Reproduces
 * the 1:1 conversation view derived from the reference screenshot (Slack web Jul
 * 2024 100): a stacked layout of a compact participant header, the scrollable
 * message timeline, the typing indicator, and the message composer.
 *
 * The active conversation is resolved from {@link useDms} — the same `['dms']`
 * TanStack Query cache the sidebar's {@link DmList} reads, so the already-loaded
 * list is reused — by the `:dmId` route segment read with {@link useParams}. The
 * page renders one of four states:
 *  - No `:dmId` segment → redirects to the workspace root (`/app`).
 *  - DM list loading with no cached match yet → {@link Skeleton} placeholders in
 *    the header.
 *  - Loading settled with no matching conversation → an {@link Empty} not-found
 *    state; the timeline and composer are NOT mounted for an invalid or
 *    inaccessible `:dmId`.
 *  - Conversation resolved → a header naming the other participant (with their
 *    presence dot) above a {@link MessageList} timeline, with
 *    {@link TypingIndicator} and {@link MessageComposer} pinned to the bottom.
 *
 * On mount (and on socket reconnect) the page subscribes its live socket to the
 * `dm:<dmId>` broadcast room via the typed `dm:join` event so a DM started
 * mid-session receives real-time updates without a reconnect (Rule 2). The
 * socket is intentionally not unsubscribed on unmount; that trade-off is
 * recorded in /docs/decision-log.md.
 */
import * as React from 'react';
import { Navigate, useParams } from 'react-router';

import { MessageComposer } from '@/components/messages/MessageComposer';
import { MessageList } from '@/components/messages/MessageList';
import { TypingIndicator } from '@/components/messages/TypingIndicator';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useDms } from '@/hooks/useDms';
import { useSocket } from '@/hooks/useSocket';
import { useAuthStore } from '@/stores/auth.store';

import type { DMWithParticipants } from '@app/shared/types/dm';
import type { PublicUser } from '@app/shared/types/user';

/**
 * Derives up-to-two-letter initials from a display name for the avatar text
 * fallback: the first letter of a single-word name, or the first letters of the
 * first and last whitespace-separated words. Returns `?` for a blank name.
 */
function initialsFor(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    return '?';
  }
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? '';
  if (parts.length === 1) {
    return first.charAt(0).toUpperCase();
  }
  const last = parts[parts.length - 1] ?? '';
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/**
 * Identifies the OTHER participant of a 1:1 DM by filtering out the current
 * user. Falls back to the first participant when the current user id is not yet
 * known (the brief auth-bootstrap window) or no non-self participant is found.
 */
function otherParticipantOf(
  dm: DMWithParticipants,
  currentUserId: string | null,
): PublicUser | undefined {
  if (currentUserId === null) {
    return dm.participants[0];
  }
  return dm.participants.find((p) => p.id !== currentUserId) ?? dm.participants[0];
}

/**
 * The direct-message conversation page. See the module docblock for the full
 * behavioral contract.
 */
export default function DirectMessage() {
  const { dmId } = useParams<{ dmId: string }>();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { dms, isLoading } = useDms();
  const { emit, isConnected } = useSocket();

  // Subscribe the live socket to this DM's room. Connection-time auto-join only
  // covers DMs that existed when the socket connected, so a DM started
  // mid-session is subscribed here. dm:join is fire-and-forget and re-fires on
  // reconnect (isConnected dep). The socket is not unsubscribed on unmount, by
  // design — see docs/decision-log.md.
  React.useEffect(() => {
    if (dmId === undefined || !isConnected) {
      return;
    }
    emit('dm:join', dmId);
  }, [dmId, isConnected, emit]);

  if (dmId === undefined) {
    return <Navigate to="/app" replace />;
  }

  const dm = dms.find((d) => d.id === dmId);
  const other = dm ? otherParticipantOf(dm, currentUserId) : undefined;

  if (isLoading && dm === undefined) {
    return (
      <div className="flex h-full flex-col bg-background">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </header>
        <div className="flex flex-1 flex-col justify-end gap-2 px-6 py-4">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-12 w-1/2" />
        </div>
      </div>
    );
  }

  if (dm === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyTitle>Conversation not found</EmptyTitle>
            <EmptyDescription>
              This direct message doesn’t exist or you don’t have access to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const headerName = other?.displayName ?? 'Direct Message';

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
        <div className="relative">
          <Avatar className="size-8">
            {other?.avatarUrl ? (
              <AvatarImage src={other.avatarUrl} alt={other.displayName} />
            ) : null}
            <AvatarFallback>{initialsFor(other?.displayName ?? 'User')}</AvatarFallback>
          </Avatar>
          {other ? (
            <PresenceIndicator
              userId={other.id}
              size="sm"
              className="absolute right-0 bottom-0 ring-background"
            />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-base font-semibold text-foreground">{headerName}</h1>
          <p className="truncate text-xs text-muted-foreground">Direct message</p>
        </div>
      </header>

      <MessageList dmId={dmId} className="flex-1 min-h-0" />
      <TypingIndicator dmId={dmId} className="shrink-0 px-6" />
      <MessageComposer
        dmId={dmId}
        scopeName={other?.displayName ?? 'this conversation'}
        hideTypingIndicator
        className="shrink-0"
      />
    </div>
  );
}
