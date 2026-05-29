/**
 * Zod-validated environment-variable loader for the `@app/api` package.
 *
 * Loads a local `.env` (via dotenv), validates the full environment shape
 * against {@link EnvSchema}, and FAILS FAST (`process.exit(1)`) on any
 * validation error so the server never boots with invalid configuration. The
 * validated values are exposed as the immutable `env` singleton that every
 * other module in the package consumes.
 *
 * This module is the BOTTOM of the API dependency tree: it has no internal
 * `src/*` imports and MUST be imported before any module that reads
 * configuration (logger, Redis, services, routes, socket handlers). Consumers
 * MUST import `env` instead of reading `process.env` directly (AAP §0.8.2
 * Gate 12 — every env var the API reads is validated here).
 *
 * `console.error` is used for the fail-fast diagnostic — and is the only
 * permitted `console` use in the API package — because the Pino logger depends
 * on this module and is therefore not yet constructed when validation runs.
 *
 * Rationale for the schema fields, the security minimums (JWT_SECRET ≥ 32
 * chars, BCRYPT_ROUNDS ≥ 10), and the fail-fast strategy is recorded in
 * /docs/decision-log.md; per the Explainability rule (AAP §0.8.3) this file
 * carries no embedded "why" rationale.
 */
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Populate process.env from a local `.env` if present. Silent and non-fatal
// when the file is absent: values may instead come from the host environment,
// Docker, or CI secrets. The default CWD lookup is what `make local` relies on.
loadDotenv();

/**
 * Runtime schema for every environment variable the API package consumes.
 *
 * Numeric fields use `z.coerce.number()` because all `process.env` values are
 * strings. `DATABASE_URL` / `REDIS_URL` additionally assert their URL scheme
 * so a mis-pasted connection string is rejected at startup rather than failing
 * deep inside Prisma or ioredis later.
 */
const EnvSchema = z.object({
  // Runtime mode; drives logger formatting and other environment branches.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // TCP port the Express + Socket.io HTTP server listens on.
  PORT: z.coerce.number().int().positive().default(3000),
  // Required. Prisma (PostgreSQL) datasource connection string.
  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://', 'DATABASE_URL must start with postgresql://'),
  // Required. Redis connection string (Socket.io adapter + presence cache).
  REDIS_URL: z.string().url().startsWith('redis://', 'REDIS_URL must start with redis://'),
  // Required. HS256 signing secret shared by HTTP routes and the Socket.io handshake.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters (AAP §0.8.4 security baseline)'),
  // JWT lifetime as a jsonwebtoken duration string (e.g. '7d', '1h', '30m').
  JWT_EXPIRES_IN: z.string().default('7d'),
  // multer disk-storage destination for uploaded attachments.
  FILE_UPLOAD_PATH: z.string().default('./uploads'),
  // Per-file upload ceiling in megabytes (10 MB cap per AAP §0.1.1).
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),
  // Allowed CORS origin; defaults to the Vite dev server.
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  // bcrypt cost factor; minimum 10 enforced (AAP §0.8.4 security baseline).
  BCRYPT_ROUNDS: z.coerce
    .number()
    .int()
    .min(10, 'BCRYPT_ROUNDS must be ≥ 10 (AAP §0.8.4 security baseline)')
    .default(10),
  // Optional Pino level override; when unset, logger.ts derives it from NODE_ENV.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  // The Pino logger depends on this module and is not constructed yet, so
  // console.error is the sole permitted console use in the API package.
  console.error('[env] Environment variable validation failed:');
  console.error(JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

/**
 * Inferred shape of the validated environment. Exported so consumers that
 * accept the environment as a parameter (test helpers, factories) can
 * type-annotate it.
 */
export type EnvShape = z.infer<typeof EnvSchema>;

/**
 * The validated, immutable environment singleton. Parsed once at module load
 * and shared via Node's ESM module cache. After the fail-fast guard above,
 * `process.exit(1)` returns `never`, so TypeScript narrows `result` to its
 * success variant and `result.data` is fully typed with no cast.
 */
export const env: EnvShape = result.data;
