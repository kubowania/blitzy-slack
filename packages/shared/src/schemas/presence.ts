import { z } from 'zod';

import { MAX_PRESENCE_QUERY_IDS } from '../constants/limits.js';

/**
 * Validates the query string for the presence-hydration endpoint
 * (`GET /api/presence?userIds=<id1,id2,...>`), which the web client calls once
 * on mount to seed its presence map for every user currently visible in the
 * sidebar / DM list — before any live `presence:update` events arrive.
 *
 * `userIds` arrives as a single comma-separated string (the natural URL form).
 * It is trimmed, split on commas, emptied entries dropped, then validated as a
 * non-empty list of cuids bounded to MAX_PRESENCE_QUERY_IDS entries (a
 * defensive cap so a pathological URL cannot trigger an unbounded Redis MGET).
 * The `.transform()` yields a typed `string[]` so the route handler receives
 * the parsed list directly.
 *
 * `.strict()` rejects unknown keys.
 */
export const presenceQuerySchema = z
  .object({
    userIds: z
      .string()
      .trim()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      )
      .pipe(z.array(z.string().cuid()).min(1).max(MAX_PRESENCE_QUERY_IDS)),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated presence-hydration query. After
 * the transform, `userIds` is a `string[]` of cuids.
 */
export type PresenceQueryInput = z.infer<typeof presenceQuerySchema>;
