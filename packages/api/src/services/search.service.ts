/**
 * Search service — PostgreSQL full-text search over messages with ACL.
 *
 * Public surface:
 *   searchMessages({ userId, query, limit? }) → MessageWithAuthor[]
 *
 * How it works:
 *  - Issues a parameterized raw query via `prisma.$queryRaw` with the
 *    `Prisma.sql` tagged template so every dynamic value is bound by the
 *    driver (never string-concatenated).
 *  - Matches against the `"contentTsv"` generated `tsvector` column on the
 *    `Message` table (provisioned by the `add_message_tsvector` Prisma
 *    migration in packages/db/prisma/migrations) and backed by the
 *    `Message_contentTsv_idx` GIN index.
 *  - Restricts hits to messages the caller may see: channels they belong to,
 *    DMs they participate in, or any public channel.
 *  - Orders hits by `ts_rank` descending, then `createdAt` descending.
 *  - Re-fetches the matched rows with Prisma's typed client (`findMany` with
 *    relation includes) so the returned DTOs are identical to those produced
 *    by the channel and DM message endpoints, then restores the rank order
 *    in memory.
 */

import { prisma, Prisma } from '@app/db';
import type {
  Message as PrismaMessage,
  User as PrismaUser,
  MessageReaction as PrismaMessageReaction,
  File as PrismaFile,
} from '@app/db';

import { logger } from '../config/logger.js';
import { ValidationError } from '../middleware/errors.js';

import {
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_QUERY_LENGTH,
} from '@app/shared/constants/limits';
import type { MessageWithAuthor } from '@app/shared/types/message';
import type { SearchQueryInput } from '@app/shared/schemas/message';

/**
 * Input contract for {@link searchMessages}.
 *
 * `query` is typed as the route validator's `q` field
 * ({@link SearchQueryInput}) so the service and the
 * `GET /api/search?q=` Zod schema stay aligned on a single source of truth.
 */
export interface SearchMessagesInput {
  /** Database id of the user performing the search (drives the ACL filter). */
  userId: string;
  /** Free-text search query; corresponds to the route validator's `q` field. */
  query: SearchQueryInput['q'];
  /** Maximum number of hits to return; defaults to PAGE_SIZE, capped at MAX_PAGE_SIZE. */
  limit?: number;
}

/**
 * Internal shape of a single row returned by the raw full-text query: the
 * matched message id plus its `ts_rank` relevance score (used only for the
 * SQL `ORDER BY`; the JS layer keys off the id).
 */
interface SearchHitRow {
  /** Database id of the matched message. */
  id: string;
  /** `ts_rank` relevance score for the match. */
  rank: number;
}

/**
 * Project a Prisma `User` record onto the public author shape embedded in a
 * message DTO. Excludes `passwordHash`, `email`, and all timestamps so the
 * author projection never leaks private fields to peers.
 */
function toAuthorDto(user: PrismaUser): {
  id: string;
  displayName: string;
  avatarUrl: string | null;
} {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * Aggregate raw `MessageReaction` rows into the reaction summaries the client
 * renders as chips. Reactions are grouped by emoji; `count` is the number of
 * distinct reactors, `userIds` lists them, and `hasCurrentUser` is true when
 * the searching user is among them.
 */
function toReactionSummaries(
  reactions: PrismaMessageReaction[],
  callerUserId: string,
): { emoji: string; count: number; userIds: string[]; hasCurrentUser: boolean }[] {
  const grouped = new Map<
    string,
    { emoji: string; count: number; userIds: string[]; hasCurrentUser: boolean }
  >();

  for (const reaction of reactions) {
    const existing = grouped.get(reaction.emoji);
    if (existing === undefined) {
      grouped.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        userIds: [reaction.userId],
        hasCurrentUser: reaction.userId === callerUserId,
      });
    } else {
      existing.count += 1;
      existing.userIds.push(reaction.userId);
      if (reaction.userId === callerUserId) {
        existing.hasCurrentUser = true;
      }
    }
  }

  return Array.from(grouped.values());
}

/**
 * Map a fully-hydrated Prisma `Message` record (with its author, reactions,
 * optional file, and reply count) onto the `MessageWithAuthor` DTO sent over
 * the wire. Date fields are serialized to ISO 8601 strings and the file
 * attachment is augmented with its public download URL.
 */
