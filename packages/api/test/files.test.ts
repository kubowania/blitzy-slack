/**
 * @file packages/api/test/files.test.ts
 *
 * Jest + supertest integration tests for the file routes (2 endpoints):
 *   - POST /api/files   (multipart upload, single field `file`)
 *   - GET  /api/files/:id (ACL-gated download)
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             supertest's `any` `response.body` is narrowed with a single
 *             whole-object assertion per response so the `no-unsafe-*` rules stay
 *             satisfied even though the test override only relaxes `no-explicit-any`).
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts.
 *   Gate 9  — File upload completes in under 5 seconds.
 *   Gate 12 — Multer + Zod validation (oversized -> 413, missing file -> 400).
 *   Gate 13 — Contributes coverage to `services/files.service.ts`.
 *
 * AAP refs: §0.1.1 (10 MB cap), §0.4.4 (File model), §0.6.2 (multer disk storage),
 *           §0.8.4 (File contract: one file per message).
 *
 * Behavioral contract (verified against the implemented route/middleware/service):
 *   - POST /api/files returns 201 with the `FileAttachment` DTO as JSON; the
 *     `storedName` is a random UUID-based name that preserves the original
 *     extension, while `originalName` is preserved verbatim.
 *   - Oversize uploads surface multer's `LIMIT_FILE_SIZE` MulterError, which the
 *     centralized error handler maps to 413 with `code: 'LIMIT_FILE_SIZE'`; an
 *     absent `file` field yields a 400 ValidationError. No File row is persisted
 *     on either failure.
 *   - GET /api/files/:id STREAMS the raw bytes (`res.sendFile`) with the persisted
 *     MIME type as Content-Type; access is granted to the uploader OR a member of
 *     a channel / participant of a DM whose message references the file, else 403;
 *     an unknown (but well-formed cuid) id yields 404.
 *
 * Rationale for the non-trivial test decisions (binary-stream assertion strategy,
 * Buffer fixtures over on-disk files, the wrong-field-name tolerance) lives in
 * /docs/decision-log.md per the Explainability rule, not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type { FileAttachment } from '@app/shared/types/message';
import { MAX_FILE_SIZE_MB, MAX_FILE_SIZE_BYTES } from '@app/shared/constants/limits';

import { createFile, type UploadedMulterFile } from '../src/services/files.service.js';
import { ForbiddenError } from '../src/middleware/errors.js';
import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  createTestChannel,
  createTestDm,
  prismaTest,
  tinyPngBuffer,
  oversizedBuffer,
} from './setup.js';

/**
 * Minimal shape of the centralized error envelope (`middleware/error-handler.ts`)
 * used to narrow supertest's `any` body on failure responses without an unsafe
 * member access. `code` is present only for the error classes that attach one
 * (e.g. multer's `LIMIT_FILE_SIZE`).
 */
interface ErrorResponseBody {
  error: string;
  message: string;
  code?: string;
}

