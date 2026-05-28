import { z } from 'zod';

/**
 * Validates the request body for `POST /api/dms`.
 *
 * Per AAP §0.1.1: starts a 1:1 direct-message conversation between the
 * authenticated user (from JWT) and the `targetUserId` participant.
 *
 * Per AAP §0.4.4: the underlying `DirectMessage` + `DMParticipant` models
 * enforce a unique constraint on the canonical participant pair so that
 * exactly one DM conversation exists per pair of users. The service layer
 * in `packages/api/src/services/dms.service.ts` is responsible for:
 *   1. Verifying that `targetUserId !== authenticatedUserId` (a user
 *      cannot DM themselves).
 *   2. Returning the EXISTING DM if one already exists for the pair, or
 *      CREATING a new one if not (idempotent semantics).
 *
 * `targetUserId` is validated as a Prisma-generated cuid.
 *
 * `.strict()` rejects unknown keys to prevent prototype-pollution / over-
 * posting attacks; rationale recorded in /docs/decision-log.md.
 */
export const startDmSchema = z
  .object({
    targetUserId: z.string().cuid(),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated start-DM payload.
 */
export type StartDmInput = z.infer<typeof startDmSchema>;
