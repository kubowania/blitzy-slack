/**
 * Client-side routing surface for the Blitzy Slack web client (`@app/web`).
 *
 * Exports the named {@link Router} component, which declares the application's
 * entire `<Routes>` tree. The `BrowserRouter` provider is mounted in
 * `./main.tsx` (above `<App />`); this module contributes only the route
 * declarations and the authentication guards that gate them.
 *
 * Route map (AAP §0.6.3):
 *
 *   /                       Landing        — public marketing page
 *   /login                  Login          — public email/password sign-in
 *   /register               Register       — public registration
 *   /app                    AppShell       — protected three-column shell
 *     index                 Workspace      — data-driven landing (first channel
 *                                            redirect, or welcome state)
 *     channels/:channelId   Channel        — channel message timeline
 *     dms/:dmId             DirectMessage  — 1:1 direct-message timeline
 *     threads/:messageId    Thread         — direct-link thread panel
 *     search                SearchResults  — search results
 *   *                       → /            — catch-all redirect
 *
 * Pages are code-split through `React.lazy`, so each route ships as its own JS
 * chunk; a single `<Suspense>` boundary renders the fallback while a chunk
 * loads. The three public routes are wrapped in {@link RedirectIfAuthenticated}
 * and the `/app` subtree in {@link RequireAuth}. The nested routes render
 * through the `<Outlet />` hosted by {@link AppShell}, so the workspace chrome
 * (nav rail + sidebar + header) persists across navigation.
 *
 * Thread overlay: a thread opened from within the workspace navigates to
 * `/app/threads/:messageId` carrying the originating channel/DM `Location` in
 * `state.background`. The main `<Routes>` then match against that background so
 * the channel/DM stays mounted, and {@link ThreadOverlay} renders the
 * {@link ThreadPanel} Sheet on top — a shell-level route overlay driven by the
 * real URL. Closing returns to the background channel/DM. A direct deep-link
 * (no `background`) instead renders the {@link Thread} page, which closes to a
 * safe `/app` fallback. Neither path uses `navigate(-1)`.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
  type Location,
} from 'react-router';

import { Spinner } from '@/components/ui/spinner';
import { useAuthStore } from '@/stores/auth.store';

const Landing = lazy(() => import('@/pages/Landing'));
const Register = lazy(() => import('@/pages/Register'));
const Login = lazy(() => import('@/pages/Login'));
const Workspace = lazy(() => import('@/pages/Workspace'));
const Channel = lazy(() => import('@/pages/Channel'));
const DirectMessage = lazy(() => import('@/pages/DirectMessage'));
const Thread = lazy(() => import('@/pages/Thread'));
const SearchResults = lazy(() => import('@/pages/SearchResults'));

// AppShell is the `/app` layout route element (the three-column chrome that
// hosts the nested-route `<Outlet />`). It is a NAMED export, so the lazy
// import is adapted to the default-export shape `React.lazy` expects.
const AppShell = lazy(() =>
  import('@/components/layout/AppShell').then((m) => ({ default: m.AppShell })),
);

// ThreadPanel is the shadcn Sheet used by both the {@link ThreadOverlay} (the
// in-workspace overlay) and the {@link Thread} deep-link page. Lazy-loaded as a
// NAMED export so the messaging subtree stays out of the initial chunk.
const ThreadPanel = lazy(() =>
  import('@/components/messages/ThreadPanel').then((m) => ({ default: m.ThreadPanel })),
);

/** Full-viewport centered spinner used as a route-level loading splash. */
function RouteLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

/**
 * Guards a protected route subtree. Gates on a fully authenticated session
 * (both `token` AND `user` present), not merely the presence of a token:
 *
 *   - No `token` → redirect to `/login`, preserving the requested location in
 *     `state.from` for post-login redirect-back.
 *   - `token` present but `user` not yet resolved → render a brief
 *     auth-validation splash. This is the window where a session restored from
 *     `localStorage` is being re-verified by `useMe` (mounted in {@link App});
 *     `useMe` either populates `user` (valid token) or triggers `performLogout`
 *     on a 401 (stale token), after which this guard redirects to `/login`.
 *   - Both present → render the protected subtree.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  if (token === null) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user === null) {
    return <RouteLoading />;
  }

  return <>{children}</>;
}

/**
 * Guards a public-only route. Renders {@link children} only when no auth token
 * is present; a signed-in visitor is redirected to the workspace at `/app`.
 */
function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);

  if (token !== null) {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}

/**
 * Reads the optional background {@link Location} carried in `state.background`.
 * Present only when a thread was opened from within the workspace; `undefined`
 * for every other navigation (including direct deep-links to a thread URL).
 */
function useBackgroundLocation(): Location | undefined {
  const location = useLocation();
  const state = location.state as { background?: Location } | null;
  return state?.background;
}

/**
 * Shell-level thread overlay. Renders the {@link ThreadPanel} Sheet on top of
 * the workspace chrome when the REAL URL matches `/app/threads/:messageId`,
 * while the main `<Routes>` continue to render the `background` channel/DM
 * behind it. Closing navigates back to that background location (never
 * `navigate(-1)`), so the user returns to the exact conversation the thread was
 * opened from. Rendered only when a `background` location is present; direct
 * deep-links are handled by the {@link Thread} page instead.
 */
function ThreadOverlay({ background }: { background: Location }): ReactNode {
  const match = useMatch('/app/threads/:messageId');
  const navigate = useNavigate();
  const messageId = match?.params.messageId;

  if (messageId === undefined) {
    return null;
  }

  const handleClose = (): void => {
    void navigate(`${background.pathname}${background.search}`);
  };

  return <ThreadPanel open parentMessageId={messageId} onClose={handleClose} />;
}

/**
 * Declares the application's full route tree. Rendered by {@link App} inside the
 * `BrowserRouter` it mounts.
 */
export function Router() {
  const location = useLocation();
  const background = useBackgroundLocation();

  return (
    <>
      <Suspense fallback={<RouteLoading />}>
        {/* When a thread is open over a channel/DM, match the main tree against
            the background location so the underlying conversation stays mounted
            behind the thread Sheet; otherwise match the live location. */}
        <Routes location={background ?? location}>
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

          {/* Authenticated workspace shell with nested routes. The shell itself
              is the layout route element; the index renders the data-driven
              Workspace landing into the shell's <Outlet />. */}
          <Route
            path="/app"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Workspace />} />
            <Route path="channels/:channelId" element={<Channel />} />
            <Route path="dms/:dmId" element={<DirectMessage />} />
            <Route path="threads/:messageId" element={<Thread />} />
            <Route path="search" element={<SearchResults />} />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>

      {/* Shell-level thread overlay. Rendered only when a thread was opened from
          within the workspace (a `background` location is present); its own
          Suspense keeps the conversation behind it visible while the panel's
          chunk resolves. */}
      {background !== undefined ? (
        <Suspense fallback={null}>
          <ThreadOverlay background={background} />
        </Suspense>
      ) : null}
    </>
  );
}
