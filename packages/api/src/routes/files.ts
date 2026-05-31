/**
 * @app/api — File upload & download routes (AUTH REQUIRED).
 *
 * POST /api/files       — multipart upload (single field `file`, capped at
 *                         MAX_FILE_SIZE_MB by the upload middleware); persists
 *                         File metadata and returns the FileAttachment DTO.
 * GET  /api/files/:id   — ACL-filtered download, streamed via `res.sendFile`.
 *
 * NO Socket.io emissions — a File row is metadata only. Real-time notification
 * happens when a message that references the file (`Message.fileId`) is sent
 * via routes/messages.ts, whose MESSAGE_NEW event carries the FileAttachment.
 *
 * Size enforcement: multer's LIMIT_FILE_SIZE (configured in middleware/upload.ts)
 * surfaces a MulterError that the centralized errorHandler maps to HTTP 413; this
 * route performs no manual size check.
 *
 * ACL enforcement: the GET handler delegates the visibility decision to the file
 * service (caller is the uploader, OR is a member/participant of a conversation
 * whose message references the file). The service throws NotFoundError (→404) or
 * ForbiddenError (→403); the errorHandler renders the standard error envelope.
 *
 * (Rationale and trade-offs for the choices below — `inline` disposition, the
 * ValidationError path, and the sendFile error response — live in
 * /docs/decision-log.md per the Explainability rule, not in these comments.)
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation. That augmentation adds `log: pino.Logger` to `IncomingMessage`
// (which the Express `Request` extends), which is what types `req.log` below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { FileAttachment } from '@app/shared/types/message';

import { requireAuth } from '../middleware/auth.js';
import { uploadMiddleware } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { ValidationError } from '../middleware/errors.js';
import { createFile, getFile } from '../services/files.service.js';

/**
 * Validates the `:id` path parameter on `GET /api/files/:id`. The Prisma `File`
 * model uses cuid identifiers, so the param must be a cuid; `.strict()` rejects
 * any unexpected extra params on the route.
 */
const fileIdParamsSchema = z.object({ id: z.string().cuid() }).strict();

/**
 * Files router, mounted at `/files` by the routes barrel so the effective paths
 * are `/api/files` (POST) and `/api/files/:id` (GET). Exported as `router` to
 * match the barrel convention (`import { router as filesRouter } from './files.js'`).
 */
export const router: Router = Router();

router.post(
  '/',
  requireAuth,
  uploadMiddleware,
  async (req: Request, res: Response<FileAttachment>): Promise<void> => {
    // `requireAuth` guarantees `req.user` is populated before this handler runs;
    // the non-null assertion narrows the optional Request augmentation.
    const uploadedById = req.user!.id;

    // Multer populates `req.file` only when the multipart body carries the
    // single `file` field; an absent field leaves it `undefined` WITHOUT
    // throwing, so the route validates presence and surfaces a ValidationError
    // (which the errorHandler renders as the same 400 envelope as Zod failures).
    if (req.file === undefined) {
      throw new ValidationError('Missing file field "file" in multipart body');
    }

    // Hand the post-write multer metadata to the service, which persists the
    // File row and returns the public DTO (including the download `url`).
    const file = await createFile({
      multerFile: {
        originalname: req.file.originalname,
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
      },
      uploadedById,
    });

    // Gate 10 structured log: identity + non-PII persisted metadata. The
    // user-supplied originalName can embed personal/project information, so it
    // is deliberately omitted (privacy); fileId is the durable correlator and
    // the disk path is internal to the service.
    req.log.info(
      {
        component: 'files.route',
        event: 'upload',
        userId: uploadedById,
        fileId: file.id,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
      },
      'file uploaded',
    );

    res.status(201).json(file);
  },
);

router.get(
  '/:id',
  requireAuth,
  validate({ params: fileIdParamsSchema }),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    // `requireAuth` guarantees `req.user`; `validate` has parsed the cuid param.
    const userId = req.user!.id;
    const fileId = req.params.id;

    // The service enforces ACL and returns the absolute on-disk path. It throws
    // NotFoundError (→404) when the file is unknown and ForbiddenError (→403)
    // when the caller has no access path; both bubble to the errorHandler.
    const { file, diskPath } = await getFile({ fileId, userId });

    // Trust the persisted mimeType (multer assigned it at upload) for the
    // response content type, and preserve the user-meaningful original filename
    // (not the random storedName) in the Content-Disposition header. The name is
    // percent-encoded so special characters do not break the header.
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.originalName)}"`,
    );

    // Stream the file with streaming I/O (no full-file memory load). The
    // callback fires only on a streaming failure — e.g. the on-disk file
    // vanished between the ACL check and the read.
    res.sendFile(diskPath, (err) => {
      if (err !== undefined && err !== null) {
        req.log.error(
          {
            component: 'files.route',
            event: 'download.error',
            userId,
            fileId,
            diskPath,
            err: err.message,
          },
          'failed to stream file from disk',
        );
        // Headers may already be flushed mid-stream; only emit a body when the
        // response has not yet started, to avoid "headers after sent" crashes.
        if (!res.headersSent) {
          res.status(500).json({
            error: 'InternalServerError',
            message: 'Failed to read file from disk',
            code: 'file_read_error',
          });
        }
      }
    });
  },
);
