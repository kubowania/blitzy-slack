/**
 * @file packages/api/test/auth.test.ts
 *
 * Jest + supertest integration tests for the authentication endpoints:
 *   - POST /api/auth/register
 *   - POST /api/auth/login
 *   - GET  /api/auth/me
 *
 * The suite exercises the real route → service → Prisma flow (no mocks of
 * bcrypt, jsonwebtoken, or Prisma) against the running Postgres + Redis
 * infrastructure, asserting status codes, response bodies, headers, and the
 * security invariants of the authentication contract.
 *
 * Per AAP §0.8.1 Rule 4, the seed user (`admin@test.com` / `Password12345!`)
 * is created via the registration endpoint, never via a direct database INSERT.
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript; no `@ts-ignore` / `@ts-expect-error`,
 *             no `as any`. Supertest's untyped `body` is narrowed with a single
 *             whole-object cast to a local interface, then read through typed
 *             property access (the `no-unsafe-*` rules stay on for test files).
 *   Rule 4  — The registration endpoint is the only user-creation path; the seed
 *             credentials register once (201) and are idempotent on repeat (409).
 *   Gate 9  — Registration completes within a generous response-time budget.
 *   Gate 10 — Every response carries the Pino-generated `X-Request-Id` header.
 *   Gate 12 — Malformed payloads are rejected with 400 and a structured error body.
 *   Gate 13 — Contributes line coverage to `src/services/auth.service.ts`.
 *
 * Behavioral contract verified against the IMPLEMENTED route/service
 * (`src/routes/auth.ts`, `src/services/auth.service.ts`,
 * `src/middleware/{auth,validate,error-handler,request-logger}.ts`), NOT the
 * assigned-file prompt's illustrative sketch. The verified differences — the
 * `validate` middleware wraps Zod failures so a 400 body carries a
 * `details` field→messages MAP (`{ email: ['Required'] }`), not a
 * `[{ path, message, code }]` array; `.strict()` unknown-key violations surface
 * as a 400 with an empty `details` map (the unrecognized-key message is a
 * form-level error the field map omits); a JWT for a deleted account yields 404
 * (`NotFoundError`), not 401; and the login endpoint returns one uniform 401
 * message for both unknown-email and wrong-password — are recorded in
 * /docs/decision-log.md per the Explainability rule (AAP §0.8.3), not in these
 * comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type { User } from '@app/shared/types/user';
import { MAX_DISPLAY_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  signTestToken,
  closeTestResources,
  SEED_EMAIL,
  SEED_PASSWORD,
  uniqueEmail,
  uniqueDisplayName,
} from './setup.js';

// ---------------------------------------------------------------------------
// Local response shapes
//
// Supertest types `response.body` as `any`. Per Rule 3 the `no-unsafe-*` rules
// remain enabled for test files, so each body is narrowed with ONE whole-object
// cast to a local interface and then read through typed property access. These
// shapes mirror the service-layer DTOs (`AuthResult`, `UserResponse`) and the
// centralized error envelope without importing server-internal types.
// ---------------------------------------------------------------------------

/**
 * Account-owner self view as serialized to the network: the shared `User`
 * shape with `passwordHash` omitted. Mirrors the service-layer `UserResponse`;
 * declared via `Omit` so the privacy contract (no `passwordHash` on the wire)
 * is expressed in the type itself.
 */
type SafeUser = Omit<User, 'passwordHash'>;

/**
 * Success envelope returned by `POST /api/auth/register` (201) and
 * `POST /api/auth/login` (200): a signed JWT plus the account-owner self view.
 */
interface AuthSuccessBody {
  token: string;
  user: SafeUser;
}

/**
 * Minimal shape of the centralized error envelope produced by
 * `middleware/error-handler.ts`. `details` is the field→messages map the
 * `validate` middleware builds from `ZodError.flatten().fieldErrors` for 400
 * validation failures; `code` carries the typed classification for some errors
 * (e.g. `token_expired`, `token_invalid`, `P2002`).
 */
interface ErrorResponseBody {
  error: string;
  message: string;
  code?: string;
  details?: Record<string, string[] | undefined>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A password comfortably above `MIN_PASSWORD_LENGTH`, reused on happy paths. */
const STRONG_PASSWORD = 'StrongPassword123!';

/** A JWT is three base64url segments separated by dots. */
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** UUID v4 shape emitted by `request-logger.ts` as the `X-Request-Id` header. */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Auth routes — POST /api/auth/register, POST /api/auth/login, GET /api/auth/me', () => {
  let app: Application;

