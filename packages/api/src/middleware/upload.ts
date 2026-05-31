import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';

import type { RequestHandler } from 'express';
import multer from 'multer';

import { env } from '../config/env.js';

// Ensure the upload destination exists before multer writes the first file.
// `env.FILE_UPLOAD_PATH` defaults to `./uploads`, resolved against the API
// process working directory; a fresh checkout (or a `make clean`) has no such
// directory, so multer's `diskStorage` would throw `ENOENT` on the very first
// `POST /api/files`. Creating it here — at module load, recursively, and
// idempotently — guarantees the directory exists for every entry point (the
// server bootstrap and the Jest/supertest suites alike) regardless of the
// configured path. Rationale recorded in /docs/decision-log.md.
mkdirSync(env.FILE_UPLOAD_PATH, { recursive: true });

/**
 * Multer disk-storage configuration.
 *
 * - `destination` is the directory where uploaded files are written
 *   (`env.FILE_UPLOAD_PATH`, default `./uploads`). Express also serves
 *   this directory statically so attachments can be downloaded.
 * - `filename` produces a cryptographically random, collision-free name
 *   that preserves the original file's extension so MIME sniffing and
 *   download Content-Type negotiation work correctly. The original
 *   filename is NOT used directly to prevent path-traversal attacks and
 *   to satisfy the `File.storedName @unique` constraint in the Prisma
 *   schema.
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, env.FILE_UPLOAD_PATH);
  },
  filename: (_req, file, cb) => {
    cb(null, `${randomUUID()}${extname(file.originalname)}`);
  },
});

/**
 * Multer instance enforcing the `MAX_FILE_SIZE_MB` attachment cap.
 *
 * The cap is INCLUSIVE: a file of exactly `MAX_FILE_SIZE_MB` MB is accepted and
 * only a strictly larger file is rejected. multer delegates to busboy, whose
 * stream limit fires the moment the byte count REACHES `limits.fileSize`, so the
 * limit is set one byte above the cap (`… * 1024 * 1024 + 1`) to make the cap
 * itself pass while a file one byte over trips the guard. (Rationale and the
 * boundary trade-off are recorded in /docs/decision-log.md.)
 *
 * When a client exceeds the limit, multer forwards a `MulterError` with
 * `code === 'LIMIT_FILE_SIZE'` to `next()`; the centralized `errorHandler`
 * middleware maps that to a 413 Payload Too Large response. The files service
 * (`createFile`) re-checks `size > MAX_FILE_SIZE_BYTES` as defense-in-depth, a
 * comparison consistent with this inclusive cap.
 */
const uploader = multer({
  storage,
  limits: {
    fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 + 1,
  },
});

/**
 * Express middleware that accepts EXACTLY ONE file uploaded under the
 * multipart field name `file`. On success, multer attaches the file
 * descriptor to `req.file` (the `Express.Multer.File` shape).
 *
 * Consumed by `packages/api/src/routes/files.ts` on `POST /api/files`,
 * which then persists the file metadata via
 * `packages/api/src/services/files.service.ts` and returns the
 * resulting `File` record.
 */
export const uploadMiddleware: RequestHandler = uploader.single('file');
