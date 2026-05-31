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
    content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
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
 * The shape is unified across add and remove because the wire data is
 * identical: identify the message (`messageId`) and the emoji (`emoji`).
 * The HTTP method discriminates add vs remove.
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
