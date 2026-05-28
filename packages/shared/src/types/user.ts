/**
 * User DTOs shared between @app/api (server) and @app/web
 * (client).
 *
 * Three shapes correspond to three exposure contexts:
 *
 *   - `User`              — the SELF view, returned by `GET /api/auth/me`
 *                           to the account owner. Includes `email`.
 *   - `PublicUser`        — the PEER view, rendered on channel-member lists,
 *                           DM partner displays, and message-author avatars.
 *                           Excludes `email` for privacy.
 *   - `AuthenticatedUser` — the JWT principal subset attached to
 *                           authenticated HTTP requests (`req.user`) and
 *                           Socket.io handshakes (`socket.data`).
 *
 * IMPORTANT — Privacy invariant: the `passwordHash` column from the
 * underlying `User` Prisma model is NEVER exposed across the network. NO
 * DTO in this file includes a `passwordHash` field. Service-layer code in
 * `packages/api/src/services/auth.service.ts` MUST explicitly omit
 * `passwordHash` from response shapes.
 *
 * This file is part of the LEAF shared package (AAP §0.4.3) and MUST NOT
 * import from @app/db, @app/api, or @app/web.
 * The shapes here MIRROR the Prisma model but are independently declared
 * to enforce the LEAF invariant.
 */

/**
 * Full user DTO returned to the OWNING user (e.g., `GET /api/auth/me`).
 *
 * Mirrors the Prisma `User` model EXCEPT for `passwordHash` (which is
 * never returned over the network) and with date fields serialized as
 * ISO 8601 strings.
 */
export interface User {
  /** Database id (cuid). */
  id: string;
  /** Email address (unique, used for login). */
  email: string;
  /** Human-readable display name (1–80 characters). */
  displayName: string;
  /** Public avatar image URL; `null` when the user has not set an avatar. */
  avatarUrl: string | null;
  /** ISO 8601 timestamp of account creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last profile update. */
  updatedAt: string;
}

/**
 * Public user shape rendered to OTHER users — on message-author avatars,
 * channel-member lists, DM-partner displays, presence-bound rows, etc.
 *
 * Excludes `email` (privacy) and `createdAt` / `updatedAt` (irrelevant to
 * peers). When a peer needs to see another user's identity, this is the
 * minimal projection.
 */
export interface PublicUser {
  /** Database id (cuid). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Public avatar image URL; `null` when the user has not set an avatar. */
  avatarUrl: string | null;
}

/**
 * JWT-decoded principal attached to authenticated HTTP requests
 * (`req.user`) by `packages/api/src/middleware/auth.ts` and to Socket.io
 * handshakes (`socket.data`) by `packages/api/src/middleware/socket-auth.ts`.
 *
 * The shape is INTENTIONALLY narrow — it carries only the fields needed
 * for authorization decisions and request logging (`reqId`, `userId`,
 * `email`). Service-layer code that needs the full User profile must
 * fetch it from the database using the `id` field.
 */
export interface AuthenticatedUser {
  /** Database id of the authenticated user (cuid). */
  id: string;
  /** Email address (denormalized into the JWT for log lines). */
  email: string;
}
