/**
 * Pino logger singleton for the `@app/api` package.
 *
 * Constructs the single {@link Logger} instance shared by every middleware,
 * route, service, and socket handler in the API. Production and test emit
 * structured single-line JSON to stdout; development pipes through the
 * `pino-pretty` worker for human-readable, colorized output. A redaction
 * policy strips secrets (JWTs, cookies, passwords, tokens) from every emitted
 * line so credentials never reach a log sink.
 *
 * Layering: this module sits directly above `./env.js` in the API dependency
 * tree. Its only imports are Node built-ins (`node:os`, `node:process`),
 * `pino`, and the validated `env` singleton — it MUST NOT import from any other
 * `src/*` folder, keeping it free of cycles so any module may depend on it.
 *
 * Construction is pure: building the Pino instance performs no IO. The first
 * `.info()`/`.debug()`/etc. call triggers output, and in development that first
 * flush spawns the `pino-pretty` worker thread.
 *
 * Consumers MUST use this `logger` rather than `console`. Rationale for the
 * logger choice, the dev-only pretty transport, the redaction scope, the ISO
 * timestamp, the level formatter, the `LOG_LEVEL` override, and the
 * `Level | 'silent'` resolver return type is recorded in /docs/decision-log.md;
 * per the Explainability rule (AAP §0.8.3) this file carries no "why" rationale.
 */
import os from 'node:os';
import process from 'node:process';
import pino from 'pino';
import type { Level, Logger, LoggerOptions } from 'pino';

import { env } from './env.js';

/**
 * Resolve the effective Pino level.
 *
 * `env.LOG_LEVEL`, when set, wins outright. Otherwise the level is derived from
 * the runtime mode: `debug` in development, `info` in test and production.
 *
 * The return type is `Level | 'silent'` rather than Pino's `Level`: Pino's
 * `Level` union omits `'silent'`, but `env.LOG_LEVEL` (validated in `env.ts` as
 * `z.enum(['fatal','error','warn','info','debug','trace','silent']).optional()`)
 * may legitimately be `'silent'`. `Level | 'silent'` is structurally identical
 * to Pino's `LevelWithSilent` and assignable to `LoggerOptions.level`.
 */
function resolveLogLevel(): Level | 'silent' {
  if (env.LOG_LEVEL) {
    return env.LOG_LEVEL;
  }
  if (env.NODE_ENV === 'development') {
    return 'debug';
  }
  // Test and production both default to `info`.
  return 'info';
}

/**
 * Base Pino configuration shared by every environment.
 *
 * - `base` seeds three fields on every line: the originating process id and
 *   hostname (for per-instance correlation under the horizontally-scaled
 *   Socket.io + Redis-adapter topology) and a static `service` identifier.
 *   It deliberately contains NOTHING else — never secrets from `env`.
 * - `redact` replaces sensitive values with `[REDACTED]` while preserving the
 *   surrounding object shape (`remove: false`). The paths cover request
 *   headers/bodies handled by `pino-http`, bare top-level keys, and one level
 *   of nesting via `*` wildcards.
 * - `formatters.level` emits the string label (`"info"`) instead of Pino's
 *   default numeric level (`30`).
 * - `timestamp` writes ISO 8601 UTC strings.
 */
const baseConfig: LoggerOptions = {
  level: resolveLogLevel(),
  base: {
    pid: process.pid,
    hostname: os.hostname(),
    service: '@blitzy-slack/api',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.passwordHash',
      'req.body.token',
      'password',
      'passwordHash',
      'token',
      '*.password',
      '*.passwordHash',
      '*.token',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Build the singleton.
 *
 * Development attaches the `pino-pretty` transport (a worker thread that
 * colorizes and reformats output). Test and production return the raw-JSON
 * logger with no transport, keeping tests fast and output ingestible by log
 * aggregators.
 */
function createLogger(): Logger {
  if (env.NODE_ENV === 'development') {
    return pino({
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'SYS:HH:MM:ss.l',
          singleLine: false,
        },
      },
    });
  }
  return pino(baseConfig);
}

/**
 * The shared Pino logger. Import this everywhere structured logging is needed:
 *
 * ```ts
 * import { logger } from './config/logger.js';
 * logger.info({ component: 'auth.service', userId }, 'User logged in');
 * ```
 */
export const logger: Logger = createLogger();
