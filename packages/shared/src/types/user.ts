/**
 * User DTOs shared between @app/api (server) and @app/web
 * (client).
 *
 * Four shapes correspond to four exposure contexts:
 *
 *   - `User`              — the internal/server-side shape mirroring the
 *                           Prisma `User` model, INCLUDING `passwordHash`.
 *                           Never serialized directly to the network.
 *   - `UserResponse`      — the SELF view (`User` without `passwordHash`),
 *                           returned by `GET /api/auth/me` to the account owner.
 *   - `PublicUser`        — the PEER view, rendered on channel-member lists,
 *                           DM partner displays, and message-author avatars.
 *                           Excludes `email` for privacy.
 *   - `AuthenticatedUser` — the JWT principal (`PublicUser` plus `email`)
 *                           attached to authenticated HTTP requests (`req.user`)
 *                           and Socket.io handshakes (`socket.data`).
 *
 * Privacy contract: `passwordHash` exists ONLY on the internal `User` shape.
 * The network-facing shapes (`UserResponse`, `PublicUser`, `AuthenticatedUser`)
 * never carry it. Service-layer code in
 * `packages/api/src/services/auth.service.ts` builds the network shapes by
 * omitting `passwordHash` from the underlying `User`.
 *
 * This file is part of the LEAF shared package (AAP §0.4.3) and MUST NOT
 * import from @app/db, @app/api, or @app/web. The shapes here mirror the
 * Prisma model but are independently declared to enforce the LEAF invariant.
 */

/**
 * Internal/server-side user shape mirroring the Prisma `User` model,
 * including `passwordHash`. Date fields are ISO 8601 strings.
 *
 * NOT serialized to the network directly: use `UserResponse` for the
 * account-owner self view and `PublicUser` for peer views.
 */
export interface User {
  /** Database id (cuid). */
  id: string;
  /** Email address (unique, used for login). */
  email: string;
  /** Bcrypt password hash; server-internal only — never serialized to the network. */
  passwordHash: string;
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
 * Account-owner self view returned by `GET /api/auth/me`: the internal
 * `User` shape with `passwordHash` omitted.
 */
export type UserResponse = Omit<User, 'passwordHash'>;

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
 * JWT-decoded principal attached to authenticated HTTP requests (`req.user`)
 * by `packages/api/src/middleware/auth.ts` and to Socket.io handshakes
 * (`socket.data`) by `packages/api/src/middleware/socket-auth.ts`.
 *
 * Extends `PublicUser` (`id`, `displayName`, `avatarUrl`) with the owner's
 * `email`, which is denormalized into the JWT for authorization and log lines.
 */
export interface AuthenticatedUser extends PublicUser {
  /** Email address (denormalized into the JWT for log lines). */
  email: string;
}
