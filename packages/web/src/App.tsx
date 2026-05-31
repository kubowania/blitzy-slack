/**
 * App — the view-tree root of the Blitzy Slack web client (`@app/web`).
 *
 * Rendered by `src/main.tsx` inside the bootstrap provider tree
 * (`StrictMode` → `QueryClientProvider` → `BrowserRouter`). This component
 * contributes the application's view tree together with the global UI overlays
 * that are not bound to any single route:
 *
 *   - {@link Router} (`./router`) declares the full client-side route tree —
 *     Landing, Login, Register, and the authenticated `/app` workspace shell
 *     with its nested Channel / DirectMessage / Thread / SearchResults routes.
 *   - The Sonner `<Toaster />` is the global rendering surface for toast
 *     notifications (file-upload progress, error feedback, disconnect banners,
 *     success confirmations) emitted via `toast()` from anywhere in the tree.
 *
 * The `<Toaster />` is a sibling of {@link Router}, not a descendant: Sonner
 * renders it as a single fixed-position overlay region and `toast()` dispatches
 * to it through a module-level observer, so mounting it exactly once here at the
 * app root makes it reachable from every route and keeps it stable across route
 * changes. Bootstrap providers (`StrictMode`, `BrowserRouter`,
 * `QueryClientProvider`) live in `main.tsx` and the route declarations live in
 * `router.tsx`; this file owns only the view tree and the global overlays.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { Toaster } from 'sonner';

import { Router } from './router';

/**
 * Application top-level view component — see the module docblock for the full
 * composition contract. Renders the route tree alongside the global toast
 * overlay and takes no props.
 */
export function App() {
  return (
    <>
      <Router />
      <Toaster position="top-right" richColors closeButton />
    </>
  );
}
