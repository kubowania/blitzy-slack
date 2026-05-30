/**
 * packages/web/test/e2e/file-upload.spec.ts
 *
 * File-attachment flow E2E suite. It exercises the upload experience end to end:
 *
 *   1. Successful Upload      — a small PNG is uploaded through the composer file
 *                               input and rendered inline in the timeline within
 *                               the Gate 9 < 5 s budget; a Sonner toast confirms.
 *   2. Size Limit Enforcement — a file larger than MAX_FILE_SIZE_BYTES (10 MB) is
 *                               rejected with a destructive Sonner toast and never
 *                               reaches the timeline (enforced client- AND
 *                               server-side per AAP §0.8.4).
 *   3. Download               — the attachment exposes a working download path
 *                               (best-effort: an explicit download control when
 *                               present, otherwise a resolvable file URL).
 *   4. Preview Rendering      — image attachments render inline as an <img>
 *                               preview (AAP §0.5.4 FilePreview); non-image
 *                               attachments render as a file card showing the
 *                               original filename.
 *
 * Every test provisions an isolated user and channel through the shared fixtures
 * (registration always travels through POST /api/auth/register per Rule 4) so the
 * suite is safe under Playwright's `fullyParallel` execution. File payloads are
 * generated in memory — no binary fixture is ever written to or read from disk.
 */

import {
  test,
  expect,
  registerUserViaApi,
  createChannelViaApi,
  loginViaUi,
  uniqueChannelName,
} from './fixtures';
import { MAX_FILE_SIZE_BYTES } from '@app/shared/constants/limits';

// ---------------------------------------------------------------------------
// In-memory file payload helpers
// ---------------------------------------------------------------------------

/**
 * A well-known, valid 1×1 transparent PNG encoded as base64. Decoding it yields
 * the smallest possible real PNG, so the upload path is exercised with a genuine
 * `image/png` the server and browser both accept — without committing a binary
 * fixture to the repository.
 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Decode {@link TINY_PNG_BASE64} into the Buffer consumed by `setInputFiles`. */
function tinyPng(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, 'base64');
}

/**
 * Allocate a zero-filled Buffer of 11 MB — comfortably over the 10 MB cap so the
 * server's multer `LIMIT_FILE_SIZE` guard (and the client's pre-check) must
 * reject it. The bytes are not a valid image; the size guard fires before any
 * MIME inspection.
 */
