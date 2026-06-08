/**
 * @file packages/api/test/setup.ts
 *
 * Shared test infrastructure for all Jest suites in `packages/api/test/`.
 * Exports helpers, factories, and re-exports of shared resources (Prisma,
 * Redis) so every suite gets a consistent surface for setup and teardown.
 *
 * This module is imported explicitly by the integration suites
 * (`auth.test.ts`, `channels.test.ts`, `dms.test.ts`, `messages.test.ts`,
 * `files.test.ts`, `search.test.ts`, `socket.test.ts`) via `./setup.js`. It is
 * deliberately NOT matched by Jest's `testMatch` glob (it has no `.test.ts`
 * suffix) and is NOT wired as a `setupFiles` entry — importing it eagerly
 * opens Redis connections (config/redis.ts uses `lazyConnect: false`), so only
 * suites that own a `closeTestResources()` teardown should load it.
 *
 * Compliance:
 *   Rule 3  — strict TypeScript, zero ESLint warnings; no `@ts-ignore`.
 *   Rule 4  — `registerUser` creates users via `POST /api/auth/register`;
 *             this file never inserts users directly through Prisma.
 *   Gate 10 — Pino logs are not silenced; logger.ts owns dev/test formatting.
 *
 * Test database / environment strategy and the rationale for each non-trivial
 * choice are recorded in /docs/decision-log.md, not in these comments.
 */

// Establish the test runtime mode before the hoisted imports evaluate
// `config/env.ts`. `??` preserves an explicitly provided value (e.g. from CI).
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, parse, resolve, sep } from 'node:path';
import jwt, { type SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import type { Application } from 'express';

import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pubClient, subClient, redisClient, disconnectRedisClients } from '../src/config/redis.js';
import { prisma } from '@app/db';
import type { User } from '@app/shared/types/user';
import type { Channel } from '@app/shared/types/channel';
import type { DirectMessage } from '@app/shared/types/dm';
import { MAX_FILE_SIZE_BYTES } from '@app/shared/constants/limits';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Rule 4 seed credentials. The Makefile and scripts/seed-via-api.ts use the
 * same values; exported here for suites that exercise the seed flow.
 */
export const SEED_EMAIL = 'admin@test.com' as const;
export const SEED_PASSWORD = 'Password12345!' as const;

// -----------------------------------------------------------------------------
// Unique Generators
// -----------------------------------------------------------------------------

/** Returns a unique email like `test-1700000000000-abc12345@blitzy-slack.test`. */
export function uniqueEmail(): string {
  return `test-${Date.now()}-${randomBytes(4).toString('hex')}@blitzy-slack.test`;
}

/** Returns a unique displayName like `Test User abc123`. */
export function uniqueDisplayName(): string {
  return `Test User ${randomBytes(3).toString('hex')}`;
}

/**
 * Returns a unique channel name matching the channel-name pattern
 * `/^[a-z0-9_-]+$/` — Slack-style lowercase with hyphens.
 */
export function uniqueChannelName(): string {
  return `test-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// -----------------------------------------------------------------------------
// File Buffers (for files.test.ts)
// -----------------------------------------------------------------------------

/** Minimal 8-byte PNG signature — enough for multer to accept and record. */
export function tinyPngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** Zero-filled buffer exactly one byte over the upload limit (for 413 tests). */
export function oversizedBuffer(): Buffer {
  return Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
}

// -----------------------------------------------------------------------------
// App Factory
// -----------------------------------------------------------------------------

let cachedApp: Application | null = null;

/**
 * Returns the Express application instance, reused across a suite for speed.
 * supertest binds to the app object per request — no port is opened.
 */
export function createTestApp(): Application {
  cachedApp ??= createApp();
  return cachedApp;
}

// -----------------------------------------------------------------------------
// JWT Test Signer
// -----------------------------------------------------------------------------

export interface TestJwtPayload {
  sub: string;
  email: string;
}

/**
 * Signs a JWT for tests using the same algorithm and secret as production
 * (HS256, `env.JWT_SECRET`). Callers may override `expiresIn` — for example
 * `'-1s'` to produce an immediately-expired token for negative-path tests.
 */
export function signTestToken(
  payload: TestJwtPayload,
  options?: Pick<SignOptions, 'expiresIn'>,
): string {
  const expiresIn: SignOptions['expiresIn'] =
    options?.expiresIn ?? (env.JWT_EXPIRES_IN as SignOptions['expiresIn']);
  const signOptions: SignOptions = { algorithm: 'HS256', expiresIn };
  return jwt.sign({ sub: payload.sub, email: payload.email }, env.JWT_SECRET, signOptions);
}

// -----------------------------------------------------------------------------
// User Helpers (Rule 4 — via POST /api/auth/register)
// -----------------------------------------------------------------------------

export interface RegisteredUser {
  token: string;
  user: User;
}

export interface RegisterUserInput {
  email?: string;
  password?: string;
  displayName?: string;
}

/**
 * Rule 4 compliance: creates a user by POSTing to `/api/auth/register` via
 * supertest. This is the only path used to create test users — Prisma user
 * inserts are forbidden here. Unique defaults avoid collisions across parallel
 * suites.
 */
export async function registerUser(input: RegisterUserInput = {}): Promise<RegisteredUser> {
  const app = createTestApp();
  const body = {
    email: input.email ?? uniqueEmail(),
    password: input.password ?? 'StrongPassword123!',
    displayName: input.displayName ?? uniqueDisplayName(),
  };
  const response = await request(app).post('/api/auth/register').send(body);
  if (response.status !== 201) {
    throw new Error(
      `registerUser failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as RegisteredUser;
}

