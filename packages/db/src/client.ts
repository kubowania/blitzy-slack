/**
 * Singleton `PrismaClient` for the `@app/db` workspace package.
 *
 * This module is the only place that constructs the production client.
 * Consumers import `prisma` (and, for shutdown, `disconnectPrisma`) from
 * `@app/db`; they MUST NOT call `new PrismaClient()` themselves.
 *
 * Logging is configured to `['warn', 'error']` (AAP §0.6.1 Group 2).
 *
 * Graceful shutdown is exposed via `disconnectPrisma()` and is additionally
 * wired to `SIGTERM`/`SIGINT` so the PostgreSQL connection pool is released
 * on `make down`, `docker compose down`, and Ctrl+C during `make local`.
 *
 * Rationale for these choices is recorded in /docs/decision-log.md, not here.
 */
import { PrismaClient } from '@prisma/client';

/** Typed handle for caching the `PrismaClient` instance on `globalThis`. */
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

// Outside production, cache on globalThis so test-runner and dev-mode
// hot-reload module re-entry reuse this instance; production constructs a
// fresh client per process.
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Closes the PrismaClient connection pool.
 *
 * Awaitable so the API server's top-level shutdown path can sequence
 * HTTP/socket closure before the database disconnect, and so test suites can
 * release connections in an `afterAll` hook. Safe to call more than once.
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

// Guards the disconnect sequence against running twice when both SIGINT and
// SIGTERM are delivered to the process.
let isShuttingDown = false;

/**
 * Awaits a clean disconnect on process termination, then re-raises the
 * originating signal so Node's default termination proceeds. Registered with
 * `process.once` so each signal triggers the sequence at most once.
 */
async function runGracefulShutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  try {
    await disconnectPrisma();
  } catch {
    // Best-effort: a failed disconnect during shutdown is non-recoverable.
  }
  process.kill(process.pid, signal);
}

process.once('SIGTERM', () => {
  void runGracefulShutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void runGracefulShutdown('SIGINT');
});
