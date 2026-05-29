/**
 * Message, reaction, file, and thread DTOs that cross the network boundary
 * between @app/api (server) and @app/web (client).
 *
 * These DTOs are the SERIALIZATION SHAPES of the underlying Prisma models
 * declared in packages/db/prisma/schema.prisma. They are independently
 * declared here to preserve the LEAF invariant (AAP §0.4.3) — the shared
 * package MUST NOT import from @app/db.
 *
 * Date fields are typed as ISO 8601 `string` (not `Date`) because they are
 * serialized via `JSON.stringify` on the wire and parsed lazily by the
 * client. Foreign-key optional fields are typed as `... | null` (not `?`)
 * because Prisma returns `null` (not `undefined`) for missing optional
 * relations.
 */

import type { PublicUser } from './user.js';

/**
 * Base Message DTO — mirrors the Prisma `Message` model.
 *
 * EXACTLY ONE of `channelId` / `dmId` is non-null (a message belongs to a
 * channel OR a direct-message conversation; never both). `parentId` is
 * non-null when this message is a reply within a thread.
 */
export interface Message {
  /** Database id (cuid). */
  id: string;
  /** Plain-text message body. Rich-text formatting lives in the rendered UI. */
  content: string;
  /** Database id of the message author. */
  authorId: string;
  /** Channel id if posted in a channel; `null` if posted in a DM. */
  channelId: string | null;
  /** DM id if posted in a DM; `null` if posted in a channel. */
  dmId: string | null;
  /** Parent message id when this message is a thread reply; `null` otherwise. */
  parentId: string | null;
  /** Attached file id when this message has a file attachment; `null` otherwise. */
  fileId: string | null;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update (currently equals createdAt — messages are immutable in the PoC). */
  updatedAt: string;
}

/**
 * Aggregated reaction shape returned in the message timeline. The server
 * computes this from the raw `MessageReaction` rows so that the client can
 * render reaction chips without additional queries.
 *
 * `hasCurrentUser` is computed PER REQUESTING USER on the server side — the
 * same message may show `hasCurrentUser: true` to one viewer and `false`
 * to another.
 */
export interface ReactionSummary {
  /** Unicode emoji (e.g., '👍', '🎉'). */
  emoji: string;
  /** Total number of users who have reacted with this emoji. */
  count: number;
  /** Database ids of all users who have reacted with this emoji. */
  userIds: string[];
  /** `true` when the requesting user has reacted with this emoji. */
  hasCurrentUser: boolean;
}

/**
 * Attached file DTO — mirrors the Prisma `File` model with the additional
 * `url` field that the API computes for the download path served by Express
 * static.
 *
 * Per AAP §0.1.1, the file size is capped at MAX_FILE_SIZE_MB (10 MB).
 * Per AAP §0.4.4, the underlying model carries originalName, storedName,
 * mimeType, and sizeBytes.
 */
export interface FileAttachment {
  /** Database id (cuid). */
  id: string;
  /** Filename as uploaded by the user (preserved for display and downloads). */
  originalName: string;
  /** Server-side stored filename (typically a UUID-prefixed name to prevent collisions). */
  storedName: string;
  /** MIME type detected at upload time (e.g., 'image/png', 'application/pdf'). */
  mimeType: string;
  /** Size in bytes. */
  sizeBytes: number;
  /**
   * Database id of the uploading user, or `null` when the uploader account
   * has been removed (the `File.uploadedById` relation is `ON DELETE SET NULL`).
   */
  uploadedById: string | null;
  /** ISO 8601 timestamp of upload. */
  createdAt: string;
  /**
   * Public URL where the file is served by Express static (or a signed-URL
   * substitute in a future S3 integration). The client uses this directly
   * in `<img src>` or download links.
   */
  url: string;
}

/**
 * Hydrated Message DTO returned by the message timeline and broadcast over
 * Socket.io `message:new`. Includes the message author (PublicUser), the
 * aggregated reactions (ReactionSummary[]), the reply count for thread
 * indicators, and any file attachment.
 *
 * `replyCount` is computed server-side from the count of messages whose
 * `parentId` equals this message's `id`. `file` is `null` when no
 * attachment is associated with the message.
 */
export interface MessageWithAuthor extends Message {
  /** The message author, shaped as PublicUser (no email exposure). */
  author: PublicUser;
  /** Aggregated reactions; empty array when no reactions exist. */
  reactions: ReactionSummary[];
  /** Number of thread replies; `0` when this message has no replies. */
  replyCount: number;
  /** Attached file metadata; `null` when no file is attached. */
  file: FileAttachment | null;
}

/**
 * Base MessageReaction DTO — mirrors the Prisma `MessageReaction` model.
 *
 * The Prisma model has a unique composite constraint on
 * `(messageId, userId, emoji)` so that a single user cannot register the
 * same emoji twice on the same message. Reaction toggling is implemented
 * server-side as a delete-or-insert; the wire shape carries the row state
 * verbatim.
 */
export interface MessageReaction {
  /** Database id (cuid). */
  id: string;
  /** Database id of the reacted-to message. */
  messageId: string;
  /** Database id of the reacting user. */
  userId: string;
  /** Unicode emoji (e.g., '👍'). */
  emoji: string;
}

/**
 * Thread payload returned by `GET /api/messages/:id/replies` and used by the
 * Sheet-based thread panel in the web UI.
 *
 * The `parent` is the message being replied to (fully hydrated with author,
 * reactions, etc.) and `replies` is the ordered list of child messages
 * (oldest-first), each fully hydrated.
 */
export interface Thread {
  /** The parent message (the one being replied to). */
  parent: MessageWithAuthor;
  /** Ordered (oldest-first) list of reply messages. */
  replies: MessageWithAuthor[];
}
