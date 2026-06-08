/**
 * Thread — the DIRECT-LINK thread page mounted at `/app/threads/:messageId` and
 * code-split through the router's `lazy(() => import('@/pages/Thread'))`.
 * Reproduces the right-hand thread panel from the reference screenshot
 * (Slack web Jul 2024 29): replies open in a panel anchored to the right edge
 * of the workspace shell.
 *
 * This page renders ONLY for a direct navigation to a thread URL (one with no
 * `state.background`). When a thread is opened from within the workspace the
 * router instead matches the originating channel/DM behind a shell-level
 * overlay (see `router.tsx` → `ThreadOverlay`), and this page does not mount.
 *
 * The page is a thin wrapper around {@link ThreadPanel} — a shadcn `Sheet`
 * rendered with `side="right"`. It performs no data fetching and holds no state
 * of its own: ThreadPanel fetches the parent message and its replies, joins the
 * thread's Socket.io room, and renders the parent message, the reply list, and
 * the reply composer.
 *
 * Routing behavior:
 *  - The parent message id is read from the `:messageId` route segment with
 *    {@link useParams}. When the segment is absent the page redirects to the
 *    authenticated workspace root (`/app`).
 *  - Closing navigates to the `/app` workspace root (a safe in-app fallback that
 *    resolves to the user's first channel), never `navigate(-1)` — a direct
 *    deep-link has no prior history entry to pop back to.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { Navigate, useNavigate, useParams } from 'react-router';

import { ThreadPanel } from '@/components/messages/ThreadPanel';

/**
 * Thread page — see the module docblock for the full behavioral contract.
 */
export default function Thread() {
  const { messageId } = useParams<{ messageId: string }>();
  const navigate = useNavigate();

  if (messageId === undefined) {
    return <Navigate to="/app" replace />;
  }

  return (
    <ThreadPanel
      open
      parentMessageId={messageId}
      onClose={() => void navigate('/app', { replace: true })}
    />
  );
}