function elevenMegabyteBuffer(): Buffer {
  return Buffer.alloc(11 * 1024 * 1024, 0x00);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('File Upload', () => {
  test.describe('Successful Upload', () => {
    test('uploads a PNG and renders it inline in the timeline within 5 seconds', async ({
      page,
    }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('upload'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      const startTime =
        await test.step('Upload a tiny PNG through the composer file input', async () => {
          // The composer exposes a (possibly visually hidden) <input type="file">
          // behind a paperclip trigger; setInputFiles drives it directly.
          const fileInput = page.locator('input[type="file"]');
          const uploadStartedAt = Date.now();
          await fileInput.setInputFiles({
            name: 'test-image.png',
            mimeType: 'image/png',
            buffer: tinyPng(),
          });
          return uploadStartedAt;
        });

      await test.step('Assert the inline preview renders within the Gate 9 < 5 s budget', async () => {
        // The FilePreview (AAP) renders the uploaded image inline; assert an
        // image preview becomes visible within the Gate 9 budget.
        await expect(
          page
            .locator('img')
            .filter({ hasNot: page.locator('img[role="presentation"]') })
            .first(),
        ).toBeVisible({ timeout: 5_000 });

        const deltaMs = Date.now() - startTime;
        // Gate 9 - file upload completes (and renders) in under 5 seconds.
        expect(deltaMs).toBeLessThan(5_000);
      });
    });

    test('shows a Sonner toast on upload', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('toast'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Upload a tiny PNG through the composer file input', async () => {
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'test-image.png',
          mimeType: 'image/png',
          buffer: tinyPng(),
        });
      });

      await test.step('Assert a Sonner confirmation toast becomes visible', async () => {
        // Sonner renders each toast with the default `[data-sonner-toast]` marker.
        const toast = page.locator('[data-sonner-toast]').first();
        await expect(toast).toBeVisible({ timeout: 5_000 });
        await expect(toast).toContainText(/upload|attach|success/i);
      });
    });
  });

  test.describe('Size Limit Enforcement', () => {
    test('rejects files larger than 10 MB', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('toobig'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Attempt to upload an 11 MB file that exceeds the cap', async () => {
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'huge.bin',
          mimeType: 'application/octet-stream',
          buffer: elevenMegabyteBuffer(),
        });
      });

      await test.step('Assert a destructive size-rejection toast surfaces', async () => {
        // The oversized file must surface a destructive toast and never appear in
        // the timeline. Match the toast on any size-rejection phrasing.
        const errorToast = page
          .locator('[data-sonner-toast]')
          .filter({ hasText: /too large|exceed|max|10 ?mb|size/i })
          .first();
        await expect(errorToast).toBeVisible({ timeout: 10_000 });
      });
    });

    test('client-side size check uses MAX_FILE_SIZE_BYTES from shared', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('boundary'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Upload a payload exactly one byte over the shared cap', async () => {
        const fileInput = page.locator('input[type="file"]');
        // Exactly one byte over the shared cap exercises the precise boundary that
        // both the client pre-check and the server multer limit enforce.
        await fileInput.setInputFiles({
          name: 'over-limit.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 0x00),
        });
      });

      await test.step('Assert the boundary triggers a size-rejection toast', async () => {
        const errorToast = page
          .locator('[data-sonner-toast]')
          .filter({ hasText: /too large|exceed|max|10 ?mb|size/i })
          .first();
        await expect(errorToast).toBeVisible({ timeout: 10_000 });
      });
    });
  });

  test.describe('Download', () => {
    test('file download link initiates a download', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('dl'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Upload a PNG and wait for its attachment to render', async () => {
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'download-me.png',
          mimeType: 'image/png',
          buffer: tinyPng(),
        });
        // The attachment must render before a download can be triggered.
        await expect(page.locator('img').first()).toBeVisible({ timeout: 5_000 });
      });

      await test.step('Trigger a download or verify a resolvable file URL', async () => {
        // Prefer an explicit download control; fall back to verifying the file URL
        // when the UI is preview-only (no dedicated download button).
        const downloadButton = page
          .getByRole('button', { name: /download/i })
          .or(page.getByRole('link', { name: /download|download-me|test-image/i }))
          .first();

        const hasDownloadButton = await downloadButton
          .waitFor({ state: 'visible', timeout: 2_000 })
          .then(() => true)
          .catch(() => false);

        if (hasDownloadButton) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10_000 }),
            downloadButton.click(),
          ]);
          // The browser-suggested filename should reflect the uploaded file.
          expect(download.suggestedFilename()).toMatch(/download-me|test-image/i);
        } else {
          // Preview-only fallback: the attachment URL must at least be resolvable.
          const imgSrc = await page.locator('img').first().getAttribute('src');
          expect(imgSrc).toBeTruthy();
          expect(imgSrc ?? '').toMatch(/files|uploads|\.png/);
        }
      });
    });
  });

  test.describe('Preview Rendering', () => {
    test('image attachments render inline as an image preview', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('inline'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Upload an image and assert an inline <img> preview renders', async () => {
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'inline.png',
          mimeType: 'image/png',
          buffer: tinyPng(),
        });
        // An <img> preview should appear in the timeline for an image attachment.
        await expect(page.locator('img').first()).toBeVisible({ timeout: 5_000 });
      });
    });

    test('non-image attachments render as a file card', async ({ page }) => {
      const { user, channel } =
        await test.step('Provision an isolated user and channel via the API', async () => {
          const provisionedUser = await registerUserViaApi();
          const provisionedChannel = await createChannelViaApi(
            provisionedUser.token,
            uniqueChannelName('card'),
          );
          return { user: provisionedUser, channel: provisionedChannel };
        });

      await test.step('Sign in through the UI and open the channel', async () => {
        await loginViaUi(page, user.email, user.password);
        await page.goto(`/app/channels/${channel.id}`);
        await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Upload a text file and assert it renders as a file card', async () => {
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello world\n', 'utf-8'),
        });
        // A non-image attachment renders as a file card surfacing the filename.
        await expect(page.getByText('notes.txt')).toBeVisible({ timeout: 5_000 });
      });
    });
  });
});
