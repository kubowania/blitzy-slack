/**
 * Ambient type declarations for the Vite client environment.
 *
 * Augments the global `ImportMetaEnv` interface (supplied by
 * `vite/client`, already loaded via the `types` array in
 * `tsconfig.json`) with the project's `VITE_*` variables, typing each
 * as `string`. Without this augmentation those keys resolve to `any`
 * through Vite's default index signature, which is rejected by the
 * `@typescript-eslint/no-unsafe-*` rules under the zero-warning build.
 *
 * This file has no top-level `import`/`export`, so it remains a global
 * script whose `interface ImportMetaEnv` merges with Vite's; the
 * explicit members below take precedence over the fallback index
 * signature. No triple-slash reference is required.
 */
interface ImportMetaEnv {
  /** Base URL for HTTP REST calls; consumed by `src/lib/api-client.ts`. */
  readonly VITE_API_URL: string;
  /** Socket.io endpoint URL; consumed by `src/lib/socket.ts`. */
  readonly VITE_WS_URL: string;
  /** The web client's own dev-server origin; used by E2E config and CORS. */
  readonly VITE_APP_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
