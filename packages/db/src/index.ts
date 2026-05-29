/**
 * `@app/db` barrel re-export — the public surface of the database package.
 *
 * Consumers (most prominently `@app/api`) import from `@app/db`, which resolves
 * to this module via the package's `main` / `types` / `exports["."]` entry.
 *
 * What this module re-exports (AAP §0.6.1 Group 2):
 *
 *   1. The singleton `prisma` instance and the `disconnectPrisma` graceful-
 *      shutdown helper, both from the sibling `./client.js` module.
 *   2. The `PrismaClient` class and the `Prisma` namespace from `@prisma/client`
 *      as runtime values; the namespace also carries generated input/where/select
 *      types (e.g. `Prisma.UserCreateInput`) and the `PrismaClientKnownRequestError`
 *      error family.
 *   3. The 8 generated model TYPES for the entities defined in
 *      `packages/db/prisma/schema.prisma` (AAP §0.4.4): `User`, `Channel`,
 *      `ChannelMember`, `DirectMessage`, `DMParticipant`, `Message`,
 *      `MessageReaction`, `File`.
 *
 * Rationale for these re-export choices is recorded in /docs/decision-log.md,
 * not here.
 */

// 1. Singleton instance and graceful-shutdown helper (runtime values), both
//    defined in the sibling client module. The `.js` extension is mandatory
//    under `module: NodeNext` — TypeScript does not rewrite the specifier.
export { prisma, disconnectPrisma } from './client.js';

// 2. PrismaClient class and the Prisma namespace, re-exported as runtime values.
export { PrismaClient, Prisma } from '@prisma/client';

// 3. Generated model types — type-only re-exports. `isolatedModules` and the
//    `@typescript-eslint/consistent-type-imports` rule both require the `type`
//    keyword when re-exporting type-only symbols.
export type {
  User,
  Channel,
  ChannelMember,
  DirectMessage,
  DMParticipant,
  Message,
  MessageReaction,
  File,
} from '@prisma/client';
