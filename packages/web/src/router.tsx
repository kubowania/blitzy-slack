/**
 * Client-side routing surface for the Blitzy Slack web client (`@app/web`).
 *
 * Exports the named {@link Router} component, which declares the application's
 * entire `<Routes>` tree. The `BrowserRouter` provider is mounted separately in
 * `src/main.tsx`; this module contributes only the route declarations and the
 * authentication guards that gate them.
 *
 * Route map (AAP §0.6.3):
 *
 *   /                       Landing        — public marketing page
 *   /login                  Login          — public email/password sign-in
 *   /register               Register       — public registration
 *   /app                    Workspace      — protected three-column shell
 *     index                 → channels/general (default channel redirect)
 *     channels/:channelId   Channel        — channel message timeline
 *     dms/:dmId             DirectMessage  — 1:1 direct-message timeline
 *     threads/:messageId    Thread         — right-anchored Sheet overlay
 *     search                SearchResults  — search results
 *   *                       → /            — catch-all redirect
 *
 * Every page is code-split through `React.lazy`, so each route ships as its own
 * JS chunk and the initial bundle stays small; a single `<Suspense>` boundary
 * renders the fallback while a chunk loads. The three public routes are wrapped
 * in {@link RedirectIfAuthenticated} so a signed-in visitor is bounced to
 * `/app`, and the `/app` subtree is wrapped in {@link RequireAuth} so an
 * unauthenticated visitor is redirected to `/login` with the originally
 * requested location preserved in history state for post-login redirect-back.
 * The nested routes render through the `<Outlet />` hosted by `Workspace`, so
 * the workspace chrome (nav rail + sidebar + header) persists across
 * navigation between channels, DMs, threads, and search.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { useAuthStore } from '@/stores/auth.store';

const Landing = lazy(() => import('@/pages/Landing'));
const Register = lazy(() => import('@/pages/Register'));
const Login = lazy(() => import('@/pages/Login'));
const Workspace = lazy(() => import('@/pages/Workspace'));
const Channel = lazy(() => import('@/pages/Channel'));
const DirectMessage = lazy(() => import('@/pages/DirectMessage'));
const Thread = lazy(() => import('@/pages/Thread'));
const SearchResults = lazy(() => import('@/pages/SearchResults'));

/**
 * Guards a protected route subtree. Renders {@link children} only when an auth
 * token is present; otherwise redirects to `/login`, preserving the current
 * location in `state.from` so the login flow can return the user to the page
 * they originally requested. Reads only the `token` slice of the auth store so
 * it re-renders solely on authentication changes.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

/**
 * Guards a public-only route. Renders {@link children} only when no auth token
 * is present; a signed-in visitor is redirected to the workspace at `/app`.
 */
function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);

  if (token) {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}

/**
 * Declares the application's full route tree. Rendered by `App.tsx` inside the
 * `BrowserRouter` that `src/main.tsx` mounts.
 */
export function Router() {
  return (
    <Suspense fallback={null}>
      <Routes>
        {/* Public routes */}
        <Route
          path="/"
          element={
            <RedirectIfAuthenticated>
              <Landing />
            </RedirectIfAuthenticated>
          }
        />
        <Route
          path="/login"
          element={
            <RedirectIfAuthenticated>
              <Login />
            </RedirectIfAuthenticated>
          }
        />
        <Route
          path="/register"
          element={
            <RedirectIfAuthenticated>
              <Register />
            </RedirectIfAuthenticated>
          }
        />

        {/* Authenticated workspace shell with nested routes */}
        <Route
          path="/app"
          element={
            <RequireAuth>
              <Workspace />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="channels/general" replace />} />
          <Route path="channels/:channelId" element={<Channel />} />
          <Route path="dms/:dmId" element={<DirectMessage />} />
          <Route path="threads/:messageId" element={<Thread />} />
          <Route path="search" element={<SearchResults />} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
