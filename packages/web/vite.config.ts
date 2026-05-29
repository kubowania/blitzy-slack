/**
 * Vite 6 build and dev-server configuration for the Blitzy Slack web client (`@app/web`).
 *
 * Configures:
 *  - the plugin pipeline: React Fast Refresh + the automatic JSX runtime
 *    (`@vitejs/plugin-react`) followed by Tailwind CSS v4 processing
 *    (`@tailwindcss/vite`, which reads the `@theme` directives in src/index.css);
 *  - the `@` path alias, kept in lockstep with `tsconfig.json` `paths`
 *    (`"@/*": ["./src/*"]`) and the `components.json` aliases;
 *  - the dev server, the `vite preview` server, and the production build output.
 *
 * Rationale for the non-trivial choices made here (Tailwind via the Vite plugin,
 * fixed strict ports, the absence of a dev proxy, and the ES2022 build target)
 * is recorded in /docs/decision-log.md — the single source of truth for "why"
 * decisions per the project's Explainability rule.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ES modules do not expose `__dirname`; derive it from this file's URL so the
// `@` alias below resolves to an absolute filesystem path independent of the
// process working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // React plugin first, then the Tailwind CSS v4 plugin.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // `@/*` -> `<package>/src/*`; mirrors tsconfig.json `paths` and the
      // `@/...` entries in components.json (components, ui, lib, utils, hooks).
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Dev server origin http://localhost:5173 — matches VITE_APP_URL and the
    // Playwright `baseURL`. `strictPort` makes Vite exit if the port is taken
    // rather than selecting another one.
    port: 5173,
    strictPort: true,
  },
  preview: {
    // `vite preview` (production-build preview) origin http://localhost:4173.
    port: 4173,
    strictPort: true,
  },
  build: {
    // Emit the production bundle to `<package>/dist` with sourcemaps; the
    // ES2022 target matches tsconfig.base.json `"target": "ES2022"`.
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
