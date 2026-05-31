/**
 * App — the provider-tree root and view-tree root of the Blitzy Slack web
 * client (`@app/web`). Rendered once by `src/main.tsx` inside `StrictMode`.
 *
 * App owns every application-wide context and global overlay:
 *
 *   - {@link QueryClientProvider} with a single configured {@link QueryClient}
 *     (module-scoped so it is created exactly once and survives re-renders).
 *   - {@link BrowserRouter} — the History router provider that the route tree in
 *     {@link Router} declares its `<Routes>` against.
 *   - {@link AuthBootstrap} — validates a persisted session once on mount.
 *   - {@link Router} (`./router`) — the full client-side route tree.
 *   - {@link Toaster} (the shadcn wrapper at `@/components/ui/sonner`) — the
 *     single global toast surface; mounting it once here keeps it reachable from
 *     every route and stable across navigation.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

import { Toaster } from '@/components/ui/sonner';
import { useMe } from '@/hooks/useAuth';

import { Router } from './router';

/**
 * The application's single TanStack Query client. Created at module scope so it
 * is instantiated exactly once for the lifetime of the page (a client created
 * inside the component would be discarded and rebuilt on every re-render,
 * dropping the cache). Defaults tune the cache for this realtime app: a short
 * `staleTime` so list/timeline reads are reused across quick navigations, a
 * single retry to ride out a transient network blip without hammering the API,
 * and `refetchOnWindowFocus` disabled because Socket.io — not focus polling —
 * is the authoritative freshness mechanism (Rule 2).
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Renders nothing; its sole job is to mount {@link useMe} exactly once so a
 * session restored from `localStorage` is re-verified against `GET /api/auth/me`
 * on app load. A still-valid token refreshes the stored identity; an expired or
 * invalid token yields a 401 that the shared `api-client` interceptor turns into
 * a full `performLogout()`, clearing the auth store so the route guards redirect
 * to `/login`. Sits inside {@link QueryClientProvider} because `useMe` is a
 * TanStack Query hook.
 */
function AuthBootstrap(): null {
  useMe();
  return null;
}

/**
 * Application root — see the module docblock for the full composition contract.
 * Takes no props.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthBootstrap />
        <Router />
        <Toaster position="top-right" richColors closeButton />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
