/**
 * Presence fan-out helper for the `@app/api` package.
 *
 * A presence transition (offline → online on connect, online → away/offline on
 * idle, → offline on last-socket disconnect) is only useful if the OTHER users
 * who can see the subject render the change. Broadcasting solely to the
 * subject's own `user:<id>` room — as the naive handler did — updates only the
 * subject's own tabs and leaves every peer's sidebar / DM list stale.
 *
 * {@link broadcastPresenceUpdate} resolves the subject's authorized audience
 * (every channel they are a MEMBER of and every DM they participate in, plus
 * their own `user:<id>` room) and emits a single `presence:update` to that
 * room set. `io.to([...rooms])` de-duplicates recipients, so a peer who shares
 * several channels with the subject still receives exactly one event. The
 * Socket.io Redis adapter (AAP Rule 2) fans the emit out to peers connected to
 * any API instance.
 *
 * The audience is resolved through the SAME membership rule `assertChannelAccess`
 * enforces (channel membership + DM participation), so a presence signal is
 * never leaked to a user who shares no channel or DM with the subject.
 *
 * Layering: this module touches neither Prisma nor Redis directly — it composes
 * the `listMemberChannelIds` / `listDmIds` service helpers with the room-key
 * builders. Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Server } from 'socket.io';

import { listMemberChannelIds } from '../services/channels.service.js';
import { listDmIds } from '../services/dms.service.js';
import { channelRoom, dmRoom, userRoom } from './rooms.js';
import { PRESENCE_UPDATE } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import type { PresenceUpdate } from '@app/shared/types/presence';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Broadcast a `presence:update` to every user authorized to observe the
 * subject's presence: the subject's own `user:<id>` room, each channel they are
 * a member of, and each DM they participate in.
 *
 * Resolves the audience via the service layer on every call so a freshly-joined
 * channel or newly-started DM is always included. Returns once the emit has been
 * issued; the caller (the presence handler on a transition, or the disconnect
 * handler on the last-socket offline) decides whether to await.
 *
 * @param io - The typed Socket.io server used for the room broadcast.
 * @param userId - The subject whose presence changed; both the audience anchor
 *   and the `update.userId`.
 * @param update - The fully-formed `presence:update` payload to emit.
 */
export async function broadcastPresenceUpdate(
  io: AppServer,
  userId: string,
  update: PresenceUpdate,
): Promise<void> {
  const [channelIds, dmIds] = await Promise.all([listMemberChannelIds(userId), listDmIds(userId)]);

  const rooms = [
    userRoom(userId),
    ...channelIds.map((channelId) => channelRoom(channelId)),
    ...dmIds.map((dmId) => dmRoom(dmId)),
  ];

  io.to(rooms).emit(PRESENCE_UPDATE, update);
}
