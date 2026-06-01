import * as React from 'react';
import { Outlet } from 'react-router';

import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { WorkspaceNavRail } from '@/components/layout/WorkspaceNavRail';
import { useInitPresence } from '@/hooks/usePresence';
import { useConnectSocket } from '@/hooks/useSocket';
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
 * The three-column structure is a desktop-only layout (the reference Slack web
 * screenshots are desktop captures); a `min-w-[768px]` guard preserves those
 * desktop proportions on narrower viewports, so the page scrolls horizontally
 * below 768px instead of compressing the columns into an unusable width.
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

  return (
    <div
      className={cn(
        'flex h-screen min-w-[768px] overflow-hidden bg-background text-foreground',
        className,
      )}
      {...props}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      <WorkspaceNavRail />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
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
