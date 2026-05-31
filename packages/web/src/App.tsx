/**
 * App — the view-tree root of the Blitzy Slack web client (`@app/web`).
 *
 * Rendered once by `src/main.tsx` inside the bootstrap provider stack
 * (`StrictMode` > `QueryClientProvider` > `BrowserRouter` > `App`). The
 * application-wide providers — the single TanStack Query client and the
 * `BrowserRouter` history context — are owned by `src/main.tsx`, not by App.
 *
 * App composes the view tree and the single global overlay surface:
 *
 *   - {@link AuthBootstrap} — validates a persisted session once on mount.
 *   - {@link Router} (`./router`) — the full client-side route tree.
 *   - {@link Toaster} (the shadcn wrapper at `@/components/ui/sonner`) — the
 *     single global toast surface; mounting it once here keeps it reachable from
 *     every route and stable across navigation.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { Toaster } from '@/components/ui/sonner';
import { useMe } from '@/hooks/useAuth';

import { Router } from './router';

/**
 * Renders nothing; its sole job is to mount {@link useMe} exactly once so a
 * session restored from `localStorage` is re-verified against `GET /api/auth/me`
 * on app load. A still-valid token refreshes the stored identity; an expired or
 * invalid token yields a 401 that the shared `api-client` interceptor turns into
 * a full `performLogout()`, clearing the auth store so the route guards redirect
 * to `/login`. Sits inside the `QueryClientProvider` (owned by `src/main.tsx`)
 * because `useMe` is a TanStack Query hook.
 */
function AuthBootstrap(): null {
  useMe();
  return null;
}

/**
 * Application view-tree root — see the module docblock for the full composition
 * contract. Takes no props.
 */
export function App() {
  return (
    <>
      <AuthBootstrap />
      <Router />
      <Toaster position="top-right" richColors closeButton />
    </>
  );
}
