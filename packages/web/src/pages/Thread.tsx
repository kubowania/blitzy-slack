/**
 * Thread — the threaded-replies page mounted at `/app/threads/:messageId` and
 * code-split through the router's `lazy(() => import('@/pages/Thread'))`.
 * Reproduces the right-hand thread panel from the reference screenshot
 * (Slack web Jul 2024 29): replies open in a panel anchored to the right edge
 * of the workspace shell.
 *
 * The page is a thin routing wrapper around {@link ThreadPanel} — a shadcn
 * `Sheet` rendered with `side="right"`. It performs no data fetching and holds
 * no state of its own: ThreadPanel fetches the parent message and its replies,
 * subscribes to the thread's Socket.io room, and renders the parent message,
 * the reply list, and the reply composer.
 *
 * Routing behavior:
 *  - The parent message id is read from the `:messageId` route segment with
 *    {@link useParams}. When the segment is absent (a direct navigation that
 *    bypassed the route pattern), the page redirects to the authenticated
 *    workspace root (`/app`) instead of rendering an unparameterised panel.
 *  - The panel stays open for the entire lifetime of the route; closing it
 *    calls {@link useNavigate}`(-1)`, popping back to the underlying channel or
 *    DM so the user returns to the context the thread was opened from.
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
    <ThreadPanel open parentMessageId={messageId} onClose={() => void navigate(-1)} />
  );
}
