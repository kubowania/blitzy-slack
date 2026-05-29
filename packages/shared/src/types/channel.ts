/**
 * Channel and ChannelMember DTOs that cross the network boundary between
 * @app/api (server) and @app/web (client).
 *
 * Per AAP §0.1.1, channels may be `public` (visible to all authenticated
 * users) or `private` (visible only to their members). The `isPrivate` flag
 * gates listing, joining, and message access at the service layer.
 *
 * Per AAP §0.4.3, this file is part of the LEAF shared package and MUST NOT
 * import from @app/db. The shapes here MIRROR the Prisma models declared in
 * packages/db/prisma/schema.prisma but are independently declared to enforce
 * the LEAF invariant.
 */

import type { PublicUser } from './user.js';

/**
 * Channel membership role.
 *
 * - `owner`  — channel creator; only role allowed to delete the channel
 * - `admin`  — elevated permissions (currently behaves identically to owner
 *              in the PoC; reserved for future moderation features)
 * - `member` — standard participant; can read and post messages
 *
 * Declared as a string-literal type alias union (NOT a TypeScript `enum`)
 * to avoid runtime emit under `isolatedModules: true` per AAP Rule 3.
 */
export type ChannelRole = 'owner' | 'admin' | 'member';

/**
 * Base Channel DTO — mirrors the Prisma `Channel` model.
 *
 * `name` follows Slack's `#channel-name` convention but is stored WITHOUT
 * the leading `#`; the UI renders the prefix.
 */
export interface Channel {
  /** Database id (cuid). */
  id: string;
  /** Channel name (unique, no leading `#`). */
  name: string;
  /** Optional channel description; `null` when none set. */
  description: string | null;
  /** `true` for private channels (restricted membership), `false` for public. */
  isPrivate: boolean;
  /** Database id of the user who created the channel. */
  createdById: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
}

/**
 * Base ChannelMember DTO — mirrors the Prisma `ChannelMember` model.
 *
 * The underlying table enforces a unique composite constraint on
 * `(channelId, userId)` so that a user cannot join the same channel twice.
 */
export interface ChannelMember {
  /** Database id (cuid). */
  id: string;
  /** Database id of the parent channel. */
  channelId: string;
  /** Database id of the member user. */
  userId: string;
  /** Channel membership role. */
  role: ChannelRole;
  /** ISO 8601 timestamp when the user joined. */
  joinedAt: string;
}

/**
 * Hydrated Channel DTO returned by detail endpoints (`GET /api/channels/:id`)
 * and the channel-detail view in the web UI. Includes the full member list
 * (with hydrated user data) and the precomputed member count.
 *
 * `memberCount` is included DISTINCT from `members.length` because in
 * future iterations the API may return only the first N members and then
 * page; `memberCount` always reflects the total.
 */
export interface ChannelWithMembers extends Channel {
  /** Channel members with hydrated user shapes. */
  members: (ChannelMember & { user: PublicUser })[];
  /** Total number of members; equals `members.length` for now. */
  memberCount: number;
}

/**
 * Minimal Channel shape used in the sidebar channel list. Carries only the
 * fields needed for list rendering, plus an optional unread count badge.
 *
 * Returned by `GET /api/channels` (the list endpoint) so that the sidebar
 * can render quickly without paying for the full Channel + ChannelMember
 * hydration cost.
 */
export interface ChannelSummary {
  /** Database id (cuid). */
  id: string;
  /** Channel name (no leading `#`). */
  name: string;
  /** `true` for private channels, `false` for public. */
  isPrivate: boolean;
  /** Unread-message count for the requesting user; omitted when no unread tracking is active. */
  unreadCount?: number;
}
