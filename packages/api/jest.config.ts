import type { Config } from 'jest';

/**
 * Jest runner configuration for the `@app/api` package.
 *
 * Module system : ESM. The api package declares `"type": "module"`, so Jest
 *                 runs in experimental ESM mode (`node --experimental-vm-modules`,
 *                 set by the package.json `test` script) and ts-jest transforms
 *                 `.ts` files as ES modules.
 * rootDir       : `..` - the monorepo `packages/` directory, NOT this package.
 *                 This is REQUIRED for Gate 13 coverage. Jest's coverage
 *                 instrumenter (`babel-plugin-istanbul`) is configured by Jest
 *                 with `cwd: config.rootDir` and silently refuses to instrument
 *                 any file whose path relative to that cwd begins with `..`. The
 *                 Gate 13 scope spans BOTH `packages/api/src/services` AND
 *                 `packages/shared/src/schemas`; only a shared ancestor rootDir
 *                 (`packages/`) keeps both trees inside the instrumenter's cwd so
 *                 both are measured. Source lives under `<rootDir>/api/src`,
 *                 suites under `<rootDir>/api/test`, shared schemas under
 *                 `<rootDir>/shared/src`. Rationale, alternatives (V8 provider,
 *                 which cannot attribute cross-package ESM runtime coverage), and
 *                 risks are recorded in /docs/decision-log.md.
 * Preset        : The `ts-jest/presets/default-esm` preset shorthand is NOT used.
 *                 pnpm installs ts-jest only under `<rootDir>/api/node_modules`,
 *                 so Jest's preset resolver (which searches from `rootDir`,
 *                 i.e. `packages/`) cannot find it. The preset's two settings
 *                 (`extensionsToTreatAsEsm` and the ts-jest `transform`) are
 *                 inlined below instead, with the transformer referenced by an
 *                 explicit, rootDir-relative path that always resolves.
 * Setup         : `<rootDir>/api/test/setup.ts` is the shared test-infrastructure
 *                 helper module, imported explicitly by the integration suites
 *                 (not a global `setupFiles` env-seeder). Env values come from
 *                 the package `.env` and Jest's default `NODE_ENV='test'`.
 * Coverage      : `collectCoverageFrom` targets the `api/src/services` layer AND
 *                 the `shared/src/schemas` tree (the two Gate 13 targets), both
 *                 of which are now inside `rootDir`. The global
 *                 `coverageThreshold` enforces the line-coverage floor.
 */
