/**
 * @app/api — Channel routes (AUTH REQUIRED for all endpoints).
 *
 * GET    /api/channels                              — list channels visible to the user
 * POST   /api/channels                              — create a new channel
 * POST   /api/channels/:id/join                     — add the current user to a channel
 * POST   /api/channels/:id/leave                    — remove the current user from a channel
 * GET    /api/channels/:id/messages?cursor=&limit=  — paginated channel message history
 *
 * Every handler delegates persistence and access control to
 * services/channels.service.ts; this file never touches Prisma, Redis, or
 * Socket.io directly. Channel mutations (create/join/leave) emit NO Socket.io
 * events — the AAP §0.4.5 server→client event list defines no channel-create,
 * channel-join, or channel-leave broadcast, so the web client refetches the
 * channel list on workspace open. Messages posted into a channel are broadcast
 * by routes/messages.ts (POST /api/messages), not here.
 *
 * Errors raised by the service layer (NotFoundError for an unknown channel,
 * ForbiddenError for a private-channel ACL violation, ValidationError for a
 * malformed cursor, Prisma P2002 for a duplicate channel name) propagate to the
 * centralized error handler; Express 5 forwards async rejections, so no handler
 * carries try/catch. Rationale and trade-offs for the choices in this file live
 * in /docs/decision-log.md per the Explainability rule (AAP §0.8.3), not in
 * these comments.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which adds `log: pino.Logger` to IncomingMessage (the type the
// Express Request extends) — this is what types `req.log` in the mutation
// handlers below.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { createChannelSchema } from '@app/shared/schemas/channel';
import type { CreateChannelInput } from '@app/shared/schemas/channel';
import type { Channel, ChannelSummary } from '@app/shared/types/channel';
import type { MessageWithAuthor } from '@app/shared/types/message';
import { MAX_PAGE_SIZE, PAGE_SIZE } from '@app/shared/constants/limits';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createChannel,
  joinChannel,
  leaveChannel,
  listChannelMessages,
  listChannels,
} from '../services/channels.service.js';

/**
 * Paginated channel message-history payload returned by `GET /:id/messages`:
 * one page of top-level messages (newest-first) plus the opaque cursor for the
 * next (older) page, or `null` when the timeline is exhausted. Structurally
 * identical to the service's `ListMessagesResult`, so the service result
 * serializes directly without an adapter.
 */
interface ListMessagesResponse {
  messages: MessageWithAuthor[];
  nextCursor: string | null;
}

/** Validates the `:id` path parameter as a Prisma cuid; rejects extra params. */
const channelIdParamsSchema = z.object({ id: z.string().cuid() }).strict();

/**
 * Validates the message-history query string. `cursor` is the opaque token
 * echoed back from a previous page; `limit` is coerced from its string form,
 * must be a positive integer, and is capped at `MAX_PAGE_SIZE` server-side.
 * Both are optional — the first page omits the cursor and falls back to
 * `PAGE_SIZE`.
 */
const channelMessagesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

/**
 * Channel router, mounted at `/channels` by the routes barrel so the effective
 * paths are `/api/channels*`. Exported as `router` to match the barrel
 * convention (`import { router as channelsRouter } from './channels.js'`).
 */
export const router: Router = Router();

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response<ChannelSummary[]>): Promise<void> => {
    const userId = req.user!.id;

    const channels = await listChannels(userId);

    res.status(200).json(channels);
  },
);

router.post(
  '/',
  requireAuth,
  validate(createChannelSchema),
  async (
    req: Request<unknown, Channel, CreateChannelInput>,
    res: Response<Channel>,
  ): Promise<void> => {
    const userId = req.user!.id;

    // `createdById` is sourced from the authenticated principal (not the request
    // body); the service inserts the channel and the creator's `owner` membership
    // row in a single transaction.
    const channel = await createChannel({ ...req.body, createdById: userId });

    req.log.info(
      {
        component: 'channels.route',
        event: 'create',
        userId,
        channelId: channel.id,
        name: channel.name,
        isPrivate: channel.isPrivate,
      },
      'channel created',
    );

    res.status(201).json(channel);
  },
);

router.post(
  '/:id/join',
  requireAuth,
  validate({ params: channelIdParamsSchema }),
  async (req: Request<{ id: string }>, res: Response<Channel>): Promise<void> => {
    const userId = req.user!.id;
    const channelId = req.params.id;

    const channel = await joinChannel({ channelId, userId });

    req.log.info(
      { component: 'channels.route', event: 'join', userId, channelId },
      'user joined channel',
    );

    res.status(200).json(channel);
  },
);

router.post(
  '/:id/leave',
  requireAuth,
  validate({ params: channelIdParamsSchema }),
  async (req: Request<{ id: string }>, res: Response<{ ok: true }>): Promise<void> => {
    const userId = req.user!.id;
    const channelId = req.params.id;

    await leaveChannel({ channelId, userId });

    req.log.info(
      { component: 'channels.route', event: 'leave', userId, channelId },
      'user left channel',
    );

    res.status(200).json({ ok: true });
  },
);

router.get(
  '/:id/messages',
  requireAuth,
  validate({ params: channelIdParamsSchema, query: channelMessagesQuerySchema }),
  async (
    req: Request<
      { id: string },
      ListMessagesResponse,
      unknown,
      { cursor?: string; limit?: number }
    >,
    res: Response<ListMessagesResponse>,
  ): Promise<void> => {
    const userId = req.user!.id;
    const channelId = req.params.id;
    const cursor = req.query.cursor;
    const limit = req.query.limit ?? PAGE_SIZE;

    // The service enforces channel access control (NotFoundError for an unknown
    // channel, ForbiddenError when a private channel is read by a non-member)
    // before paginating the timeline with the shared opaque (createdAt, id)
    // cursor contract; the route treats `cursor` as opaque and never decodes it.
    const result = await listChannelMessages({ channelId, userId, cursor, limit });

    res.status(200).json(result);
  },
);
