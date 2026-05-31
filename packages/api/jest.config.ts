import type { Config } from 'jest';

/**
 * Jest runner configuration for the `@app/api` package.
 *
 * Module system : ESM. The api package declares `"type": "module"`, so Jest
 *                 runs in experimental ESM mode (`node --experimental-vm-modules`,
 *                 set by the package.json `test` script) and ts-jest transforms
 *                 `.ts` files as ES modules.
 * rootDir       : `.` - this file lives at the package root, so `<rootDir>/src`
 *                 is the source tree and `<rootDir>/test` holds the test suites.
 * Setup         : `<rootDir>/test/setup.ts` is the shared test-infrastructure
 *                 helper module, imported explicitly by the integration suites
 *                 (not a global `setupFiles` env-seeder). Env values come from
 *                 the package `.env` and Jest's default `NODE_ENV='test'`.
 * Coverage      : `collectCoverageFrom` targets the `src/services` layer; the
 *                 global `coverageThreshold` enforces the line-coverage floor.
 */
const config: Config = {
  // Project root is the directory containing this file (packages/api/).
  rootDir: '.',

  // ESM preset for ts-jest (the api package is "type": "module").
  preset: 'ts-jest/presets/default-esm',

  // Backend tests run in Node; no DOM is required.
  testEnvironment: 'node',

  // Treat `.ts` modules as ESM so import/export syntax is preserved.
  extensionsToTreatAsEsm: ['.ts'],

  // No `setupFiles` entry: `test/setup.ts` is the shared test-infrastructure
  // helper module (imported explicitly by integration suites via `./setup.js`),
  // NOT a global env-seeder. Loading it eagerly would open Redis connections
  // for every worker (config/redis.ts uses `lazyConnect: false`), leaving open
  // handles in suites that do not call `closeTestResources()`. Test-environment
  // variables come from the package `.env` (loaded by config/env.ts via dotenv)
  // plus Jest's own default `NODE_ENV='test'`.
  setupFiles: [],

  // Discover suites only within the test/ folder; only files ending in `.test.ts`.
  // (test/setup.ts and this config are intentionally excluded by the glob.)
  testMatch: ['<rootDir>/test/**/*.test.ts'],

  // Never treat build outputs, dependencies, or coverage artifacts as tests.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/coverage/'],

  // Compile `.ts` files with ts-jest in ESM mode using the api tsconfig.
  // `diagnostics.warnOnly: false` promotes TypeScript errors to test failures.
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
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
    '^(\\.{1,2}/.*)\\.js$': '$1',

    // 2. Workspace package @app/shared -> packages/shared/src (source resolution,
    //    no pre-build step). `<rootDir>/..` traverses to the packages/ directory.
    '^@app/shared/(.*)\\.js$': '<rootDir>/../shared/src/$1.ts',
    '^@app/shared/(.*)$': '<rootDir>/../shared/src/$1.ts',
    '^@app/shared$': '<rootDir>/../shared/src/index.ts',

    // 3. Workspace package @app/db -> packages/db/src (source resolution).
    '^@app/db/(.*)\\.js$': '<rootDir>/../db/src/$1.ts',
    '^@app/db/(.*)$': '<rootDir>/../db/src/$1.ts',
    '^@app/db$': '<rootDir>/../db/src/index.ts',
  },

  // Coverage is collected from the services layer (Gate 13 scope). Barrel and
  // declaration files carry no executable logic and are excluded.
  collectCoverageFrom: [
    '<rootDir>/src/services/**/*.ts',
    '!<rootDir>/src/services/**/index.ts',
    '!<rootDir>/src/services/**/*.d.ts',
  ],

  // Coverage output location and report formats.
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // Coverage floor: 80% lines/functions/statements, 70% branches on the
  // services layer.
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
