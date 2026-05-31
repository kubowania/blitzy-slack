/**
 * Workspace — the authenticated workspace shell mounted at the `/app` route and
 * code-split through the router's `lazy(() => import('@/pages/Workspace'))`.
 * Reproduces the three-column main workspace from the reference screenshot
 * (Slack web Jul 2024 29): the far-left workspace nav rail, the Channels /
 * Direct Messages sidebar, and the content column that stacks the global header
 * above the active channel, DM, thread, or search view.
 *
 * The route is wrapped in `RequireAuth` in the router, so this component renders
 * only for an authenticated session and performs no auth checks of its own. It
 * is a thin route boundary around {@link AppShell}, which owns the entire
 * authenticated experience: the three-column layout, the Socket.io connection
 * lifecycle, the presence heartbeat and subscription, the global header, and the
 * nested routing that renders the active channel, direct-message, thread, or
 * search view.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { AppShell } from '@/components/layout/AppShell';

/**
 * The authenticated workspace shell page — see the module docblock for the full
 * behavioral contract.
 */
export default function Workspace() {
  return <AppShell />;
}
