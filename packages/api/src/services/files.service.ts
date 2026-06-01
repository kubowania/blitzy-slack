/**
 * File service — persist uploaded-file metadata and serve ACL-checked retrieval.
 *
 * Public surface:
 *   createFile({ multerFile, uploadedById })        → FileAttachment
 *   getFile({ fileId, userId })                     → { file: FileAttachment, diskPath: string }
 *
 * Layering and behavioral contract:
 *  - The multer middleware (`middleware/upload.ts`) performs the disk write to
 *    `env.FILE_UPLOAD_PATH` and produces the post-write metadata. THIS service
 *    receives that metadata, persists a `File` DB row, and returns the public
 *    `FileAttachment` DTO. It never writes to or reads from disk itself.
 *  - `getFile` performs an access-control check: the caller must be the uploader
 *    OR a member of a channel / a participant in a DM that contains a `Message`
 *    referencing this file. It returns the absolute `diskPath`; the route handler
 *    streams the bytes via `res.sendFile(diskPath)`. This service NEVER touches
 *    the HTTP response or any Socket.io surface.
 *  - `createFile` re-checks the byte size against `MAX_FILE_SIZE_MB` as a
 *    defense-in-depth measure even though multer's `limits.fileSize` rejects
 *    oversize uploads first.
 */

import { resolve } from 'node:path';

import { prisma } from '@app/db';
import type { File as PrismaFile } from '@app/db';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ForbiddenError, NotFoundError } from '../middleware/errors.js';

import type { FileAttachment } from '@app/shared/types/message';

/**
 * The subset of multer's `Express.Multer.File` shape that this service consumes.
 * Declaring it locally decouples the service from multer's full type surface
 * (the service intentionally does not import multer).
 */
export interface UploadedMulterFile {
  /** Original filename supplied by the client (preserved for display/download). */
  originalname: string;
  /** Server-generated on-disk filename (collision-free; satisfies File.storedName @unique). */
  filename: string;
  /** MIME type detected at upload time (e.g. 'image/png'). */
  mimetype: string;
  /** Byte size of the file saved to disk. */
  size: number;
}

/**
 * Input contract for {@link createFile}. The route layer constructs this
 * after multer has parsed the multipart body, populating `uploadedById` from the
 * authenticated principal.
 */
export interface SaveUploadedFileInput {
  /** Post-write metadata produced by the multer middleware. */
  multerFile: UploadedMulterFile;
  /** Database id of the authenticated uploading user. */
  uploadedById: string;
}

/**
 * Input contract for {@link getFile}. `userId` is the authenticated principal
 * whose access is checked against the file's referencing message (if any).
 */
export interface GetFileInput {
  /** Database id of the file to retrieve. */
  fileId: string;
  /** Database id of the requesting (authenticated) user. */
  userId: string;
}

/**
 * Return shape of {@link getFile}: the public DTO plus the absolute on-disk path
 * the route handler passes to `res.sendFile`.
 */
export interface FileWithDiskPath {
  /** Public file metadata DTO. */
  file: FileAttachment;
  /** Absolute filesystem path; route handler uses this for `res.sendFile`. */
  diskPath: string;
}

/**
 * Project a Prisma `File` record onto the public {@link FileAttachment} DTO.
 *
 * `createdAt` is serialized to an ISO 8601 string for the wire, and `url` is the
 * relative API route (`/api/files/:id`) that the web client prefixes with
 * `VITE_API_URL`; the raw disk path is never exposed.
 */
function toFileDto(record: PrismaFile): FileAttachment {
  return {
    id: record.id,
    originalName: record.originalName,
    storedName: record.storedName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    uploadedById: record.uploadedById,
    createdAt: record.createdAt.toISOString(),
    url: `/api/files/${record.id}`,
  };
}

/**
 * Persist file metadata after multer has written the file to disk.
 *
 * 1. Defensively re-checks the byte size against `MAX_FILE_SIZE_MB`; multer
 *    should have rejected oversize uploads first, so reaching this branch
 *    indicates a middleware misconfiguration and we fail closed.
 * 2. Inserts a `File` row.
 * 3. Returns the {@link FileAttachment} DTO.
 *
 * The file is NOT yet linked to a `Message`; the route layer forwards the
 * returned id to `messages.service.sendMessage`, which sets `Message.fileId`
 * (a `@unique` column, so a file binds to at most one message).
 *
 * @throws {ForbiddenError} when the byte size exceeds the configured cap.
 */
export async function createFile(input: SaveUploadedFileInput): Promise<FileAttachment> {
  const { multerFile, uploadedById } = input;

  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;
  if (multerFile.size > maxBytes) {
    logger.warn({ uploadedById, size: multerFile.size, maxBytes }, 'files.createFile.oversize');
    throw new ForbiddenError('File exceeds maximum allowed size');
  }

  const record = await prisma.file.create({
    data: {
      originalName: multerFile.originalname,
      storedName: multerFile.filename,
      mimeType: multerFile.mimetype,
      sizeBytes: multerFile.size,
      uploadedById,
    },
  });

  logger.info(
    {
      fileId: record.id,
      uploadedById,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
    },
    'files.createFile.success',
  );

  return toFileDto(record);
}

/**
 * Fetch file metadata plus the absolute disk path, enforcing access control.
 *
 * Access is granted when ANY of the following holds:
 *  (a) the caller is the uploader;
 *  (b) a `Message` referencing this file lives in a channel where the caller is
 *      a member;
 *  (c) a `Message` referencing this file lives in a DM where the caller is a
 *      participant.
 *
 * When the caller is the uploader the ACL query is short-circuited. Otherwise a
 * single `findFirst` with an `OR` over channel membership and DM participation
 * decides access; selecting only `{ id: true }` minimizes the payload.
 *
 * @throws {NotFoundError} when no file with the given id exists.
 * @throws {ForbiddenError} when the caller has no access path to the file.
 */
export async function getFile(input: GetFileInput): Promise<FileWithDiskPath> {
  const { fileId, userId } = input;

  const record = await prisma.file.findUnique({ where: { id: fileId } });
  if (record === null) {
    throw new NotFoundError('File not found');
  }

  if (record.uploadedById !== userId) {
    const message = await prisma.message.findFirst({
      where: {
        fileId,
        OR: [
          { channel: { members: { some: { userId } } } },
          { dm: { participants: { some: { userId } } } },
        ],
      },
      select: { id: true },
    });

    if (message === null) {
      logger.debug(
        { fileId, userId, uploadedById: record.uploadedById },
        'files.getFile.forbidden',
      );
      throw new ForbiddenError('You do not have access to this file');
    }
  }

  const diskPath = resolve(env.FILE_UPLOAD_PATH, record.storedName);

  logger.debug({ fileId, userId }, 'files.getFile.success');

  return { file: toFileDto(record), diskPath };
}
