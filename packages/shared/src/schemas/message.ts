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
 * The XOR refinement below enforces that exactly one of `channelId` /
 * `dmId` is provided. The route adapter populates the appropriate field
 * from the URL path parameter before calling `sendMessageSchema.parse()`.
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
 * `.strict()` rejects unknown keys to prevent prototype-pollution / over-
 * posting attacks; rationale recorded in /docs/decision-log.md.
 */
export const sendMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    channelId: z.string().cuid().optional(),
    dmId: z.string().cuid().optional(),
    parentId: z.string().cuid().optional(),
    fileId: z.string().cuid().optional(),
  })
  .strict()
  .refine(
    (data) => Boolean(data.channelId) !== Boolean(data.dmId),
    { message: 'Exactly one of channelId or dmId must be provided' },
  );

/**
 * Inferred TypeScript type for the validated send-message payload.
 */
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Validates the payload for adding (`POST /api/messages/:id/reactions`) or
 * removing (`DELETE /api/messages/:id/reactions/:emoji`) a reaction on a
 * message.
 *
 * The shape is unified across add and remove because the wire data is
 * identical: identify the message (`messageId`) and the emoji (`emoji`).
 * The HTTP method discriminates add vs remove.
 *
 * `emoji` is bounded to MAX_EMOJI_LENGTH characters as a defensive cap
 * — Unicode emoji are typically 1–8 code points (e.g., 👨‍👩‍👧‍👦 is 7 code
 * points), and longer strings indicate abuse rather than valid input.
 * Strict Unicode-emoji-regex validation was rejected in favor of bare
 * length-bounded string validation; rationale recorded in
 * /docs/decision-log.md.
 *
 * `.strict()` rejects unknown keys.
 */
export const reactionSchema = z
  .object({
    messageId: z.string().cuid(),
    emoji: z.string().min(1).max(MAX_EMOJI_LENGTH),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated reaction payload.
 */
export type ReactionInput = z.infer<typeof reactionSchema>;

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
 * `.strict()` rejects unknown keys.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated search-query payload.
 */
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
