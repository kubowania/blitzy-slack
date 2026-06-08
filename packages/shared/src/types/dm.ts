/**
 * Direct-message conversation DTOs that cross the network boundary between
 * @app/api (server) and @app/web (client).
 *
 * A `DirectMessage` is a 1:1 conversation (per AAP §0.1.1 — "start a 1:1 DM
 * between two users and exchange messages"). The underlying database
 * enforces a unique composite constraint on the `(dmId, userId)` pair AND
 * a unique constraint on the canonical ordered participant pair so that
 * exactly one DM conversation exists per pair of users.
 *
 * Messages within a DM are stored in the same `Message` table as channel
 * messages, distinguished by `Message.dmId !== null`. The Message DTOs live
 * in ./message.ts (this file declares only the conversation envelope).
 *
 * Per AAP §0.4.3, this file is part of the LEAF shared package and MUST NOT
 * import from @app/db. The shapes here MIRROR the Prisma models
 * but are independently declared to enforce the LEAF invariant.
 */

import type { PublicUser } from './user.js';

/**
 * Base DirectMessage DTO — mirrors the Prisma `DirectMessage` model.
 *
 * The model itself carries no business data beyond identity and creation
 * timestamp; the conversation's participants are tracked via the
 * `DMParticipant` join table, and the conversation's messages live in the
 * shared `Message` table (where `Message.dmId === DirectMessage.id`).
 */
export interface DirectMessage {
  /** Database id (cuid). */
  id: string;
  /** ISO 8601 timestamp when the conversation was created. */
  createdAt: string;
}

/**
 * DMParticipant join-table row DTO — mirrors the Prisma `DMParticipant`
 * model. Exactly two rows exist per DM for the PoC (one per participant);
 * the data model permits more rows to support future group-DM expansion.
 */
export interface DMParticipant {
  /** Database id of the parent DirectMessage. */
  dmId: string;
  /** Database id of the participating user. */
  userId: string;
}

/**
 * Hydrated DirectMessage DTO returned by list and detail endpoints
 * (`GET /api/dms` and `GET /api/dms/:id`). Includes both participants
 * (hydrated as `PublicUser`) and the timestamp of the most-recent message
 * for sidebar ordering and unread indicators.
 *
 * `participants.length` is `2` for the PoC; the shape is `PublicUser[]`
 * (not a tuple) so that future group-DM expansion does not break the
 * wire contract.
 *
 * `lastMessageAt` is `null` for empty conversations (newly-created DMs
 * with no messages yet).
 */
export interface DMWithParticipants extends DirectMessage {
  /** Both DM participants, hydrated as PublicUser. */
  participants: PublicUser[];
  /** ISO 8601 timestamp of the most-recent message, or `null` for empty conversations. */
  lastMessageAt: string | null;
}

/**
 * Compact projection of a single DM participant — carries only the identity
 * and display fields (`id`, `displayName`, `avatarUrl`) needed to render a
 * participant in a direct-message list row.
 */
export interface DMParticipantSummary {
  /** Database id (cuid) of the participant user. */
  id: string;
  /** Human-readable display name of the participant. */
  displayName: string;
  /** Public avatar image URL; `null` when the participant has not set an avatar. */
  avatarUrl: string | null;
}
