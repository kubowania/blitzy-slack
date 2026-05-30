import * as React from 'react';

import type { PresenceState } from '@app/shared/types/presence';

import { usePresence } from '@/hooks/usePresence';
import { cn } from '@/lib/utils';

const STATE_COLOR_CLASSES: Record<PresenceState, string> = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  offline: 'bg-gray-400',
};

const STATE_LABELS: Record<PresenceState, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-2',
  md: 'size-2.5',
  lg: 'size-3',
};

export interface PresenceIndicatorProps extends React.ComponentProps<'span'> {
  /** The ID of the user whose presence to display. */
  userId: string;
  /**
   * Visual size of the dot.
   * - `sm` = 8 px (compact rows, message author avatars)
   * - `md` = 10 px (default — standard sidebar/DM list rows)
   * - `lg` = 12 px (profile / larger avatars)
   */
  size?: 'sm' | 'md' | 'lg';
}

export function PresenceIndicator({
  userId,
  size = 'md',
  className,
  ...props
}: PresenceIndicatorProps) {
  const state = usePresence(userId);

  return (
    <span
      data-slot="presence-indicator"
      data-state={state}
      role="status"
      aria-label={STATE_LABELS[state]}
      className={cn(
        'inline-block rounded-full ring-2 ring-background',
        SIZE_CLASSES[size],
        STATE_COLOR_CLASSES[state],
        className,
      )}
      {...props}
    />
  );
}
