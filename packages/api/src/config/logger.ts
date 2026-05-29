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
 * Consumers use this `logger` rather than `console`.
 */
import os from 'node:os';
import process from 'node:process';
import pino from 'pino';
import type { Level, Logger, LoggerOptions } from 'pino';

import { env } from './env.js';

/**
 * Resolve the effective Pino level: `env.LOG_LEVEL` when set, otherwise `debug`
 * in development and `info` in test and production. The return type
 * `Level | 'silent'` mirrors Pino's `LevelWithSilent`.
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
 * - `base` seeds `pid`, `hostname`, and a static `service` field on every line.
 * - `redact` replaces sensitive values with `[REDACTED]` while preserving the
 *   surrounding object shape (`remove: false`), covering request/response
 *   headers and bodies, bare top-level keys, and one level of nesting.
 * - `formatters.level` emits the string label (`"info"`) instead of the
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
      // Authorization header + bearer tokens (header-scoped, bare, nested).
      'req.headers.authorization',
      'res.headers.authorization',
      'authorization',
      '*.authorization',
      // Cookies (request cookie + response set-cookie); bracket-quoted for the hyphen.
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'res.headers["set-cookie"]',
      '["set-cookie"]',
      // Passwords (request body, bare, nested).
      'req.body.password',
      'req.body.passwordHash',
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
      // Generic tokens, secrets, and JWTs (bare + one level of nesting).
      'req.body.token',
      'token',
      '*.token',
      'secret',
      '*.secret',
      'jwt',
      '*.jwt',
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
 * Build the singleton. Development attaches the `pino-pretty` transport;
 * test and production return the raw-JSON logger with no transport.
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
