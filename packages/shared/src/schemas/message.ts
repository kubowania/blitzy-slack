import { z } from 'zod';

import {
  MAX_EMOJI_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
} from '../constants/limits.js';

/**
 * Validates the request body for sending a new message into either a
 * channel (`POST /api/channels/:id/messages`) or a direct-message
 * conversation (`POST /api/dms/:id/messages`).
 *
 * Per AAP §0.4.4, `Message` belongs to EXACTLY ONE of:
 *   - a channel (`channelId` set, `dmId` null)
 *   - a direct-message conversation (`dmId` set, `channelId` null)
 *
 * The XOR superRefinement below enforces that exactly one of `channelId` /
 * `dmId` is provided, emitting field-level issues on both keys when the rule
 * is violated. The route adapter populates the appropriate field from the URL
 * path parameter before calling `sendMessageSchema.parse()`.
 *
 * `parentId` is set when the message is a thread reply (AAP §0.1.1
 * "Message threads — replies attached to a parent message via
 * `Message.parentId` self-reference").
 *
 * `fileId` is set when the message has a single file attachment
 * (AAP §0.1.1 "File sharing with a 10 MB cap"); the file MUST have been
 * uploaded separately via `POST /api/files` first, and the resulting
 * `fileId` is passed here.
 *
 * `.strict()` rejects unknown keys.
 */
export const sendMessageSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, 'Message cannot be empty')
      .max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`),
    channelId: z.string().cuid().optional(),
    dmId: z.string().cuid().optional(),
    parentId: z.string().cuid().optional(),
    fileId: z.string().cuid().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasChannel = Boolean(data.channelId);
    const hasDm = Boolean(data.dmId);
    if (hasChannel === hasDm) {
      const message = hasChannel
        ? 'Provide either channelId or dmId, not both'
        : 'Either channelId or dmId is required';
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['channelId'] });
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['dmId'] });
    }
  });

/**
 * Inferred TypeScript type for the validated send-message payload.
 */
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Validates the request BODY for the path-scoped message-create routes
 * `POST /api/channels/:id/messages` and `POST /api/dms/:id/messages`.
 *
 * Unlike {@link sendMessageSchema}, the container is identified by the URL path
 * parameter (`:id`), so this body carries NEITHER `channelId` NOR `dmId` — the
 * route handler derives the container id from `req.params.id` and passes it to
 * the message service. The body therefore contains only the message `content`
 * plus the optional thread `parentId` and `fileId` attachment reference.
 *
 * `.strict()` rejects unknown keys (including a stray `channelId` / `dmId` in
 * the body) so a caller cannot post into a different container than the URL
 * names.
 */
export const scopedMessageBodySchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, 'Message cannot be empty')
      .max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`),
    parentId: z.string().cuid().optional(),
    fileId: z.string().cuid().optional(),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated path-scoped message body.
 */
export type ScopedMessageBodyInput = z.infer<typeof scopedMessageBodySchema>;

/**
 * Validates the scope of a `typing:start` / `typing:stop` realtime event.
 *
 * A typing indicator targets EXACTLY ONE conversation — either a channel
 * (`channelId` set) or a direct message (`dmId` set) — mirroring the
 * channel/DM XOR invariant of {@link sendMessageSchema}. The server validates
 * the inbound socket payload against this schema before enforcing the room ACL
 * and broadcasting the indicator to the other participants. There is no
 * `content` here: a typing indicator is pure scope plus the typist's identity
 * (which the server derives from the authenticated `socket.data`, never from
 * the wire, so it cannot be spoofed).
 *
 * `.strict()` rejects unknown keys.
 */
export const typingScopeSchema = z
  .object({
    channelId: z.string().cuid().optional(),
    dmId: z.string().cuid().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasChannel = Boolean(data.channelId);
    const hasDm = Boolean(data.dmId);
    if (hasChannel === hasDm) {
      const message = hasChannel
        ? 'Provide either channelId or dmId, not both'
        : 'Either channelId or dmId is required';
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['channelId'] });
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['dmId'] });
    }
  });

