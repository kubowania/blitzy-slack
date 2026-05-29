/**
 * ioredis client construction for the `@app/api` package (Pattern A).
 *
 * Constructs the three Redis connections the API relies on and the graceful-
 * shutdown helper that closes them. Pattern A means this module exports the raw
 * ioredis clients only — the Socket.io Redis adapter is assembled at the call
 * site in `src/index.ts` via `io.adapter(createAdapter(pubClient, subClient))`.
 * This module never imports or instantiates `@socket.io/redis-adapter` itself,
 * keeping it free of any coupling to Socket.io.
 *
 * Three DISTINCT connections are opened, each constructed directly from
 * `env.REDIS_URL`:
 *   - `pubClient`   — publishes adapter messages for cross-instance Socket.io
 *                     fan-out (AAP §0.4.5).
 *   - `subClient`   — the adapter's subscriber connection; a Redis connection in
 *                     subscriber mode cannot also serve ordinary commands, so it
 *                     MUST be a separate socket from `pubClient`. It is built
 *                     with its own `new Redis(...)`, never as a `.duplicate()`
 *                     of `pubClient`.
 *   - `redisClient` — the presence cache (TTL heartbeat reads/writes) and any
 *                     other non-adapter command traffic; kept on its own
 *                     connection so presence operations are never blocked behind
 *                     the subscriber connection.
 *
 * Layering: this module sits directly above `./env.js` and `./logger.js` in the
 * API dependency tree and imports from no other `src/*` folder. It MUST NOT pull
 * in `express`, `socket.io`, `@socket.io/redis-adapter`, or `@prisma/client` —
 * those belong to `index.ts`/`app.ts`/the service layer.
 *
 * Load-time side effects: importing this module opens three TCP connections to
 * Redis immediately (`lazyConnect: false`). This is intentional — a Redis
 * misconfiguration surfaces at startup rather than at the first request. The
 * process entry point (`src/index.ts`) MUST call `disconnectRedisClients()` on
 * SIGTERM/SIGINT to close them cleanly.
 *
 * Security (AAP §0.8.4): `env.REDIS_URL` may embed credentials and therefore
 * MUST NOT be logged. Every log line that references the URL uses
 * `REDIS_URL_SAFE`, whose username and password have been stripped by
 * `safeUrl()`; error handlers log only `err.message`, never the whole error
 * object (which could carry connection details).
 *
 * Per the Explainability rule (AAP §0.8.3), the rationale for these choices
 * (Pattern A, three distinct connections, the connection-option values, and
 * credential stripping) lives in /docs/decision-log.md — not in code comments.
 */
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Returns a copy of `rawUrl` with any embedded credentials removed, safe to log.
 *
 * Parses the URL, blanks the `username`/`password`, and serialises it back so
 * the host, port, and database remain visible for diagnostics while the auth
 * portion is dropped. If the value cannot be parsed, a constant placeholder is
 * returned so a malformed connection string never leaks verbatim into the logs.
 * The `catch` intentionally omits a binding: the parse failure carries no
 * information worth logging here — only the placeholder result matters.
 */
function safeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[invalid url]';
  }
}

/**
 * Credential-stripped form of `env.REDIS_URL`, computed once at module load and
 * the only representation of the URL permitted in log output.
 */
const REDIS_URL_SAFE = safeUrl(env.REDIS_URL);

/**
 * Connection options shared identically by all three clients.
 *
 * - `lazyConnect: false` — connect eagerly at construction so a misconfiguration
 *   surfaces at startup, not at the first command.
 * - `enableReadyCheck: true` — defer commands until Redis reports `READY`.
 * - `maxRetriesPerRequest: 3` — fail a command after three retries instead of
 *   retrying indefinitely.
 * - `reconnectOnError` — reconnect only for the listed transient error tokens
 *   and let every other error propagate. The `err` parameter is contextually
 *   typed `Error` by `RedisOptions.reconnectOnError`.
 */
const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    return targetErrors.some((token) => err.message.includes(token));
  },
};

/**
 * Registers structured Pino lifecycle logging on a Redis client.
 *
 * Every line carries `component: 'redis'` and the client `label` so the three
 * connections are distinguishable in the logs. The `connect` line additionally
 * includes the credential-stripped URL; the `error` line includes only
 * `err.message` so connection details are never serialised into a log sink.
 *
 * @param client - the ioredis client to instrument
 * @param label - short connection identifier (`'pub'` | `'sub'` | `'presence'`)
 */
function attachLifecycleLogging(client: Redis, label: string): void {
  client.on('connect', () => {
    logger.info(
      { component: 'redis', client: label, url: REDIS_URL_SAFE },
      'Redis client connecting',
    );
  });
  client.on('ready', () => {
    logger.info({ component: 'redis', client: label }, 'Redis client ready');
  });
  client.on('error', (err: Error) => {
    logger.error({ component: 'redis', client: label, err: err.message }, 'Redis client error');
  });
  client.on('close', () => {
    logger.warn({ component: 'redis', client: label }, 'Redis client connection closed');
  });
  client.on('reconnecting', (delay: number) => {
    logger.warn({ component: 'redis', client: label, delay }, 'Redis client reconnecting');
  });
  client.on('end', () => {
    logger.info({ component: 'redis', client: label }, 'Redis client ended');
  });
}

/**
 * Publisher connection for the Socket.io Redis adapter.
 *
 * Passed as the first argument to `createAdapter(pubClient, subClient)` in
 * `src/index.ts`. Distinct from {@link subClient} because the adapter requires
 * independent publish and subscribe sockets.
 */
export const pubClient: Redis = new Redis(env.REDIS_URL, baseOptions);
attachLifecycleLogging(pubClient, 'pub');

/**
 * Subscriber connection for the Socket.io Redis adapter.
 *
 * Passed as the second argument to `createAdapter(pubClient, subClient)`. A
 * Redis connection in subscriber mode cannot serve ordinary commands, so this
 * MUST be a separate connection from {@link pubClient} and {@link redisClient}.
 */
export const subClient: Redis = new Redis(env.REDIS_URL, baseOptions);
attachLifecycleLogging(subClient, 'sub');

/**
 * General-purpose connection for the presence cache (TTL heartbeat
 * reads/writes) and any other non-adapter command traffic.
 *
 * Kept separate from the adapter's subscriber connection so presence operations
 * are never blocked behind subscribe-mode head-of-line blocking.
 */
export const redisClient: Redis = new Redis(env.REDIS_URL, baseOptions);
attachLifecycleLogging(redisClient, 'presence');

/**
 * Closes all three Redis connections cleanly. Intended for the SIGTERM/SIGINT
 * shutdown path in `src/index.ts`.
 *
 * Uses `Promise.allSettled` so a failure quitting one client never prevents the
 * others from closing; each rejection is logged with its client label and the
 * rejection's message. `result.reason` is typed `any` by `PromiseRejectedResult`
 * and is narrowed to a string before logging so only the message — never the
 * whole error — is emitted. This function always resolves and never rejects.
 */
export async function disconnectRedisClients(): Promise<void> {
  logger.info({ component: 'redis' }, 'Disconnecting Redis clients');
  const results = await Promise.allSettled([
    pubClient.quit(),
    subClient.quit(),
    redisClient.quit(),
  ]);
  const labels = ['pub', 'sub', 'presence'] as const;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const label = labels[index] ?? 'unknown';
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error(
        { component: 'redis', client: label, err: reason },
        'Redis client failed to disconnect cleanly',
      );
    }
  });
  logger.info({ component: 'redis' }, 'Redis disconnect complete');
}
