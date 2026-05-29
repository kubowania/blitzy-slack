/**
 * Zod-validated environment-variable loader for the `@app/api` package.
 *
 * Loads a local `.env` (via dotenv), validates the full environment shape
 * against {@link EnvSchema}, and throws a descriptive error on any validation
 * failure so the server never boots with invalid configuration. The validated
 * values are exposed as the immutable `env` singleton that every other module
 * in the package consumes.
 *
 * This module is the bottom of the API dependency tree: it has no internal
 * `src/*` imports and is imported before any module that reads configuration
 * (logger, Redis, services, routes, socket handlers). Consumers import `env`
 * instead of reading `process.env` directly (AAP §0.8.2 Gate 12).
 */
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Populate process.env from a local `.env` if present; an absent file is
// non-fatal (values may come from the host environment, Docker, or CI).
loadDotenv();

/**
 * Runtime schema for every environment variable the API package consumes.
 * Numeric fields use `z.coerce.number()` to convert string env values;
 * `DATABASE_URL` / `REDIS_URL` assert their URL scheme.
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

/**
 * Inferred shape of the validated environment. Exported so consumers that
 * accept the environment as a parameter (test helpers, factories) can
 * type-annotate it.
 */
export type EnvShape = z.infer<typeof EnvSchema>;

/**
 * Validate `process.env` against {@link EnvSchema}, returning the typed result.
 * Throws a descriptive {@link Error} listing every field issue when validation
 * fails so the failure surfaces at module load (fail-fast) before any server
 * or database connection is attempted.
 */
function loadEnv(): EnvShape {
  try {
    return EnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = JSON.stringify(error.format(), null, 2);
      throw new Error(`Environment variable validation failed:\n${formatted}`);
    }
    throw error;
  }
}

/**
 * The validated, immutable environment singleton. Parsed once at module load
 * and shared via Node's ESM module cache.
 */
export const env: EnvShape = loadEnv();
