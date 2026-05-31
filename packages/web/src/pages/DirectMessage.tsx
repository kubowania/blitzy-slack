/**
 * Direct-message conversation page, rendered at `/app/dms/:dmId` and code-split
 * through the router's `lazy(() => import('@/pages/DirectMessage'))`. Reproduces
 * the 1:1 conversation view derived from the reference screenshot (Slack web Jul
 * 2024 100): a stacked layout of a compact participant header, the scrollable
 * message timeline, the typing indicator, and the message composer.
 *
 * The active conversation is resolved from the shared `['dms']` TanStack Query
 * cache — the same key {@link DmList} populates, so the sidebar's already-loaded
 * data is reused — by the `:dmId` route segment read with {@link useParams}. The
 * page renders one of three states:
 *  - No `:dmId` segment → redirects to the workspace root (`/app`).
 *  - DM list loading on a cold load with no cached match yet → {@link Skeleton}
 *    placeholders in the header.
 *  - Settled → a header naming the other participant (with their presence dot)
 *    above a {@link MessageList} timeline, with {@link TypingIndicator} and
 *    {@link MessageComposer} pinned to the bottom, all scoped to `dmId`.
 *
 * Real-time message, typing, and presence updates arrive through the child
 * components' own hooks (Rule 2 — Socket.io fan-out, never polling); this page
 * emits no socket events itself. Design rationale for this page is recorded in
 * /docs/decision-log.md, not in these comments.
 */
import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';

import { MessageComposer } from '@/components/messages/MessageComposer';
import { MessageList } from '@/components/messages/MessageList';
import { TypingIndicator } from '@/components/messages/TypingIndicator';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api-client';
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
  const token = useAuthStore((s) => s.token);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const { data, isLoading } = useQuery<DMWithParticipants[], Error>({
    queryKey: ['dms'],
    queryFn: () => apiClient.get<DMWithParticipants[]>('/api/dms'),
    enabled: token !== null,
    staleTime: 30_000,
  });

  if (dmId === undefined) {
    return <Navigate to="/app" replace />;
  }

  const dm = (data ?? []).find((d) => d.id === dmId);
  const other = dm ? otherParticipantOf(dm, currentUserId) : undefined;
  const headerName = other?.displayName ?? 'Direct Message';

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
        {isLoading ? (
          <>
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </>
        ) : (
          <>
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
          </>
        )}
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
