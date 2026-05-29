/**
 * Jest setup module for the `@app/api` package.
 *
 * Wired via `setupFiles` in `jest.config.ts`, this module runs once per test
 * worker BEFORE any suite module is imported — and therefore before
 * `src/config/env.ts` evaluates `process.env`. It seeds deterministic values
 * for every required environment variable so the Zod env loader validates
 * successfully under test without depending on a developer's local `.env`.
 *
 * Each assignment uses `??=` so an explicitly provided environment variable
 * (for example one exported by CI) takes precedence over the seeded default.
 */
import process from 'node:process';

// Runtime mode: keep the logger in non-pretty mode and signal test behaviour.
process.env.NODE_ENV ??= 'test';

// PostgreSQL connection string (must start with postgresql:// per the schema).
process.env.DATABASE_URL ??=
  'postgresql://slack:slack@localhost:5432/slack_test?schema=public';

// Redis connection string (must start with redis:// per the schema).
process.env.REDIS_URL ??= 'redis://localhost:6379';

// HS256 signing secret; the schema requires at least 32 characters.
process.env.JWT_SECRET ??= 'test-jwt-secret-value-at-least-32-characters-long';

// JWT lifetime as a jsonwebtoken duration string.
process.env.JWT_EXPIRES_IN ??= '1h';

// multer disk-storage destination for any upload exercised in tests.
process.env.FILE_UPLOAD_PATH ??= './uploads';

// Per-file upload ceiling in megabytes.
process.env.MAX_FILE_SIZE_MB ??= '10';

// CORS allow-list origin (the web app origin).
process.env.CORS_ORIGIN ??= 'http://localhost:5173';

// bcrypt cost factor; the schema enforces a minimum of 10.
process.env.BCRYPT_ROUNDS ??= '10';

// Silence Pino during tests so suite output stays readable.
process.env.LOG_LEVEL ??= 'silent';
