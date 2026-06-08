/**
 * Browser entry point for the Blitzy Slack web client (`@app/web`).
 *
 * Referenced by `index.html` via `<script type="module" src="/src/main.tsx">`.
 * Bootstraps the React 19 application: it constructs the singleton TanStack
 * Query client, loads the global stylesheet, resolves the `#root` mount node
 * declared in `index.html`, and mounts {@link App} inside the application-wide
 * provider stack `StrictMode` > `QueryClientProvider` > `BrowserRouter` >
 * `App`. `App` itself owns the view tree (the route declarations in `router.tsx`
 * and the global Sonner toast overlay); this entry owns only bootstrap and the
 * providers every route-level component depends on.
 *
 * Per the Explainability rule (AAP §0.8.3), design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element "#root" was not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
