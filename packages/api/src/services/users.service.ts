/**
 * User service — read-only user lookups for the "Start a direct message"
 * people picker.
 *
 * Public surface:
 *   searchUsers({ query?, excludeUserId, limit? }) → PublicUser[]
 *
 * Layering and behavioral contract:
 *  - This service is the only layer permitted to touch Prisma for the user
 *    directory lookup. The route calls it and serializes the result; it NEVER
 *    touches Socket.io.
 *  - Results are `PublicUser` (id, displayName, avatarUrl) — the email is NEVER
 *    searchable nor returned (privacy; email is not part of the peer view).
 *  - The requesting user is ALWAYS excluded from results: a user cannot start a
 *    DM with themselves, so they must not appear in their own picker.
 *  - When `query` is absent/empty the directory's first page (ordered by
 *    displayName) is returned so the picker can show suggestions before the
 *    caller types; when present, a case-insensitive `displayName CONTAINS`
 *    match is applied.
 *  - The result count is hard-capped at `MAX_USER_SEARCH_RESULTS` regardless of
 *    the requested `limit`, bounding the response size.
 *
 * Rationale and trade-offs (displayName-only search vs. full-text, exclusion of
 * email) live in /docs/decision-log.md per the Explainability rule (AAP
 * §0.8.3), not in these comments.
 */

import { prisma } from '@app/db';
import type { Prisma } from '@app/db';

import { MAX_USER_SEARCH_RESULTS } from '@app/shared/constants/limits';
import type { PublicUser } from '@app/shared/types/user';

/**
 * Input contract for {@link searchUsers}. The route constructs this after Zod
 * validation of the `?q=` query string and supplies the authenticated caller's
 * id as `excludeUserId`.
 */
export interface SearchUsersInput {
  /**
   * Optional case-insensitive displayName substring. When omitted or empty the
   * first page of the directory is returned.
   */
  query?: string;
  /** Requesting user's id — always excluded from results. */
  excludeUserId: string;
  /**
   * Maximum results to return. Defaults to and is hard-capped at
   * `MAX_USER_SEARCH_RESULTS`.
   */
  limit?: number;
}

/**
 * Search the user directory for the start-DM people picker.
 *
 * @param input - the validated query, the caller id to exclude, and an optional
 *   limit.
 * @returns up to `MAX_USER_SEARCH_RESULTS` peer users ordered by displayName.
 */
export async function searchUsers(input: SearchUsersInput): Promise<PublicUser[]> {
  const limit = Math.min(input.limit ?? MAX_USER_SEARCH_RESULTS, MAX_USER_SEARCH_RESULTS);

  const where: Prisma.UserWhereInput = { id: { not: input.excludeUserId } };
  const trimmed = input.query?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    where.displayName = { contains: trimmed, mode: 'insensitive' };
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, displayName: true, avatarUrl: true },
    orderBy: { displayName: 'asc' },
    take: limit,
  });

  return users;
}
