import { z } from 'zod';

import { MAX_CHANNEL_DESCRIPTION_LENGTH, MAX_CHANNEL_NAME_LENGTH } from '../constants/limits.js';

/**
 * Slack-style channel-name pattern: lowercase letters, digits, underscore,
 * hyphen. No spaces, no uppercase, no punctuation. Matches the Slack web
 * UI's `#channel-name` rendering convention.
 *
 * Rationale (allowing only this charset, no internationalization) is
 * recorded in /docs/decision-log.md.
 */
const CHANNEL_NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validates the request body for `POST /api/channels`.
 *
 * Per AAP §0.4.4 Channel model: `name` (unique, max
 * MAX_CHANNEL_NAME_LENGTH), `description?` (optional, max
 * MAX_CHANNEL_DESCRIPTION_LENGTH), `isPrivate` (required boolean).
 *
 * Per AAP §0.1.1: private channels restrict visibility and membership —
 * the boolean drives ACL enforcement in the service layer.
 *
 * `.strict()` rejects unknown keys to prevent prototype-pollution / over-
 * posting attacks; rationale recorded in /docs/decision-log.md.
 */
export const createChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CHANNEL_NAME_LENGTH).regex(CHANNEL_NAME_PATTERN),
    description: z.string().trim().max(MAX_CHANNEL_DESCRIPTION_LENGTH).optional(),
    isPrivate: z.boolean(),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated create-channel payload.
 */
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

/**
 * Validates the path parameter for `POST /api/channels/:id/join`.
 *
 * The validator accepts a single `channelId` field; the API route adapter
 * passes `{ channelId: req.params.id }` into `joinChannelSchema.parse()`.
 *
 * `channelId` is validated as a Prisma-generated cuid per AAP §0.4.4.
 *
 * `.strict()` rejects unknown keys.
 */
export const joinChannelSchema = z
  .object({
    channelId: z.string().cuid(),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated join-channel payload.
 */
export type JoinChannelInput = z.infer<typeof joinChannelSchema>;