  beforeAll(() => {
    // createTestApp() builds the production Express app once (no port is opened;
    // supertest binds to the app object per request).
    app = createTestApp();
  });

  beforeEach(async () => {
    // Per-test isolation: every test starts against an empty User table so
    // failures stay localized and order-independent.
    await cleanDatabase();
  });

  afterAll(async () => {
    // Disconnect the shared Prisma + Redis clients exactly once for the suite.
    await closeTestResources();
  });

  // =========================================================================
  // POST /api/auth/register
  // =========================================================================
  describe('POST /api/auth/register — happy path', () => {
    it('creates a new user with a 201 response and returns { token, user }', async () => {
      const email = uniqueEmail();
      const displayName = uniqueDisplayName();

      const response = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName })
        .expect(201);

      const body = response.body as AuthSuccessBody;
      // Identity fields echo the request (email/displayName) and are populated
      // by the database (a non-empty id and ISO timestamps); avatarUrl defaults
      // to null when unset. Typed property access keeps the `no-unsafe-*` rules
      // satisfied (the body was narrowed to AuthSuccessBody above).
      expect(typeof body.user.id).toBe('string');
      expect(body.user.id.length).toBeGreaterThan(0);
      expect(body.user.email).toBe(email);
      expect(body.user.displayName).toBe(displayName);
      expect(body.user.avatarUrl).toBeNull();
      expect(typeof body.user.createdAt).toBe('string');
      expect(typeof body.user.updatedAt).toBe('string');
      // The issued JWT is a well-formed three-segment token...
      expect(body.token).toMatch(JWT_FORMAT);
      // ...and the password hash is never returned.
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    it('trims surrounding whitespace from email and displayName before persisting', async () => {
      const email = uniqueEmail();

      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: `  ${email}  `, password: STRONG_PASSWORD, displayName: '  Alice  ' })
        .expect(201);

      const body = response.body as AuthSuccessBody;
      expect(body.user.email).toBe(email);
      expect(body.user.displayName).toBe('Alice');
    });