/**
 * Inferred TypeScript type for the validated typing-scope payload.
 */
export type TypingScopeInput = z.infer<typeof typingScopeSchema>;

/**
 * Code points permitted inside an emoji reaction: the Emoji property plus
 * variation selector-16 (U+FE0F), the keycap combiner (U+20E3), the zero-width
 * joiner (U+200D), and the tag characters (U+E0020–U+E007F) used by
 * subdivision-flag sequences.
 */
const EMOJI_CODEPOINTS = /^(?:\p{Emoji}|\uFE0F|\u20E3|\u200D|[\u{E0020}-\u{E007F}])+$/u;

/**
 * Requires at least one pictographic, regional-indicator, or keycap element so
 * that bare digits and punctuation (which carry the Emoji property) are rejected.
 */
const EMOJI_REQUIRES = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u20E3/u;

/**
 * True when `value` is composed solely of emoji code points and contains at
 * least one pictographic / flag / keycap element.
 */
function isStandardEmoji(value: string): boolean {
  return EMOJI_CODEPOINTS.test(value) && EMOJI_REQUIRES.test(value);
}

/**
 * Validates the payload for adding (`POST /api/messages/:id/reactions`) or
 * removing (`DELETE /api/messages/:id/reactions/:emoji`) a reaction on a
 * message.
 *
 * One schema serves both add and remove: the wire data is identical — identify
 * the message (`messageId`) and the emoji (`emoji`) — and the HTTP method
 * discriminates add vs remove.
 *
 * `emoji` must be a standard Unicode emoji: every code point belongs to the
 * emoji set (pictographs, skin-tone modifiers, variation selector-16, the
 * keycap combiner, the zero-width joiner, regional indicators, and tag
 * characters), and at least one pictographic / flag / keycap element is
 * present. The MAX_EMOJI_LENGTH cap bounds ZWJ-sequence length.
 *
 * `.strict()` rejects unknown keys.
 */
