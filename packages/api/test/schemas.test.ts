/**
 * Unit tests for the shared Zod validation schemas
 * (`packages/shared/src/schemas/*`).
 *
 * Gate 13 (AAP §0.8.2) requires >=80% line coverage on the shared schema tree
 * in addition to the API services layer. The endpoint integration suites
 * exercise the schemas' happy paths and many failure paths through the
 * `validate` middleware, but a handful of branches are only reachable by
 * driving the schemas directly:
 *   - `typingScopeSchema`'s XOR superRefinement (the socket typing-indicator
 *     payload) is never sent in its invalid both/neither form by the socket
 *     suite, so its failure branch is otherwise uncovered.
 *   - Several boundary conditions (length ceilings, cuid rejection, `.strict()`
 *     unknown-key rejection, the presence transform's empty-entry filtering)
 *     are cheapest to assert at the schema level.
 *
 * These are PURE unit tests: no database, no Redis, no HTTP server. They import
 * the schema modules exactly as the production routes do (`@app/shared/schemas/*`,
 * resolved to source by jest.config.ts's `moduleNameMapper`), so the coverage
 * they produce is attributed to the canonical shared sources.
 */

import { loginSchema, registerSchema } from '@app/shared/schemas/auth';
import { createChannelSchema, joinChannelSchema } from '@app/shared/schemas/channel';
import { startDmSchema } from '@app/shared/schemas/dm';
import {
  reactionSchema,
  searchQuerySchema,
  sendMessageSchema,
  typingScopeSchema,
} from '@app/shared/schemas/message';
import { presenceQuerySchema } from '@app/shared/schemas/presence';
import { userSearchQuerySchema } from '@app/shared/schemas/user';
import {
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMOJI_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PRESENCE_QUERY_IDS,
  MAX_SEARCH_QUERY_LENGTH,
} from '@app/shared/constants/limits';

// Two distinct, valid Prisma-style cuids (zod's `.cuid()` accepts `c` followed
// by 8+ non-space, non-hyphen characters).
const CUID_A = 'cklq1w2e3r4t5y6u7i8o9p0a1';
const CUID_B = 'cmh9z8y7x6w5v4u3t2s1r0q9p';

