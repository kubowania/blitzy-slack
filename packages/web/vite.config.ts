/**
 * Vite 6 build and dev-server configuration for the Blitzy Slack web client
 * (`@app/web`).
 *
 * Configures:
 *  - the plugin pipeline: `@vitejs/plugin-react` followed by `@tailwindcss/vite`
 *    (which reads the `@theme` directives in src/index.css);
 *  - the `@` path alias (mirrors `tsconfig.json` `paths` and the
 *    `components.json` aliases);
 *  - the dev server, the `vite preview` server, and the production build output.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ES modules do not expose `__dirname`; derive it from this file's URL for the
// `@` alias below.
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
    // Dev server on port 5173 (matches VITE_APP_URL and the Playwright
    // `baseURL`); `strictPort` is enabled.
    port: 5173,
    strictPort: true,
  },
  preview: {
    // `vite preview` (production-build preview) on port 4173.
    port: 4173,
    strictPort: true,
  },
  build: {
    // Production bundle emitted to `<package>/dist` with sourcemaps; ES2022
    // target matches tsconfig.base.json.
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