export const reactionSchema = z
  .object({
    messageId: z.string().cuid(),
    emoji: z
      .string()
      .min(1)
      .max(MAX_EMOJI_LENGTH)
      .refine(isStandardEmoji, { message: 'emoji must be a standard Unicode emoji' }),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated reaction payload.
 */
export type ReactionInput = z.infer<typeof reactionSchema>;

/**
 * High-precision SQL-injection signatures rejected by {@link searchQuerySchema}.
 *
 * Each pattern targets a canonical injection form (line/block comments,
 * tautology probes with literal operands, stacked statements, UNION-based
 * extraction) and is scoped narrowly against standard chat-search prose. A match
 * causes {@link searchQuerySchema} to reject the input at the contract boundary
 * (HTTP 422). Rationale and trade-offs (this is a defense-in-depth input layer
 * atop the parameterized `tsvector` lookup, and the narrow-vs-broad signature
 * balance) are recorded in /docs/decision-log.md per the Explainability rule
 * (AAP §0.8.3), not in these comments.
 */
const SQL_INJECTION_PATTERNS: readonly RegExp[] = [
  // SQL line comment ("' OR 1=1 --") and block-comment delimiters ("/* */").
  /--/,
  /\/\*/,
  /\*\//,
  // Tautology probes: OR/AND <literal> = <literal>, where each operand is a
  // number or a quoted string literal (e.g. "OR 1=1", "OR 'a'='a'"). Requiring
  // literal operands means ordinary prose ("rock and roll = music"), whose
  // operands are barewords, does not match.
  /\b(?:or|and)\b\s+(?:\d+|'[^']*'|"[^"]*")\s*=\s*(?:\d+|'[^']*'|"[^"]*")/i,
  // Stacked / piggy-backed statement: a `;` terminator followed by a SQL verb.
  /;\s*(?:select|insert|update|delete|drop|alter|create|truncate|exec|grant|revoke|union)\b/i,
  // UNION-based extraction.
  /\bunion\b\s+(?:all\s+)?\bselect\b/i,
];

/**
 * Returns `true` when the value carries a recognized SQL-injection signature.
 * Stateless: the patterns use no `g` flag, so `RegExp.test` holds no lastIndex.
 *
 * @param value - the raw (already trimmed) search term
 * @returns whether the term matches any {@link SQL_INJECTION_PATTERNS} entry
 */
function hasSqlInjectionSignature(value: string): boolean {
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validates the query parameter for full-text search
 * (`GET /api/search?q=...`).
 *
 * The route adapter constructs `{ q: req.query.q }` and passes it to
 * `searchQuerySchema.parse()`.
 *
 * `q` is trimmed, non-empty, and capped at MAX_SEARCH_QUERY_LENGTH
 * characters (200) as a defensive cap against pathological query strings
 * that could degrade PostgreSQL `tsvector` lookup performance.
 *
 * A final refinement rejects recognized SQL-injection signatures (see
 * {@link SQL_INJECTION_PATTERNS}), refusing a matching probe with a 422 at the
 * contract boundary.
 *
 * `.strict()` rejects unknown keys.
 */
export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1, 'Enter a search term')
      .max(MAX_SEARCH_QUERY_LENGTH, `Search is limited to ${MAX_SEARCH_QUERY_LENGTH} characters`)
      .refine((value) => !hasSqlInjectionSignature(value), {
        message: 'Search query contains a disallowed pattern',
      }),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated search-query payload.
 */
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

// ===========================================================================
// Response validation schemas
// ===========================================================================
// Runtime validators for the hydrated RESPONSE shapes the API returns and the
// web client consumes. Unlike the request schemas above (which reject unknown
// keys via `.strict()`), these are PERMISSIVE: Zod's default strips unknown
// keys rather than rejecting them, so an additive future server field never
// breaks an older client. Each schema's `z.infer` mirrors the corresponding
// DTO interface in ../types/message.ts and ../types/user.ts, so a parsed value
// is assignable to the DTO without a cast.

/**
 * Validates a {@link PublicUser} embedded as a message author (the peer-facing
 * projection: id, displayName, nullable avatarUrl — never email).
 */
export const publicUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

/**
 * Validates an aggregated reaction summary chip ({@link ReactionSummary}).
 */
export const reactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number(),
  userIds: z.array(z.string()),
  hasCurrentUser: z.boolean(),
});

/**
 * Validates a single file attachment ({@link FileAttachment}) carried by a
 * message, including the server-computed public download `url`.
 */
export const fileAttachmentSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  storedName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  uploadedById: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});

/**
 * Validates a fully-hydrated message ({@link MessageWithAuthor}) as returned by
 * the message timeline, the thread endpoint, and the `message:new` broadcast.
 */
export const messageWithAuthorSchema = z.object({
  id: z.string(),
  content: z.string(),
  authorId: z.string(),
  author: publicUserSchema,
  channelId: z.string().nullable(),
  dmId: z.string().nullable(),
  parentId: z.string().nullable(),
  fileId: z.string().nullable(),
  file: fileAttachmentSchema.nullable(),
  reactions: z.array(reactionSummarySchema),
  replyCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Validates the {@link Thread} payload returned by
 * `GET /api/messages/:id/replies`: the hydrated parent plus the ordered
 * (oldest-first) reply list. The web thread panel parses the raw response
 * through this schema so any server/client shape drift surfaces as a thrown
 * `ZodError` at the fetch boundary instead of a silent runtime crash deep in
 * the render tree.
 */
export const threadResponseSchema = z.object({
  parent: messageWithAuthorSchema,
  replies: z.array(messageWithAuthorSchema),
});

/**
 * Inferred TypeScript type for the validated thread response. Structurally
 * equals the {@link Thread} DTO so a parsed value is assignable without a cast.
 */
export type ThreadResponse = z.infer<typeof threadResponseSchema>;