const config: Config = {
  // Project root is the monorepo packages/ directory (this file lives at
  // packages/api/jest.config.ts, so `..` resolves to packages/). Both Gate 13
  // coverage trees (api/src/services and shared/src/schemas) live under it.
  rootDir: '..',

  // Module-discovery roots are scoped to the two packages this suite touches:
  // the api package (source + tests) and the shared package (Zod schemas, which
  // Gate 13 requires in coverage). The web and db packages are deliberately
  // excluded from the crawl - db is reached only through `moduleNameMapper` at
  // runtime (which does not require a root), and web has its own Playwright
  // suite. Test discovery is anchored to `<rootDir>/api/test/**` below, and the
  // shared tree contains no `*.test.ts` files, so this does not widen discovery.
  roots: ['<rootDir>/api', '<rootDir>/shared'],

  // Backend tests run in Node; no DOM is required.
  testEnvironment: 'node',

  // Treat `.ts` modules as ESM so import/export syntax is preserved. (Inlined
  // from the ts-jest default-esm preset; see the Preset note in the header.)
  extensionsToTreatAsEsm: ['.ts'],

  // No `setupFiles` entry: `test/setup.ts` is the shared test-infrastructure
  // helper module (imported explicitly by integration suites via `./setup.js`),
  // NOT a global env-seeder. Loading it eagerly would open Redis connections
  // for every worker (config/redis.ts uses `lazyConnect: false`), leaving open
  // handles in suites that do not call `closeTestResources()`. Test-environment
  // variables come from the package `.env` (loaded by config/env.ts via dotenv)
  // plus Jest's own default `NODE_ENV='test'`.
  setupFiles: [],

  // Discover suites only within the api package's test/ folder; only files
  // ending in `.test.ts`. (test/setup.ts and this config are intentionally
  // excluded by the glob.)
  testMatch: ['<rootDir>/api/test/**/*.test.ts'],

  // Never treat build outputs, dependencies, or coverage artifacts as tests.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/coverage/'],

  // Compile `.ts` files with ts-jest in ESM mode using the api tsconfig.
  // The transformer is referenced by an explicit, rootDir-relative path
  // (`<rootDir>/api/node_modules/ts-jest`) because pnpm installs ts-jest only
  // in the api package and Jest would otherwise resolve transformer modules
  // from `rootDir` (packages/), where ts-jest is absent. `useESM: true` is the
  // setting the dropped default-esm preset would have supplied.
  // `diagnostics.warnOnly: false` promotes TypeScript errors to test failures.
  transform: {
    '^.+\\.ts$': [
      '<rootDir>/api/node_modules/ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/api/tsconfig.json',
        diagnostics: { warnOnly: false },
      },
    ],
  },

  // Module resolution for the test runner.
  // NOTE: ordering matters - patterns ending in `.js` MUST precede their bare
  // counterparts so the more specific rule wins.
  moduleNameMapper: {
    // 1. Strip the `.js` suffix from relative imports (NodeNext convention),
    //    e.g. `./setup.js` -> `./setup` so ts-jest resolves the `.ts` source.
    //    (Inlined from the ts-jest default-esm preset.)
    '^(\\.{1,2}/.*)\\.js$': '$1',

    // 2. Workspace package @app/shared -> packages/shared/src (source resolution,
    //    no pre-build step). `<rootDir>/shared` is the shared package root.
    '^@app/shared/(.*)\\.js$': '<rootDir>/shared/src/$1.ts',
    '^@app/shared/(.*)$': '<rootDir>/shared/src/$1.ts',
    '^@app/shared$': '<rootDir>/shared/src/index.ts',

    // 3. Workspace package @app/db -> packages/db/src (source resolution).
    '^@app/db/(.*)\\.js$': '<rootDir>/db/src/$1.ts',
    '^@app/db/(.*)$': '<rootDir>/db/src/$1.ts',
    '^@app/db$': '<rootDir>/db/src/index.ts',
  },

  // Coverage is collected from BOTH the API services layer AND the shared Zod
  // schemas - the two targets Gate 13 requires (>=80% line coverage). The shared
  // schemas are exercised through the `validate` middleware on every endpoint
  // integration test, and the `moduleNameMapper` above resolves `@app/shared/*`
  // to `shared/src/*`, so their coverage is collected from source with no build
  // step. Both trees sit under `rootDir` (packages/), so the istanbul
  // instrumenter (cwd = rootDir) includes them. Barrel and declaration files
  // carry no executable logic and are excluded.
  collectCoverageFrom: [
    '<rootDir>/api/src/services/**/*.ts',
    '!<rootDir>/api/src/services/**/index.ts',
    '!<rootDir>/api/src/services/**/*.d.ts',
    '<rootDir>/shared/src/schemas/**/*.ts',
    '!<rootDir>/shared/src/schemas/**/index.ts',
    '!<rootDir>/shared/src/schemas/**/*.d.ts',
  ],

  // Coverage output location and report formats. Kept inside the api package.
  coverageDirectory: '<rootDir>/api/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // Coverage floor: 80% lines/functions/statements, 70% branches across the
  // combined Gate 13 scope (API services + shared Zod schemas).
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 70,
      functions: 80,
      statements: 80,
    },
  },

  // Per-test time budget (15s).
  testTimeout: 15_000,

  // Serial execution (single worker). The integration suites share one
  // Postgres database, and test/setup.ts's cleanDatabase() truncates every
  // table in each beforeEach hook; concurrent workers would wipe one another's
  // in-flight rows, producing nondeterministic cross-suite failures. Forcing a
  // single worker here makes the canonical `make test` deterministic regardless
  // of invocation. Rationale, alternatives, and risks: /docs/decision-log.md.
  maxWorkers: 1,

  // Reporter verbosity and failure behaviour.
  verbose: false,
  bail: false,
  detectOpenHandles: false,
  forceExit: false,

  // Reset and restore mock state between tests to prevent cross-test leakage.
  clearMocks: true,
  restoreMocks: true,

  // Use Jest's default module resolver.
  resolver: undefined,
};

export default config;
