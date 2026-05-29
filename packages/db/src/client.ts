/**
 * Singleton `PrismaClient` for the `@app/db` workspace package.
 *
 * Construction is gated by a `globalThis` guard so that the same instance
 * is reused across module re-entry (test isolation, hot-reload edge cases,
 * accidental dual-imports from sub-path exports). This protects the
 * application from connection-pool exhaustion in long-running processes
 * and from "Too many clients" errors against PostgreSQL.
 *
 * Per the Agent Action Plan §0.6.1 Group 2, the logging configuration is
 * fixed to `['warn', 'error']`. Query and info-level logs are intentionally
 * suppressed to keep production output focused on actionable signals.
 *
 * On `SIGTERM` and `SIGINT`, the client calls `$disconnect()` so that
 * in-flight queries can drain and the PostgreSQL connection pool is
 * released cleanly. This is critical for `make local` teardown and for
 * graceful shutdown under container orchestrators.
 */
import { PrismaClient } from '@prisma/client';

/**
 * Typed handle for caching the `PrismaClient` instance on `globalThis`.
 *
 * The `globalThis as unknown as <T>` double-cast is the strict-TypeScript-
 * safe alternative to `globalThis as any` (which is banned by
 * `@typescript-eslint/no-explicit-any`).
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * The singleton `PrismaClient` instance.
 *
 * Importers MUST NOT call `new PrismaClient()` themselves — they MUST
 * import `prisma` from `@app/db` (which re-exports this value
 * via `packages/db/src/index.ts`).
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

// Cache on globalThis in non-production to survive module re-entry from
// test runners and dev-mode hot-reload. In production we deliberately
// skip this cache so that a fresh process always boots a fresh client.
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Disconnect handler — drains the connection pool on process termination.
 *
 * The `void` prefix discards the returned Promise so that
 * `@typescript-eslint/no-floating-promises` does not flag this call.
 * Disconnect failures during shutdown are non-recoverable; we accept
 * the implicit best-effort semantics.
 */
const disconnectOnShutdown = (): void => {
  void prisma.$disconnect();
};

// Register the same handler for both POSIX termination signals.
// Module-level execution + Node's module cache ensure these handlers
// are registered EXACTLY ONCE per process.
process.on('SIGTERM', disconnectOnShutdown);
process.on('SIGINT', disconnectOnShutdown);
