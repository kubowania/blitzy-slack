/**
 * Workspace — the data-driven landing rendered at the `/app` index route, inside
 * the {@link AppShell} `<Outlet />`. Code-split through the router's
 * `lazy(() => import('@/pages/Workspace'))`.
 *
 * Resolves the authenticated user's channel list and decides where `/app`
 * should land:
 *   - while the list is loading → a centered spinner;
 *   - when at least one channel exists → a replace-redirect to the FIRST
 *     channel's database id (`channels/<id>`), so the default authenticated view
 *     is a real channel rather than a hardcoded name;
 *   - when the user belongs to no channels → a welcome/empty state inviting them
 *     to create or join a channel from the sidebar.
 *
 * The three-column chrome (nav rail, sidebar, header) is owned by
 * {@link AppShell}, the `/app` layout route element; this component only fills
 * the content region for the bare `/app` path.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { MessagesSquare } from 'lucide-react';
import { Navigate } from 'react-router';

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { useChannels } from '@/hooks/useChannels';

/**
 * The authenticated workspace landing — see the module docblock for the full
 * behavioral contract. Takes no props.
 */
export default function Workspace() {
  const { channels, isLoading } = useChannels();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const firstChannel = channels[0];
  if (firstChannel !== undefined) {
    return <Navigate to={`channels/${firstChannel.id}`} replace />;
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquare />
          </EmptyMedia>
          <EmptyTitle>Welcome to your workspace</EmptyTitle>
          <EmptyDescription>
            You&rsquo;re not in any channels yet. Create a channel or join an existing one from the
            sidebar to start the conversation.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
