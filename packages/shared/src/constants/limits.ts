/**
 * Numeric limit constants shared across the Blitzy Slack API and web packages.
 *
 * These are STATIC defaults (compile-time constants). Where the runtime can
 * override (e.g., MAX_FILE_SIZE_MB via the env loader), the override happens in
 * packages/api/src/config/env.ts; this file captures the canonical defaults
 * that the web client also uses for fail-fast UI feedback.
 *
 * Rationale for individual values is recorded in /docs/decision-log.md — this
 * file deliberately contains NO embedded rationale comments per the
 * Explainability rule (AAP §0.8.3).
 */

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
/** Default page size for cursor-paginated message lists (AAP §0.1.1, §0.8.4). */
export const PAGE_SIZE = 50 as const;

/** Server-side ceiling for the `limit` query parameter (AAP §0.8.4). */
export const MAX_PAGE_SIZE = 100 as const;

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------
/** Hard cap on a single attachment in megabytes (AAP §0.1.1 "10 MB cap"). */
export const MAX_FILE_SIZE_MB = 10 as const;

/** Hard cap on a single attachment in bytes; derived from MAX_FILE_SIZE_MB. */
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ---------------------------------------------------------------------------
// Presence (AAP §0.8.4)
// ---------------------------------------------------------------------------
/** Client emits `presence:heartbeat` every 30 seconds while the tab is focused. */
export const HEARTBEAT_INTERVAL_MS = 30_000 as const;

/** A user is "online" if the last heartbeat was within 60 seconds. */
export const ONLINE_THRESHOLD_MS = 60_000 as const;

/** A user is "away" if the last heartbeat was within 5 minutes (300 s); "offline" beyond. */
export const AWAY_THRESHOLD_MS = 300_000 as const;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------
/** Maximum length of a message body in characters (Slack convention). */
export const MAX_MESSAGE_LENGTH = 4000 as const;

// ---------------------------------------------------------------------------
// Authentication / Identity
// ---------------------------------------------------------------------------
/** Minimum length of a user password in characters. */
export const MIN_PASSWORD_LENGTH = 8 as const;

/** Minimum length of a displayName in characters. */
export const MIN_DISPLAY_NAME_LENGTH = 1 as const;

/** Maximum length of a displayName in characters. */
export const MAX_DISPLAY_NAME_LENGTH = 80 as const;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------
/** Maximum length of a channel name in characters (Slack convention). */
export const MAX_CHANNEL_NAME_LENGTH = 80 as const;

/** Maximum length of a channel description in characters. */
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 250 as const;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
/** Maximum length of a search query in characters. */
export const MAX_SEARCH_QUERY_LENGTH = 200 as const;

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------
/** Maximum length of a reaction emoji string in characters. */
export const MAX_EMOJI_LENGTH = 64 as const;

// ---------------------------------------------------------------------------
// User search (start-DM people picker)
// ---------------------------------------------------------------------------
/** Maximum number of users returned by `GET /api/users?q=` in a single page. */
export const MAX_USER_SEARCH_RESULTS = 20 as const;

// ---------------------------------------------------------------------------
// Presence hydration
// ---------------------------------------------------------------------------
/** Maximum number of user ids accepted by `GET /api/presence?userIds=` per call. */
export const MAX_PRESENCE_QUERY_IDS = 200 as const;