describe('auth schemas', () => {
  describe('registerSchema', () => {
    it('accepts a well-formed registration payload and trims string fields', () => {
      const result = registerSchema.safeParse({
        email: '  alice@example.com  ',
        password: 'Password12345!',
        displayName: '  Alice  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('alice@example.com');
        expect(result.data.displayName).toBe('Alice');
      }
    });

    it('rejects a malformed email', () => {
      expect(
        registerSchema.safeParse({
          email: 'not-an-email',
          password: 'Password12345!',
          displayName: 'Alice',
        }).success,
      ).toBe(false);
    });

    it('rejects a password shorter than the minimum length', () => {
      expect(
        registerSchema.safeParse({
          email: 'alice@example.com',
          password: 'short',
          displayName: 'Alice',
        }).success,
      ).toBe(false);
    });

    it('rejects a displayName longer than the maximum length', () => {
      expect(
        registerSchema.safeParse({
          email: 'alice@example.com',
          password: 'Password12345!',
          displayName: 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1),
        }).success,
      ).toBe(false);
    });

    it('rejects an empty displayName', () => {
      expect(
        registerSchema.safeParse({
          email: 'alice@example.com',
          password: 'Password12345!',
          displayName: '   ',
        }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(
        registerSchema.safeParse({
          email: 'alice@example.com',
          password: 'Password12345!',
          displayName: 'Alice',
          isAdmin: true,
        }).success,
      ).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('accepts a valid login payload', () => {
      expect(
        loginSchema.safeParse({
          email: 'alice@example.com',
          password: 'x',
        }).success,
      ).toBe(true);
    });

    it('rejects an empty password', () => {
      expect(
        loginSchema.safeParse({
          email: 'alice@example.com',
          password: '',
        }).success,
      ).toBe(false);
    });

    it('rejects a malformed email', () => {
      expect(
        loginSchema.safeParse({
          email: 'nope',
          password: 'x',
        }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(
        loginSchema.safeParse({
          email: 'alice@example.com',
          password: 'x',
          remember: true,
        }).success,
      ).toBe(false);
    });
  });
});

describe('channel schemas', () => {
  describe('createChannelSchema', () => {
    it('accepts a valid public channel', () => {
      const result = createChannelSchema.safeParse({
        name: 'general',
        description: 'Company-wide announcements',
        isPrivate: false,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid private channel without a description', () => {
      expect(
        createChannelSchema.safeParse({
          name: 'leadership',
          isPrivate: true,
        }).success,
      ).toBe(true);
    });

    it('rejects a name with uppercase letters or spaces', () => {
      expect(
        createChannelSchema.safeParse({
          name: 'General Channel',
          isPrivate: false,
        }).success,
      ).toBe(false);
    });

    it('rejects a name exceeding the maximum length', () => {
      expect(
        createChannelSchema.safeParse({
          name: 'a'.repeat(MAX_CHANNEL_NAME_LENGTH + 1),
          isPrivate: false,
        }).success,
      ).toBe(false);
    });

    it('rejects a description exceeding the maximum length', () => {
      expect(
        createChannelSchema.safeParse({
          name: 'general',
          description: 'd'.repeat(MAX_CHANNEL_DESCRIPTION_LENGTH + 1),
          isPrivate: false,
        }).success,
      ).toBe(false);
    });

    it('rejects a missing isPrivate flag', () => {
      expect(createChannelSchema.safeParse({ name: 'general' }).success).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(
        createChannelSchema.safeParse({
          name: 'general',
          isPrivate: false,
          ownerId: CUID_A,
        }).success,
      ).toBe(false);
    });
  });

  describe('joinChannelSchema', () => {
    it('accepts a valid cuid channelId', () => {
      expect(joinChannelSchema.safeParse({ channelId: CUID_A }).success).toBe(true);
    });

    it('rejects a non-cuid channelId', () => {
      expect(joinChannelSchema.safeParse({ channelId: 'not-a-cuid' }).success).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(joinChannelSchema.safeParse({ channelId: CUID_A, role: 'admin' }).success).toBe(false);
    });
  });
});

describe('dm schema', () => {
  describe('startDmSchema', () => {
    it('accepts a valid cuid targetUserId', () => {
      expect(startDmSchema.safeParse({ targetUserId: CUID_A }).success).toBe(true);
    });

    it('rejects a non-cuid targetUserId', () => {
      expect(startDmSchema.safeParse({ targetUserId: '123' }).success).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(startDmSchema.safeParse({ targetUserId: CUID_A, extra: 1 }).success).toBe(false);
    });
  });
});

describe('message schemas', () => {
  describe('sendMessageSchema', () => {
    it('accepts a channel message (channelId only)', () => {
      expect(
        sendMessageSchema.safeParse({
          content: 'Hello channel',
          channelId: CUID_A,
        }).success,
      ).toBe(true);
    });

    it('accepts a DM message (dmId only) with parentId and fileId', () => {
      expect(
        sendMessageSchema.safeParse({
          content: 'Hello DM',
          dmId: CUID_A,
          parentId: CUID_B,
          fileId: CUID_B,
        }).success,
      ).toBe(true);
    });

    it('rejects a message that provides BOTH channelId and dmId', () => {
      const result = sendMessageSchema.safeParse({
        content: 'ambiguous',
        channelId: CUID_A,
        dmId: CUID_B,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('not both'))).toBe(true);
      }
    });

    it('rejects a message that provides NEITHER channelId nor dmId', () => {
      const result = sendMessageSchema.safeParse({ content: 'orphan' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('required'))).toBe(true);
      }
    });

    it('rejects empty / whitespace-only content', () => {
      expect(sendMessageSchema.safeParse({ content: '   ', channelId: CUID_A }).success).toBe(
        false,
      );
    });

    it('rejects content exceeding the maximum length', () => {
      expect(
        sendMessageSchema.safeParse({
          content: 'a'.repeat(MAX_MESSAGE_LENGTH + 1),
          channelId: CUID_A,
        }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(
        sendMessageSchema.safeParse({
          content: 'hi',
          channelId: CUID_A,
          authorId: CUID_B,
        }).success,
      ).toBe(false);
    });
  });

  describe('typingScopeSchema', () => {
    it('accepts a channel-scoped typing event', () => {
      expect(typingScopeSchema.safeParse({ channelId: CUID_A }).success).toBe(true);
    });

    it('accepts a DM-scoped typing event', () => {
      expect(typingScopeSchema.safeParse({ dmId: CUID_A }).success).toBe(true);
    });

    it('rejects a typing event that provides BOTH channelId and dmId', () => {
      const result = typingScopeSchema.safeParse({ channelId: CUID_A, dmId: CUID_B });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('not both'))).toBe(true);
      }
    });

    it('rejects a typing event that provides NEITHER channelId nor dmId', () => {
      const result = typingScopeSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('required'))).toBe(true);
      }
    });

    it('rejects unknown keys (.strict)', () => {
      expect(typingScopeSchema.safeParse({ channelId: CUID_A, userId: CUID_B }).success).toBe(
        false,
      );
    });
  });

  describe('reactionSchema', () => {
    it('accepts a standard pictographic emoji', () => {
      expect(reactionSchema.safeParse({ messageId: CUID_A, emoji: '👍' }).success).toBe(true);
    });

    it('accepts a skin-tone-modified emoji', () => {
      expect(reactionSchema.safeParse({ messageId: CUID_A, emoji: '👍🏽' }).success).toBe(true);
    });

    it('accepts a keycap emoji', () => {
      expect(reactionSchema.safeParse({ messageId: CUID_A, emoji: '3️⃣' }).success).toBe(true);
    });

    it('rejects a bare digit (Emoji property but no pictographic element)', () => {
      expect(reactionSchema.safeParse({ messageId: CUID_A, emoji: '3' }).success).toBe(false);
    });

    it('rejects a plain ASCII letter', () => {
      expect(reactionSchema.safeParse({ messageId: CUID_A, emoji: 'a' }).success).toBe(false);
    });

    it('rejects an emoji string exceeding the maximum length', () => {
      expect(
        reactionSchema.safeParse({
          messageId: CUID_A,
          emoji: '😀'.repeat(MAX_EMOJI_LENGTH),
        }).success,
      ).toBe(false);
    });

    it('rejects a non-cuid messageId', () => {
      expect(reactionSchema.safeParse({ messageId: 'nope', emoji: '👍' }).success).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(
        reactionSchema.safeParse({
          messageId: CUID_A,
          emoji: '👍',
          userId: CUID_B,
        }).success,
      ).toBe(false);
    });
  });

  describe('searchQuerySchema', () => {
    it('accepts and trims a valid query', () => {
      const result = searchQuerySchema.safeParse({ q: '  hello  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBe('hello');
      }
    });

    it('rejects an empty query', () => {
      expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    });

    it('rejects a query exceeding the maximum length', () => {
      expect(
        searchQuerySchema.safeParse({
          q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1),
        }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(searchQuerySchema.safeParse({ q: 'hello', limit: 10 }).success).toBe(false);
    });
  });
});

describe('presence schema', () => {
  describe('presenceQuerySchema', () => {
    it('accepts a single cuid', () => {
      const result = presenceQuerySchema.safeParse({ userIds: CUID_A });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userIds).toEqual([CUID_A]);
      }
    });

    it('accepts multiple cuids and filters empty / whitespace entries', () => {
      const result = presenceQuerySchema.safeParse({ userIds: `${CUID_A}, ,  ,${CUID_B}` });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userIds).toEqual([CUID_A, CUID_B]);
      }
    });

    it('rejects an empty userIds string before transform', () => {
      expect(presenceQuerySchema.safeParse({ userIds: '   ' }).success).toBe(false);
    });

    it('rejects a list containing a non-cuid entry', () => {
      expect(presenceQuerySchema.safeParse({ userIds: `${CUID_A},not-a-cuid` }).success).toBe(
        false,
      );
    });

    it('rejects a list exceeding the maximum number of ids', () => {
      const tooMany = Array.from({ length: MAX_PRESENCE_QUERY_IDS + 1 }, () => CUID_A).join(',');
      expect(presenceQuerySchema.safeParse({ userIds: tooMany }).success).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(presenceQuerySchema.safeParse({ userIds: CUID_A, scope: 'all' }).success).toBe(false);
    });
  });
});

describe('user schema', () => {
  describe('userSearchQuerySchema', () => {
    it('accepts an absent q (optional)', () => {
      expect(userSearchQuerySchema.safeParse({}).success).toBe(true);
    });

    it('accepts and trims a present q', () => {
      const result = userSearchQuerySchema.safeParse({ q: '  alice  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.q).toBe('alice');
      }
    });

    it('rejects a q exceeding the maximum length', () => {
      expect(
        userSearchQuerySchema.safeParse({
          q: 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1),
        }).success,
      ).toBe(false);
    });

    it('rejects unknown keys (.strict)', () => {
      expect(userSearchQuerySchema.safeParse({ q: 'alice', page: 2 }).success).toBe(false);
    });
  });
});