    it('preserves whitespace within the password (password-manager compatibility)', async () => {
      // registerSchema trims email and displayName but NOT password, so an
      // internal space is part of the credential and must survive round-trip.
      const passwordWithSpaces = 'Strong Password 123!';
      const email = uniqueEmail();

      await request(app)
        .post('/api/auth/register')
        .send({ email, password: passwordWithSpaces, displayName: uniqueDisplayName() })
        .expect(201);

      // Subsequent login with the exact same spaced password must succeed.
      await request(app)
        .post('/api/auth/login')
        .send({ email, password: passwordWithSpaces })
        .expect(200);
    });
  });

  describe('POST /api/auth/register — Rule 4 seed user', () => {
    it('creates the seed user admin@test.com with password Password12345!', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD, displayName: 'Admin' })
        .expect(201);

      const body = response.body as AuthSuccessBody;
      expect(body.user.email).toBe(SEED_EMAIL);
      expect(body.user.displayName).toBe('Admin');
    });

    it('returns 409 Conflict when the seed credentials are registered twice (Rule 4 idempotency)', async () => {
      // First registration succeeds.
      await request(app)
        .post('/api/auth/register')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD, displayName: 'Admin' })
        .expect(201);

      // The duplicate email surfaces Prisma's P2002 UNWRAPPED → the centralized
      // error handler maps it to 409, which the seed flow treats as success.
      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD, displayName: 'Admin' })
        .expect(409);

      const body = response.body as ErrorResponseBody;
      expect(typeof body.error).toBe('string');
      expect(typeof body.message).toBe('string');
    });
  });

  describe('POST /api/auth/register — Gate 12 validation', () => {
    it('rejects a missing email with 400 and a field-level details map', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({ password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(typeof body.error).toBe('string');
      expect(typeof body.message).toBe('string');
      expect(body.details).toBeDefined();
      expect(body.details).toHaveProperty('email');
    });

    it('rejects a malformed email with 400', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'not-an-email',
          password: STRONG_PASSWORD,
          displayName: uniqueDisplayName(),
        })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.details).toHaveProperty('email');
    });

    it('rejects a password shorter than MIN_PASSWORD_LENGTH (8) with 400', async () => {
      const tooShort = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);

      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: tooShort, displayName: uniqueDisplayName() })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.details).toHaveProperty('password');
    });

    it('rejects a displayName exceeding MAX_DISPLAY_NAME_LENGTH (80) with 400', async () => {
      const tooLong = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);

      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: tooLong })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.details).toHaveProperty('displayName');
    });

    it('rejects an empty displayName with 400', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: '' })
        .expect(400);
    });

    it('rejects unknown fields per the .strict() schema (prototype-pollution defense) with 400', async () => {
      // `.strict()` rejects unrecognized keys; the violation is a form-level
      // error, so the field→messages `details` map is empty — only the 400
      // status is contractually firm here.
      await request(app)
        .post('/api/auth/register')
        .send({
          email: uniqueEmail(),
          password: STRONG_PASSWORD,
          displayName: uniqueDisplayName(),
          isAdmin: true,
          passwordHash: 'pwned',
        })
        .expect(400);
    });

    it('rejects an entirely missing body with 400', async () => {
      await request(app).post('/api/auth/register').send({}).expect(400);
    });
  });

  describe('POST /api/auth/register — Gate 9 performance', () => {
    it('completes registration within 2 seconds (generous budget)', async () => {
      const start = Date.now();

      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      const elapsedMs = Date.now() - start;
      // bcrypt cost 10 + a single Postgres insert is comfortably under 2s.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  // =========================================================================
  // POST /api/auth/login
  // =========================================================================
  describe('POST /api/auth/login — happy path', () => {
    it('logs in a registered user and returns { token, user }', async () => {
      const email = uniqueEmail();
      const displayName = uniqueDisplayName();

      await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName })
        .expect(201);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email, password: STRONG_PASSWORD })
        .expect(200);

      const body = response.body as AuthSuccessBody;
      expect(body.token).toMatch(JWT_FORMAT);
      expect(body.user).toMatchObject({ email, displayName });
      expect(body.user).not.toHaveProperty('passwordHash');
    });
  });

  describe('POST /api/auth/login — uniform 401 errors', () => {
    it('returns 401 with the uniform message for an unknown email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'unknown@example.com', password: 'anything' })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/invalid email or password/i);
    });

    it('returns 401 with the uniform message for a wrong password', async () => {
      const email = uniqueEmail();
      await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword!' })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/invalid email or password/i);
    });

    it('does not reveal whether an email exists (identical message for unknown email vs wrong password)', async () => {
      const email = uniqueEmail();
      await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword!' })
        .expect(401);
      const unknownEmail = await request(app)
        .post('/api/auth/login')
        .send({ email: 'unknown@example.com', password: 'WrongPassword!' })
        .expect(401);

      const wrongPasswordBody = wrongPassword.body as ErrorResponseBody;
      const unknownEmailBody = unknownEmail.body as ErrorResponseBody;
      // Byte-identical messages prevent account-existence enumeration.
      expect(wrongPasswordBody.message).toBe(unknownEmailBody.message);
    });
  });

  describe('POST /api/auth/login — Gate 12 validation', () => {
    it('rejects a missing email with 400', async () => {
      await request(app).post('/api/auth/login').send({ password: 'anything' }).expect(400);
    });

    it('rejects a malformed email with 400', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'invalid', password: 'anything' })
        .expect(400);
    });

    it('rejects an empty password with 400 (loginSchema enforces min(1))', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'user@example.com', password: '' })
        .expect(400);
    });

    it('rejects unknown fields per the .strict() schema with 400', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'user@example.com', password: 'anything', remember: true })
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/auth/me
  // =========================================================================
  describe('GET /api/auth/me — happy path', () => {
    it('returns the current authenticated user', async () => {
      const email = uniqueEmail();
      const displayName = uniqueDisplayName();

      const registerResponse = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName })
        .expect(201);
      const registered = registerResponse.body as AuthSuccessBody;

      const meResponse = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      const me = meResponse.body as SafeUser;
      expect(me).toMatchObject({ id: registered.user.id, email, displayName });
      expect(me).not.toHaveProperty('passwordHash');
    });

    it('accepts a token generated by the signTestToken helper', async () => {
      const email = uniqueEmail();
      const registerResponse = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);
      const registered = registerResponse.body as AuthSuccessBody;

      // signTestToken signs with the same secret + HS256 algorithm as production,
      // proving the route accepts any validly-signed token, not only its own.
      const testToken = signTestToken({ sub: registered.user.id, email });

      const meResponse = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      const me = meResponse.body as SafeUser;
      expect(me.id).toBe(registered.user.id);
    });
  });

  describe('GET /api/auth/me — JWT failure modes', () => {
    it('returns 401 when the Authorization header is missing', async () => {
      const response = await request(app).get('/api/auth/me').expect(401);
      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/missing or malformed authorization header/i);
    });

    it('returns 401 when the Authorization header lacks the Bearer prefix', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'NotBearer xyz')
        .expect(401);
      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/missing or malformed authorization header/i);
    });

    it('returns 401 with code token_invalid for a malformed JWT', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not.a.valid.jwt')
        .expect(401);
      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/invalid/i);
      expect(body.code).toBe('token_invalid');
    });

    it('returns 401 with code token_expired for an expired JWT', async () => {
      // A negative duration yields an immediately-expired token (no sleep needed).
      const expiredToken = signTestToken(
        { sub: 'clexpireduser000000000000', email: 'expired@example.com' },
        { expiresIn: '-1s' },
      );

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);
      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/expired/i);
      expect(body.code).toBe('token_expired');
    });

    it('returns 404 when the JWT references a deleted user', async () => {
      // A structurally valid, correctly-signed token whose subject resolves to
      // no User row: getCurrentUser throws NotFoundError → 404.
      const ghostToken = signTestToken({
        sub: 'clghostuser00000000000000',
        email: 'ghost@example.com',
      });

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${ghostToken}`)
        .expect(404);
      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/not found/i);
    });
  });

  // =========================================================================
  // Cross-cutting concerns
  // =========================================================================
  describe('Security — passwordHash is never exposed', () => {
    it('does not expose passwordHash in the register response', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      const body = response.body as AuthSuccessBody;
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/passwordHash/);
      // Defensively confirm no bcrypt hash ($2a$ / $2b$ / $2y$) leaked either.
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    });

    it('does not expose passwordHash in the login response', async () => {
      const email = uniqueEmail();
      await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email, password: STRONG_PASSWORD })
        .expect(200);

      const body = response.body as AuthSuccessBody;
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/passwordHash/);
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    });

    it('does not expose passwordHash in the me response', async () => {
      const registerResponse = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);
      const registered = registerResponse.body as AuthSuccessBody;

      const meResponse = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200);

      const me = meResponse.body as SafeUser;
      const serialized = JSON.stringify(me);
      expect(serialized).not.toMatch(/passwordHash/);
      expect(serialized).not.toMatch(/\$2[aby]\$/);
    });
  });

  describe('Response headers', () => {
    it('returns application/json for a register success', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201)
        .expect('Content-Type', /application\/json/);
    });

    it('returns application/json for a validation error', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({})
        .expect(400)
        .expect('Content-Type', /application\/json/);
    });

    it('exposes an X-Request-Id header on POST /api/auth/register (Gate 10 — Pino reqId)', async () => {
      // request-logger.ts generates a UUID v4 per request and echoes it back.
      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201)
        .expect('X-Request-Id', UUID_FORMAT);
    });

    it('exposes an X-Request-Id header on POST /api/auth/login (Gate 10 — Pino reqId)', async () => {
      // The reqId middleware runs for every route, so login responses carry the
      // same UUID v4 header. Register first so the credentials exist.
      const email = uniqueEmail();
      await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);

      await request(app)
        .post('/api/auth/login')
        .send({ email, password: STRONG_PASSWORD })
        .expect(200)
        .expect('X-Request-Id', UUID_FORMAT);
    });

    it('exposes an X-Request-Id header on GET /api/auth/me (Gate 10 — Pino reqId)', async () => {
      // Authenticated GET requests are logged with the same reqId contract.
      const registerResponse = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail(), password: STRONG_PASSWORD, displayName: uniqueDisplayName() })
        .expect(201);
      const registered = registerResponse.body as AuthSuccessBody;

      await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${registered.token}`)
        .expect(200)
        .expect('X-Request-Id', UUID_FORMAT);
    });
  });
});
