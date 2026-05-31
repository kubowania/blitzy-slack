/**
 * Browser entry point for the Blitzy Slack web client (`@app/web`).
 *
 * This module is intentionally MINIMAL: it imports the global stylesheet,
 * resolves the `#root` mount node declared in `index.html`, and renders
 * {@link App} inside React's `StrictMode`. Every application-wide provider
 * (the TanStack Query client, the React Router `BrowserRouter`, the persisted-
 * session bootstrap, and the toast host) is owned by {@link App} — keeping this
 * entry file limited to `createRoot` / `StrictMode` so the provider tree lives
 * in one testable component rather than being split across the entry and App.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element "#root" was not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