// -----------------------------------------------------------------------------
// Channel + DM Helpers
// -----------------------------------------------------------------------------

export interface CreateTestChannelInput {
  token: string;
  isPrivate: boolean;
  name?: string;
  description?: string;
}

/** Creates a channel via `POST /api/channels` and returns the created record. */
export async function createTestChannel(input: CreateTestChannelInput): Promise<Channel> {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/channels')
    .set('Authorization', `Bearer ${input.token}`)
    .send({
      name: input.name ?? uniqueChannelName(),
      description: input.description,
      isPrivate: input.isPrivate,
    });
  if (response.status !== 201) {
    throw new Error(
      `createTestChannel failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as Channel;
}

export interface CreateTestDmInput {
  token: string;
  targetUserId: string;
}

/** Creates (or resolves) a 1:1 DM via `POST /api/dms` and returns the record. */
export async function createTestDm(input: CreateTestDmInput): Promise<DirectMessage> {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/dms')
    .set('Authorization', `Bearer ${input.token}`)
    .send({ targetUserId: input.targetUserId });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      `createTestDm failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as DirectMessage;
}

// -----------------------------------------------------------------------------
// Database Cleanup
// -----------------------------------------------------------------------------

/**
 * Re-export of the Prisma client singleton for tests that need direct reads
 * (e.g. verifying ChannelMember side effects) or non-user seeds (Messages,
 * Reactions). Rule 4 forbids direct User inserts — never call
 * `prismaTest.user.create`.
 */
export const prismaTest = prisma;

/**
 * Database names recognized as dedicated dev/test databases that
 * {@link cleanDatabase} is permitted to wipe.
 */
const SAFE_TEST_DB_NAMES = new Set(['slack_dev', 'slack_test']);

/**
 * Validates that DATABASE_URL points at a dedicated dev/test database before any
 * `deleteMany()` runs. The integration suites share the dev database (`slack_dev`)
 * by design (the trade-off and CI mitigation are documented in
 * /docs/decision-log.md); this guard mirrors {@link assertSafeUploadPath} so a
 * misconfigured DATABASE_URL (e.g. a production database) fails loudly instead of
 * silently truncating its tables. The allow-list admits the recognized dev/test
 * names plus any database whose name contains "test".
 *
 * @throws when DATABASE_URL cannot be parsed or names an unrecognized database.
 */
function assertSafeTestDatabase(databaseUrl: string): void {
  let dbName: string;
  try {
    dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error(
      'Refusing to clean an unparseable DATABASE_URL. Point it at a dedicated ' +
        'dev/test database (e.g. slack_dev or slack_test) before running the suite.',
    );
  }

  const isSafe = SAFE_TEST_DB_NAMES.has(dbName) || /test/i.test(dbName);
  if (!isSafe) {
    throw new Error(
      `Refusing to wipe database "${dbName}": cleanDatabase() only runs against a ` +
        'recognized dev/test database (slack_dev, slack_test, or any name containing ' +
        '"test"). Point DATABASE_URL at a dedicated test database before running the suite.',
    );
  }
}

/**
 * Removes all test data in dependency-safe order, then clears the uploads
 * directory. Intended for a `beforeEach` hook so each test starts clean.
 *
 * The target database is validated by {@link assertSafeTestDatabase} BEFORE any
 * deletion so a misconfigured DATABASE_URL fails loudly rather than truncating an
 * unintended (e.g. production) database.
 *
 * Deletion order (children before parents):
 *   MessageReaction → Message → ChannelMember → Channel →
 *   DMParticipant → DirectMessage → File → User
 */
export async function cleanDatabase(): Promise<void> {
  assertSafeTestDatabase(env.DATABASE_URL);
  await prismaTest.messageReaction.deleteMany();
  await prismaTest.message.deleteMany();
  await prismaTest.channelMember.deleteMany();
  await prismaTest.channel.deleteMany();
  await prismaTest.dMParticipant.deleteMany();
  await prismaTest.directMessage.deleteMany();
  await prismaTest.file.deleteMany();
  await prismaTest.user.deleteMany();

  await clearUploadsDirectory();
}

/**
 * Directory basenames recognized as dedicated upload locations safe to wipe in
 * tests. Any path resolving to one of these names — or any path under the OS
 * temp directory — is treated as a test upload directory.
 */
const SAFE_UPLOAD_DIR_NAMES = new Set(['uploads', 'uploads-test']);

/**
 * Validates that `uploadPath` resolves to a dedicated test uploads directory
 * before any recursive deletion is performed, and returns the resolved absolute
 * path. A misconfigured `FILE_UPLOAD_PATH` (filesystem root, the home directory,
 * the process working / repository root, or any unrecognized directory outside
 * the OS temp dir) throws so the misconfiguration fails loudly instead of
 * deleting unintended files. Rationale and the allow-list trade-off are recorded
 * in /docs/decision-log.md.
 */
function assertSafeUploadPath(uploadPath: string): string {
  const resolved = resolve(uploadPath);
  const tmpRoot = resolve(tmpdir());

  // Never delete the filesystem root, the home directory, or the process CWD
  // (repository root when tests run from a package directory).
  const forbidden = new Set<string>([parse(resolved).root, homedir(), process.cwd()]);

  const underTmp = resolved === tmpRoot || resolved.startsWith(tmpRoot + sep);
  const hasSafeName = SAFE_UPLOAD_DIR_NAMES.has(basename(resolved));

  if (forbidden.has(resolved) || (!underTmp && !hasSafeName)) {
    throw new Error(
      `Refusing to clear unsafe upload path "${resolved}". ` +
        `Set FILE_UPLOAD_PATH to a dedicated test uploads directory ` +
        `(e.g. ./uploads, ./uploads-test, or a path under ${tmpRoot}).`,
    );
  }

  return resolved;
}

/**
 * Removes every entry inside `FILE_UPLOAD_PATH` without deleting the directory
 * itself, so the upload destination always exists for the next test. The path
 * is validated by {@link assertSafeUploadPath} OUTSIDE the try/catch below so a
 * misconfigured path fails loudly rather than being swallowed by the
 * first-run-tolerant error handling.
 */
async function clearUploadsDirectory(): Promise<void> {
  const uploadPath = assertSafeUploadPath(env.FILE_UPLOAD_PATH);
  try {
    await mkdir(uploadPath, { recursive: true });
    const entries = await readdir(uploadPath);
    await Promise.all(
      entries.map((entry) => rm(join(uploadPath, entry), { recursive: true, force: true })),
    );
  } catch {
    // Ignore — the directory may not exist yet on the very first run.
  }
}

// -----------------------------------------------------------------------------
// Redis Cleanup & Re-exports
// -----------------------------------------------------------------------------

/**
 * Re-export the Redis clients for tests (notably socket.test.ts, which wires
 * the Socket.io Redis adapter from `pubClient`/`subClient` and uses
 * `redisClient` for presence assertions and flushing).
 */
export { pubClient, subClient, redisClient };

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

let resourcesClosed = false;

/**
 * Disconnects Prisma and all three Redis clients. Call once from each suite's
 * `afterAll`. Idempotent — repeat calls are no-ops — and forgiving so a
 * teardown error never masks a real test failure.
 */
export async function closeTestResources(): Promise<void> {
  if (resourcesClosed) return;
  resourcesClosed = true;

  await prismaTest.$disconnect().catch(() => undefined);
  await disconnectRedisClients().catch(() => undefined);
}
