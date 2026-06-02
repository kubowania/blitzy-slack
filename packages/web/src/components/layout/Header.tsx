import * as React from 'react';
import { useParams } from 'react-router';
import { Hash, Lock, Menu } from 'lucide-react';

import { SearchBar } from '@/components/search/SearchBar';
import { Button } from '@/components/ui/button';
import { useChannels } from '@/hooks/useChannels';
import { cn } from '@/lib/utils';

/**
 * Route params the header reads to resolve its left-slot title. React Router 7
 * exposes each field as `string | undefined` depending on which authenticated
 * route is active (`/app/channels/:channelId`, `/app/dms/:dmId`,
 * `/app/threads/:messageId`).
 */
interface HeaderRouteParams extends Record<string, string | undefined> {
  channelId?: string;
  dmId?: string;
  messageId?: string;
}

/**
 * Props for {@link Header}. Extends the native `<header>` attributes with an
 * optional callback the app shell passes to open the mobile navigation drawer.
 */
export interface HeaderProps extends React.ComponentProps<'header'> {
  /** Opens the off-canvas navigation drawer; rendered as a hamburger below `md`. */
  onOpenMobileNav?: () => void;
}

/**
 * Top bar of the authenticated content column — the first row of the right-most
 * column in the three-column app shell.
 *
 * Renders three slots left-to-right:
 * - Left: the current route context. A channel route shows a `Hash` (public) or
 *   `Lock` (private) glyph followed by the channel name resolved from
 *   {@link useChannels}; DM and thread routes show a static title; every other
 *   route falls back to the product name.
 * - Center: the shared {@link SearchBar}, the single search entry point.
 * - Right: an empty flex spacer that mirrors the left slot's width so the
 *   centered search bar stays horizontally centered. (Help and member-list
 *   surfaces are out of scope for this proof-of-concept, so no controls are
 *   rendered here.)
 *
 * Standard `<header>` attributes (including `className`) are forwarded so a
 * consumer can override layout; the app shell renders it without extra props.
 */
export function Header({ className, onOpenMobileNav, ...props }: HeaderProps) {
  const params = useParams<HeaderRouteParams>();
  const { channels } = useChannels();

  const activeChannel = params.channelId
    ? channels.find((c) => c.id === params.channelId)
    : undefined;

  const isDmRoute = Boolean(params.dmId);
  const isThreadRoute = Boolean(params.messageId);

  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-4 border-b border-border bg-background px-4',
        className,
      )}
      {...props}
    >
      {/* Mobile-only hamburger that opens the navigation drawer. Hidden at `md`
          and wider where the nav rail + sidebar are docked. Sized to a 44px tap
          target for touch (A11Y-001). */}
      {onOpenMobileNav ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="size-11 shrink-0 md:hidden"
        >
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      ) : null}

      {/* Left: route context (channel name / DM name / thread title). */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {activeChannel ? (
          <>
            {activeChannel.isPrivate ? (
              <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <h1 className="truncate text-base font-semibold text-foreground">
              {activeChannel.name}
            </h1>
          </>
        ) : isDmRoute ? (
          <h1 className="truncate text-base font-semibold text-foreground">Direct Message</h1>
        ) : isThreadRoute ? (
          <h1 className="truncate text-base font-semibold text-foreground">Thread</h1>
        ) : (
          <h1 className="truncate text-base font-semibold text-foreground">Blitzy Slack</h1>
        )}
      </div>

      {/* Center: shared search input. */}
      <div className="flex max-w-xl flex-1 justify-center">
        <SearchBar />
      </div>

      {/* Right: empty spacer mirroring the left slot's flex-1 width so the
          centered search bar stays horizontally centered. */}
      <div className="flex-1" aria-hidden="true" />
    </header>
  );
}