describe('POST /api/files, GET /api/files/:id', () => {
  let app: Application;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  // ---------------------------------------------------------------------------
  // POST /api/files — happy path
  // ---------------------------------------------------------------------------
  describe('POST /api/files — happy path', () => {
    it('uploads a small PNG and returns a FileAttachment record', async () => {
      const { token, user } = await registerUser();

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tinyPngBuffer(), { filename: 'pixel.png', contentType: 'image/png' })
        .expect(201);

      const body = response.body as FileAttachment;
      expect(typeof body.id).toBe('string');
      expect(body.originalName).toBe('pixel.png');
      expect(typeof body.storedName).toBe('string');
      expect(body.mimeType).toBe('image/png');
      expect(body.sizeBytes).toBe(tinyPngBuffer().byteLength);
      expect(body.uploadedById).toBe(user.id);
      expect(typeof body.createdAt).toBe('string');
      // storedName is a randomized UUID-based name — never the original filename...
      expect(body.storedName).not.toBe('pixel.png');
      // ...but it preserves the original extension for MIME negotiation on download.
      expect(body.storedName).toMatch(/\.png$/);
      // FileAttachment always carries a download url for the web client.
      expect(typeof body.url).toBe('string');
      expect(body.url.length).toBeGreaterThan(0);
    });

    it('uploads a text file and tracks the correct MIME type', async () => {
      const { token } = await registerUser();
      const txtBuffer = Buffer.from('hello world\n', 'utf-8');

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', txtBuffer, { filename: 'note.txt', contentType: 'text/plain' })
        .expect(201);

      const body = response.body as FileAttachment;
      expect(body.originalName).toBe('note.txt');
      expect(body.mimeType).toBe('text/plain');
      expect(body.sizeBytes).toBe(txtBuffer.byteLength);
      expect(body.storedName).toMatch(/\.txt$/);
    });

    it('preserves the original filename and randomizes the stored name', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tinyPngBuffer(), { filename: 'my-photo.png', contentType: 'image/png' })
        .expect(201);

      const body = response.body as FileAttachment;
      expect(body.originalName).toBe('my-photo.png');
      // storedName === `${randomUUID()}.png` — hex digits and hyphens, .png preserved.
      expect(body.storedName).toMatch(/^[0-9a-f-]+\.png$/);
    });

    it('persists the File row to the database', async () => {
      const { token, user } = await registerUser();

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tinyPngBuffer(), { filename: 'test.png', contentType: 'image/png' })
        .expect(201);

      const body = response.body as FileAttachment;
      const dbFile = await prismaTest.file.findUnique({ where: { id: body.id } });
      expect(dbFile).not.toBeNull();
      expect(dbFile?.uploadedById).toBe(user.id);
      expect(dbFile?.originalName).toBe('test.png');
      expect(dbFile?.storedName).toBe(body.storedName);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/files — MAX_FILE_SIZE_MB enforcement (Gate 12, AAP §0.1.1)
  // ---------------------------------------------------------------------------
  describe('POST /api/files — MAX_FILE_SIZE_MB enforcement', () => {
    it('derives the byte cap from MAX_FILE_SIZE_MB (10 MB contract)', () => {
      // Documents the shared 10 MB contract the web client also enforces fail-fast.
      expect(MAX_FILE_SIZE_BYTES).toBe(MAX_FILE_SIZE_MB * 1024 * 1024);
    });

    it('rejects a file exceeding the cap with 413 and persists no row', async () => {
      const { token } = await registerUser();
      const oversized = oversizedBuffer();
      expect(oversized.byteLength).toBeGreaterThan(MAX_FILE_SIZE_BYTES);

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', oversized, {
          filename: 'big.bin',
          contentType: 'application/octet-stream',
        })
        .expect(413);

      const body = response.body as ErrorResponseBody;
      expect(typeof body.error).toBe('string');
      expect(typeof body.message).toBe('string');
      // error-handler maps the multer LIMIT_FILE_SIZE MulterError to this code.
      expect(body.code).toBe('LIMIT_FILE_SIZE');

      // The route handler never runs on an oversize upload, so nothing is saved.
      const filesCount = await prismaTest.file.count();
      expect(filesCount).toBe(0);
    });

    it('accepts a file exactly at the byte cap (10 MB, inclusive)', async () => {
      const { token } = await registerUser();
      // INCLUSIVE-CAP CONTRACT: a file whose size EQUALS MAX_FILE_SIZE_BYTES must
      // succeed. multer's busboy guard trips when the stream size REACHES
      // `limits.fileSize`, so the middleware configures the limit at
      // MAX_FILE_SIZE_BYTES + 1 (see middleware/upload.ts). The service layer then
      // enforces the true cap with a strict `size > maxBytes` check, making exactly
      // 10 MB the largest accepted upload. See /docs/decision-log.md for the
      // boundary rationale (supersedes the earlier exclusive-cap decision).
      const atCap = Buffer.alloc(MAX_FILE_SIZE_BYTES);

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', atCap, {
          filename: 'at-cap.bin',
          contentType: 'application/octet-stream',
        })
        .expect(201);

      const body = response.body as FileAttachment;
      expect(body.sizeBytes).toBe(MAX_FILE_SIZE_BYTES);

      // The at-cap upload is persisted exactly once.
      const dbFile = await prismaTest.file.findUnique({ where: { id: body.id } });
      expect(dbFile?.sizeBytes).toBe(MAX_FILE_SIZE_BYTES);
    });

    it('accepts the largest file below the cap (one byte under)', async () => {
      const { token } = await registerUser();
      // Sanity check on the under-cap side of the boundary: a file one byte below
      // the cap is always accepted.
      const justUnder = Buffer.alloc(MAX_FILE_SIZE_BYTES - 1);

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', justUnder, {
          filename: 'just-under.bin',
          contentType: 'application/octet-stream',
        })
        .expect(201);

      const body = response.body as FileAttachment;
      expect(body.sizeBytes).toBe(MAX_FILE_SIZE_BYTES - 1);
    });

    it('rejects a file one byte over the cap (MAX + 1) with 413', async () => {
      const { token } = await registerUser();
      // EXCLUSIVE on the over-cap side: a file of MAX_FILE_SIZE_BYTES + 1 is the
      // smallest rejected upload, tripping multer's LIMIT_FILE_SIZE guard.
      const oneOver = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', oneOver, {
          filename: 'one-over.bin',
          contentType: 'application/octet-stream',
        })
        .expect(413);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('LIMIT_FILE_SIZE');

      const filesCount = await prismaTest.file.count();
      expect(filesCount).toBe(0);
    });

    it('rejects an oversize file at the service layer (defense-in-depth guard)', async () => {
      // The multer middleware rejects oversize uploads before the route handler
      // runs, so the service's own `size > maxBytes` guard is a second line of
      // defense (e.g. for a future non-HTTP caller). Drive the service directly
      // with a descriptor one byte over the cap to assert the guard throws a
      // ForbiddenError BEFORE any File row is written.
      const { user } = await registerUser();
      const oversize: UploadedMulterFile = {
        originalname: 'oversize.bin',
        filename: 'stored-oversize.bin',
        mimetype: 'application/octet-stream',
        size: MAX_FILE_SIZE_BYTES + 1,
      };

      await expect(
        createFile({ multerFile: oversize, uploadedById: user.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // The guard short-circuits before the Prisma insert, so nothing persists.
      const filesAfter = await prismaTest.file.count();
      expect(filesAfter).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/files — bad requests (Gate 12)
  // ---------------------------------------------------------------------------
  describe('POST /api/files — bad requests', () => {
    it('returns 400 when no file is attached', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(typeof body.message).toBe('string');
    });

    it('rejects an upload sent under the wrong field name', async () => {
      const { token } = await registerUser();

      // multer.single('file') rejects an unexpected field with LIMIT_UNEXPECTED_FILE;
      // the error handler maps non-size MulterErrors to 400 (500 tolerated if a future
      // refactor lets it bubble). Either way the upload MUST NOT succeed.
      const response = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('attachment', tinyPngBuffer(), {
          filename: 'wrong-field.png',
          contentType: 'image/png',
        });

      expect([400, 500]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/files — authentication
  // ---------------------------------------------------------------------------
  describe('POST /api/files — authentication', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app)
        .post('/api/files')
        .attach('file', tinyPngBuffer(), { filename: 'unauth.png', contentType: 'image/png' })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/files/:id — uploader access
  // ---------------------------------------------------------------------------
  describe('GET /api/files/:id — uploader access', () => {
    it('returns 401 without an Authorization header', async () => {
      // requireAuth runs before the cuid param validator, so the id value is moot.
      await request(app).get('/api/files/clxnonexistent00000000000').expect(401);
    });

    it('lets the uploader download their own file as a binary stream', async () => {
      const { token } = await registerUser();

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tinyPngBuffer(), { filename: 'own.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      const downloadResponse = await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${token}`)
        // Force superagent to buffer the binary body into a Buffer (Node 'blob').
        .responseType('blob')
        .expect(200);

      // The route streams the raw bytes with the persisted MIME type (res.sendFile).
      expect(downloadResponse.get('content-type')).toMatch(/image\/png/);
      const downloadBody = downloadResponse.body as Buffer;
      expect(Buffer.isBuffer(downloadBody)).toBe(true);
      expect(downloadBody.byteLength).toBeGreaterThan(0);
    });

    it('returns 404 for an unknown (but well-formed) file id', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/files/clxnonexistent00000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/files/:id — ACL via channel membership
  // ---------------------------------------------------------------------------
  describe('GET /api/files/:id — ACL via channel membership', () => {
    it('allows a member to download a file attached to a channel message', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: false });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', tinyPngBuffer(), { filename: 'shared.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      // Seed the file<->message linkage directly (the ACL precondition under test);
      // see /docs/decision-log.md for the rationale.
      await prismaTest.message.create({
        data: {
          content: 'with file',
          authorId: owner.id,
          channelId: channel.id,
          fileId: uploaded.id,
          parentId: null,
        },
      });

      // A different user joins the (public) channel...
      const { token: joinerToken } = await registerUser();
      await request(app)
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);

      // ...and is therefore granted download access via channel membership.
      await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);
    });

    it('returns 403 for a private-channel file when the caller is not a member', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', tinyPngBuffer(), { filename: 'secret.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      // Seed the file<->message linkage directly (the ACL precondition under test);
      // see /docs/decision-log.md for the rationale.
      await prismaTest.message.create({
        data: {
          content: 'private file',
          authorId: owner.id,
          channelId: channel.id,
          fileId: uploaded.id,
          parentId: null,
        },
      });

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    });

    it('returns 403 for an unlinked file requested by a different user', async () => {
      const { token: ownerToken } = await registerUser();

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', tinyPngBuffer(), { filename: 'orphan.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      // The file is never attached to any message, so only the uploader may read it.
      const { token: strangerToken } = await registerUser();
      await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/files/:id — ACL via DM participation
  // ---------------------------------------------------------------------------
  describe('GET /api/files/:id — ACL via DM participation', () => {
    it('allows a DM participant to download a file attached to a DM message', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { token: bobToken, user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', tinyPngBuffer(), { filename: 'dm-pic.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      // Seed the file<->message linkage directly (the ACL precondition under test);
      // see /docs/decision-log.md for the rationale.
      await prismaTest.message.create({
        data: {
          content: 'sent via DM',
          authorId: alice.id,
          dmId: dm.id,
          fileId: uploaded.id,
          parentId: null,
        },
      });

      // Bob is the other participant -> granted download access via DM participation.
      await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
    });

    it('returns 403 when the caller is not a DM participant', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', tinyPngBuffer(), { filename: 'private-dm.png', contentType: 'image/png' })
        .expect(201);
      const uploaded = uploadResponse.body as FileAttachment;

      // Seed the file<->message linkage directly (the ACL precondition under test);
      // see /docs/decision-log.md for the rationale.
      await prismaTest.message.create({
        data: {
          content: 'DM only',
          authorId: alice.id,
          dmId: dm.id,
          fileId: uploaded.id,
          parentId: null,
        },
      });

      // Carol is a third user, not part of the alice<->bob DM.
      const { token: carolToken } = await registerUser();
      await request(app)
        .get(`/api/files/${uploaded.id}`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/files — upload performance (Gate 9)
  // ---------------------------------------------------------------------------
  describe('POST /api/files — upload performance (Gate 9)', () => {
    it('uploads a 1 MB file in under 5 seconds', async () => {
      const { token } = await registerUser();
      const oneMegabyte = Buffer.alloc(1024 * 1024, 0xff);

      const start = Date.now();
      await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', oneMegabyte, {
          filename: '1mb.bin',
          contentType: 'application/octet-stream',
        })
        .expect(201);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(5000);
    });
  });
});
