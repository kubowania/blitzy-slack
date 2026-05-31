import { z } from 'zod';

import { MAX_DISPLAY_NAME_LENGTH } from '../constants/limits.js';

/**
 * Validates the query string for the user-search endpoint
 * (`GET /api/users?q=<text>`), which powers the "Start a direct message"
 * people picker (StartDmDialog).
 *
 * `q` is OPTIONAL: when absent or empty the endpoint returns the first page of
 * users (ordered by displayName) so the picker can show suggestions before the
 * caller types anything. When present it is trimmed and bounded to
 * MAX_DISPLAY_NAME_LENGTH characters (the longest a displayName can be, so any
 * longer query could never match) as a defensive cap.
 *
 * The service performs a case-insensitive `displayName CONTAINS q` match and
 * always excludes the requesting user from the results (you cannot DM
 * yourself). Email is never searchable or returned (privacy — results are
 * `PublicUser`, which omits email).
 *
 * `.strict()` rejects unknown keys.
 */
export const userSearchQuerySchema = z
  .object({
    q: z.string().trim().max(MAX_DISPLAY_NAME_LENGTH).optional(),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated user-search query.
 */
export type UserSearchQueryInput = z.infer<typeof userSearchQuerySchema>;
