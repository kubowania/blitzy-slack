/**
 * Singleton `PrismaClient` for the `@app/db` workspace package.
 *
 * This module is the only place that constructs the production client.
 * Consumers import `prisma` (and, for shutdown, `disconnectPrisma`) from
 * `@app/db`; they MUST NOT call `new PrismaClient()` themselves.
 *
 * Logging is configured to `['warn', 'error']` (AAP §0.6.1 Group 2).
 *
 * The connection pool is explicitly bounded: the datasource URL is augmented
 * with `connection_limit` and `pool_timeout` parameters (see
 * `resolveDatasourceUrl`) so the pool cannot grow unbounded on high-core hosts.
 *
 * Construction is deferred to first property access via a `Proxy`: the
 * underlying `PrismaClient` (and therefore `resolveDatasourceUrl`'s read of
 * `process.env.DATABASE_URL`) is created lazily, after the host process has
 * populated its environment (e.g. via `dotenv` in the API's `config/env`).
 * This makes the bounded-pool URL apply regardless of module evaluation order.
 *
 * Graceful shutdown is exposed via `disconnectPrisma()` and is additionally
 * wired to `SIGTERM`/`SIGINT` so the PostgreSQL connection pool is released
 * on `make down`, `docker compose down`, and Ctrl+C during `make local`.
 *
 * Rationale for these choices is recorded in /docs/decision-log.md, not here.
 */
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/**
 * Default ceiling on the number of physical PostgreSQL connections this
 * client's pool may open, applied to the datasource URL when it does not
 * already carry a `connection_limit` query parameter.
 */
const DEFAULT_CONNECTION_LIMIT = 10;

/**
 * Default number of seconds a query waits for a free pooled connection before
 * it fails, applied to the datasource URL when it does not already carry a
 * `pool_timeout` query parameter.
 */
const DEFAULT_POOL_TIMEOUT_SECONDS = 20;

/** Typed handle for caching the `PrismaClient` instance on `globalThis`. */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Resolve the datasource URL with an explicitly bounded connection pool.
 *
 * Reads `DATABASE_URL` and, when present and parseable, ensures both the
 * `connection_limit` and `pool_timeout` query parameters are set — leaving any
 * value an operator has already supplied untouched. Returns `undefined` when
 * `DATABASE_URL` is absent or cannot be parsed, in which case the caller omits
 * the `datasourceUrl` override and Prisma reads the raw `DATABASE_URL` via the
 * schema's `env(...)` binding (unbounded default pool).
 *
 * @returns The bounded datasource URL, or `undefined` to defer to the schema binding.
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(DEFAULT_CONNECTION_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(DEFAULT_POOL_TIMEOUT_SECONDS));
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Construct the production `PrismaClient` with `log: ['warn', 'error']`
 * (AAP §0.6.1 Group 2) and the bounded-pool datasource URL from
 * {@link resolveDatasourceUrl} (when one is resolvable).
 *
 * @returns A new, configured `PrismaClient`.
 */
function createPrismaClient(): PrismaClient {
  const options: Prisma.PrismaClientOptions = {
    log: ['warn', 'error'],
  };
  const datasourceUrl = resolveDatasourceUrl();
  if (datasourceUrl !== undefined) {
    options.datasourceUrl = datasourceUrl;
  }
  return new PrismaClient(options);
}

/**
 * Module-local handle to the lazily constructed client, so repeated property
 * access does not reconstruct it.
 */
let lazyClient: PrismaClient | undefined;

/**
 * Return the singleton `PrismaClient`, constructing it on first call.
 *
 * Outside production the instance is cached on `globalThis` so test-runner and
 * dev-mode module re-entry reuse it; production constructs one per process.
 * Deferring construction to first call ensures {@link resolveDatasourceUrl}
 * reads `DATABASE_URL` after the host has loaded its environment.
 *
 * @returns The shared `PrismaClient` instance.
 */
function getPrismaClient(): PrismaClient {
  if (lazyClient) {
    return lazyClient;
  }
  lazyClient = globalForPrisma.prisma ?? createPrismaClient();
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = lazyClient;
  }
  return lazyClient;
}

/**
 * The singleton `PrismaClient`, exposed as a transparent lazy `Proxy`.
 *
 * Every property access forwards to the real client (constructed on first
 * access). Function-valued members are bound to the real instance so Prisma's
 * internal private (`#`) fields resolve correctly when methods are invoked
 * through this proxy.
 *
 * Importers MUST NOT call `new PrismaClient()` themselves — they MUST
 * import `prisma` from `@app/db` (which re-exports this value
 * via `packages/db/src/index.ts`).
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrismaClient();
    // `Reflect.get` returns `any`; widen to `unknown` (safe) and narrow below.
    // The receiver is the real client so accessor getters resolve `this`
    // correctly and do not recurse back through this proxy.
    const value: unknown = Reflect.get(client, property, client);
    if (typeof value === 'function') {
      // `as` cast (permitted by Rule 3; rationale in /docs/decision-log.md):
      // bind the method to the real client so private fields stay accessible.
      return (value as (...args: unknown[]) => unknown).bind(client);
    }
    return value;
  },
  has(_target, property) {
    return property in getPrismaClient();
  },
  set(_target, property, value: unknown) {
    return Reflect.set(getPrismaClient(), property, value);
  },
});

/**
 * Closes the PrismaClient connection pool.
 *
 * Awaitable so the API server's top-level shutdown path can sequence
 * HTTP/socket closure before the database disconnect, and so test suites can
 * release connections in an `afterAll` hook. Safe to call more than once, and
 * a no-op when no client was ever constructed (so shutdown does not create a
 * client purely to disconnect it).
 */
export async function disconnectPrisma(): Promise<void> {
  const client = lazyClient ?? globalForPrisma.prisma;
  if (client) {
    await client.$disconnect();
  }
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
