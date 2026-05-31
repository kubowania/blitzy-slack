import * as React from 'react';
import { Link } from 'react-router';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator';
import { cn } from '@/lib/utils';

import type { DMWithParticipants } from '@app/shared/types/dm';
import type { PublicUser } from '@app/shared/types/user';

export interface DmListItemProps {
  dm: DMWithParticipants;
  currentUserId: string;
  isActive?: boolean;
  className?: string;
}

/**
 * Computes the avatar fallback initials from the other participant's display
 * name (e.g., 'Alice Smith' -> 'AS', 'Bob' -> 'B'). Used when the user has
 * not set an avatar image.
 */
function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') {
    return '?';
  }
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Selects the OTHER participant from a DM (the participant whose id does NOT
 * match the current user). Falls back to the first participant if no match is
 * found (defensive — should not occur for a well-formed 1:1 DM).
 */
function otherParticipantOf(
  dm: DMWithParticipants,
  currentUserId: string,
): PublicUser | undefined {
  return (
    dm.participants.find((participant) => participant.id !== currentUserId) ??
    dm.participants[0]
  );
}

/**
 * Single entry in the sidebar's "Direct Messages" section. Renders the OTHER
 * participant's avatar (with a corner-positioned presence indicator) and
 * displayName, navigating to `/app/dms/:dmId` on click.
 *
 * Visual reference: screenshots/Slack web Jul 2024 100.png (DM row in the
 * sidebar list).
 */
export function DmListItem({
  dm,
  currentUserId,
  isActive = false,
  className,
}: DmListItemProps): React.JSX.Element {
  const other = otherParticipantOf(dm, currentUserId);
  const displayName = other?.displayName ?? 'Unknown user';
  const avatarUrl = other?.avatarUrl ?? null;
  const otherId = other?.id ?? '';

  return (
    <Item
      asChild
      data-slot="dm-list-item"
      data-active={isActive ? 'true' : 'false'}
      size="sm"
      className={cn(
        'rounded-md text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
        isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
        className,
      )}
    >
      <Link to={`/app/dms/${dm.id}`} aria-label={`Open direct message with ${displayName}`}>
        <ItemMedia>
          <div className="relative">
            <Avatar className="size-7">
              {avatarUrl !== null ? (
                <AvatarImage src={avatarUrl} alt={displayName} />
              ) : null}
              <AvatarFallback>{initialsFor(displayName)}</AvatarFallback>
            </Avatar>
            {otherId !== '' ? (
              <PresenceIndicator
                userId={otherId}
                size="sm"
                className="absolute right-0 bottom-0"
              />
            ) : null}
          </div>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{displayName}</ItemTitle>
        </ItemContent>
      </Link>
    </Item>
  );
}
