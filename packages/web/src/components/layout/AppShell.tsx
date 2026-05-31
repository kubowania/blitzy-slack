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
      className={cn('flex h-screen overflow-hidden bg-background text-foreground', className)}
      {...props}
    >
      <WorkspaceNavRail />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-hidden bg-background">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