function toMessageDto(
  record: PrismaMessage & {
    author: PrismaUser;
    reactions: PrismaMessageReaction[];
    file: PrismaFile | null;
    _count?: { replies: number };
  },
  callerUserId: string,
): MessageWithAuthor {
  return {
    id: record.id,
    content: record.content,
    authorId: record.authorId,
    author: toAuthorDto(record.author),
    channelId: record.channelId,
    dmId: record.dmId,
    parentId: record.parentId,
    fileId: record.fileId,
    file:
      record.file === null
        ? null
        : {
            id: record.file.id,
            originalName: record.file.originalName,
            storedName: record.file.storedName,
            mimeType: record.file.mimeType,
            sizeBytes: record.file.sizeBytes,
            uploadedById: record.file.uploadedById,
            url: `/api/files/${record.file.id}`,
            createdAt: record.file.createdAt.toISOString(),
          },
    reactions: toReactionSummaries(record.reactions, callerUserId),
    replyCount: record._count?.replies ?? 0,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Normalize the caller-supplied `limit`: fall back to PAGE_SIZE when omitted
 * or non-positive, clamp to MAX_PAGE_SIZE, and floor fractional values so the
 * SQL `LIMIT` always receives a safe positive integer.
 */
function resolveLimit(input?: number): number {
  if (input === undefined) {
    return PAGE_SIZE;
  }
  if (input < 1) {
    return PAGE_SIZE;
  }
  if (input > MAX_PAGE_SIZE) {
    return MAX_PAGE_SIZE;
  }
  return Math.floor(input);
}

/**
 * Full-text search over messages, scoped to the caller's accessible channels
 * and DMs.
 *
 * Execution:
 *   1. Validate and normalize the query (trim, reject empty/oversized) and the
 *      limit.
 *   2. Run a parameterized raw query that matches the `"contentTsv"` tsvector
 *      column with `plainto_tsquery('english', $query)`, applies the ACL
 *      filter, orders by `ts_rank` then recency, and limits the result.
 *   3. Short-circuit to an empty array when there are no hits.
 *   4. Re-fetch the matched rows with relation includes and restore the rank
 *      order in memory (Prisma's `IN` filter does not preserve order).
 *   5. Emit a `search.success` debug log carrying latency and the result count
 *      for Gate 9 / Gate 10 observability.
 *
 * @param input - the searching user's id, the query text, and an optional limit.
 * @returns the matched messages as `MessageWithAuthor` DTOs, most relevant first.
 * @throws {ValidationError} when the trimmed query is empty or exceeds
 *   MAX_SEARCH_QUERY_LENGTH characters (a defensive layer behind the route's
 *   Zod validation).
 */
export async function searchMessages(
  input: SearchMessagesInput,
): Promise<MessageWithAuthor[]> {
  const { userId } = input;
  const query = input.query.trim();
  const limit = resolveLimit(input.limit);

  if (query.length === 0) {
    throw new ValidationError('Search query must not be empty');
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new ValidationError(
      `Search query exceeds ${MAX_SEARCH_QUERY_LENGTH} characters`,
    );
  }

  const startMs = Date.now();

  // Every `${...}` below is bound as a query parameter by the `Prisma.sql`
  // tag; the table and column identifiers are static. The ACL predicate admits
  // a hit when the message belongs to a channel the user is a member of, a DM
  // the user participates in, or any public channel.
  const hits = await prisma.$queryRaw<SearchHitRow[]>(Prisma.sql`
    SELECT
      m."id" AS "id",
      ts_rank(m."contentTsv", plainto_tsquery('english', ${query})) AS "rank"
    FROM "Message" m
    WHERE
      m."contentTsv" @@ plainto_tsquery('english', ${query})
      AND (
        m."channelId" IN (
          SELECT cm."channelId"
          FROM "ChannelMember" cm
          WHERE cm."userId" = ${userId}
        )
        OR m."dmId" IN (
          SELECT dp."dmId"
          FROM "DMParticipant" dp
          WHERE dp."userId" = ${userId}
        )
        OR (
          m."channelId" IS NOT NULL
          AND m."channelId" IN (
            SELECT c."id" FROM "Channel" c WHERE c."isPrivate" = false
          )
        )
      )
    ORDER BY "rank" DESC, m."createdAt" DESC
    LIMIT ${limit}
  `);

  if (hits.length === 0) {
    logger.debug(
      { userId, queryLength: query.length, latencyMs: Date.now() - startMs, count: 0 },
      'search.success',
    );
    return [];
  }

  const idsInRankOrder = hits.map((hit) => hit.id);

  // Hydrate the matched ids with full relations. `findMany` does not honor the
  // ordering of the `in` array, so the rank order is restored below.
  const fullMessages = await prisma.message.findMany({
    where: { id: { in: idsInRankOrder } },
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  const byId = new Map<string, (typeof fullMessages)[number]>();
  for (const message of fullMessages) {
    byId.set(message.id, message);
  }

  const ordered: typeof fullMessages = [];
  for (const id of idsInRankOrder) {
    const found = byId.get(id);
    if (found !== undefined) {
      ordered.push(found);
    }
  }

  logger.debug(
    { userId, queryLength: query.length, latencyMs: Date.now() - startMs, count: ordered.length },
    'search.success',
  );

  return ordered.map((message) => toMessageDto(message, userId));
}
