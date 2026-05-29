import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import type { RequestHandler } from 'express';
import multer from 'multer';

import { env } from '../config/env.js';

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
 * Multer instance with the `MAX_FILE_SIZE_MB` cap converted to bytes.
 *
 * When a client exceeds the limit, multer throws a `MulterError` with
 * `code === 'LIMIT_FILE_SIZE'` synchronously to `next()`; the centralized
 * `errorHandler` middleware maps that to a 413 Payload Too Large
 * response with a clear message.
 */
const uploader = multer({
  storage,
  limits: {
    fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
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
