import * as React from 'react';
import { Outlet, useLocation } from 'react-router';

import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { WorkspaceNavRail } from '@/components/layout/WorkspaceNavRail';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useHydratePresence, useInitPresence } from '@/hooks/usePresence';
import { useConnectSocket } from '@/hooks/useSocket';
import { useDms } from '@/hooks/useDms';
import { cn } from '@/lib/utils';

/**
 * Top-level layout shell for the authenticated routes of the Blitzy Slack web
 * client — the three-column structure shown in screenshots 29 and 100.
 *
 * Left to right it composes three full-height columns:
 *   1. {@link WorkspaceNavRail} — the far-left vertical icon rail (`w-16`).
 *   2. {@link Sidebar} — the Channels / Direct Messages navigation column
 *      (`w-64`).
 *   3. a content column (`flex-1`) that stacks the {@link Header} above a
 *      semantic `<main>` landmark; React Router's {@link Outlet} renders the
 *      matched nested route there (Channel, DirectMessage, Thread,
 *      SearchResults).
 *
 * `h-screen` plus a cascading `overflow-hidden` pin the shell to the viewport;
 * only the inner scroll regions (the sidebar lists, the message timeline)
 * scroll. `min-w-0` on the content column lets long unbroken content (such as a
 * URL in a message) shrink instead of widening the layout past the viewport.
 *
 * The layout is responsive. At the `md` breakpoint and wider the nav rail and
 * sidebar are docked as the first two columns. Below `md` they are removed from
 * the flow and instead presented in an off-canvas `Sheet` drawer opened from a
 * hamburger button in the {@link Header}; the content column then fills the full
 * viewport width, so there is no horizontal overflow on phone-width screens. The
 * drawer closes automatically on navigation (a route change collapses it).
 * Rationale: /docs/decision-log.md.
 *
 * A visually-hidden "Skip to main content" link is the first focusable element,
 * letting keyboard and screen-reader users jump past the nav rail and sidebar
 * straight to the `<main>` landmark (`id="main-content"`, `tabIndex={-1}`).
 *
 * The right-hand thread Sheet is NOT rendered here: it is a shell-level route
 * overlay owned by `router.tsx` (`ThreadOverlay`), which keeps the underlying
 * channel/DM mounted in this shell's `<Outlet />` behind the panel.
 *
 * The shell is the single mount point for two app-wide lifecycle hooks that
 * belong only in an authenticated context: {@link useConnectSocket} drives the
 * Socket.io connection lifecycle and {@link useInitPresence} emits presence
 * heartbeats and subscribes to `presence:update` broadcasts.
 *
 * Standard `<div>` attributes (including `className`) are forwarded to the outer
 * container so a consumer can extend layout. Rationale for the design choices in
 * this file is recorded in /docs/decision-log.md, not in these comments.
 */
export function AppShell({ className, ...props }: React.ComponentProps<'div'>) {
  useConnectSocket();
  useInitPresence();

  // Mobile navigation drawer state. The docked nav rail + sidebar are hidden
  // below the `md` breakpoint; this drawer surfaces the same chrome on phones.
  const [mobileNavOpen, setMobileNavOpen] = React.useState<boolean>(false);
  const location = useLocation();
  // Collapse the drawer on navigation so tapping a channel/DM closes it.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Hydrate presence for everyone shown in the sidebar's Direct Messages list
  // so their dots reflect the authoritative Redis-computed state on first paint
  // (AAP §0.6.2) instead of defaulting to offline until a transition broadcast
  // arrives. De-duplicated by the order-independent id set inside the hook.
  const { dms } = useDms();
  const dmParticipantIds = React.useMemo<string[]>(() => {
    const ids = new Set<string>();
    for (const dm of dms) {
      for (const participant of dm.participants) {
        ids.add(participant.id);
      }
    }
    return [...ids];
  }, [dms]);
  useHydratePresence(dmParticipantIds);

  return (
    <div
      className={cn('flex h-screen overflow-hidden bg-background text-foreground', className)}
      {...props}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      {/* Docked chrome — visible at `md` and wider; hidden on phones where it is
          replaced by the off-canvas drawer below. */}
      <WorkspaceNavRail className="hidden md:flex" />
      <Sidebar className="hidden md:flex" />

      {/* Off-canvas navigation drawer for phone-width viewports. Mounts the same
          nav rail + sidebar side by side; the content is only in the DOM while
          open (Radix unmounts the portal on close). */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-80 max-w-[85vw] flex-row gap-0 p-0 md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Workspace channels and direct messages
          </SheetDescription>
          <WorkspaceNavRail />
          <Sidebar className="flex-1" />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-hidden bg-background outline-none"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
