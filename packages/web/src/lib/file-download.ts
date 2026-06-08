/**
 * Secure file-download helper for the Blitzy Slack web client (`@app/web`).
 *
 * The API's `GET /api/files/:id` route is auth-gated (`Authorization: Bearer
 * <jwt>`), so a browser cannot download an attachment through a plain anchor
 * `href` — the raw request carries no token and is rejected with 401. This
 * helper instead fetches the bytes through the authenticated {@link apiClient}
 * (token attached, correct `VITE_API_URL` origin), wraps them in an object URL,
 * and drives a synthetic `<a download>` click so the browser saves the file
 * with its original name.
 *
 * Design rationale lives in /docs/decision-log.md per the Explainability rule
 * (AAP §0.8.3), not in these comments.
 */
import type { FileAttachment } from '@app/shared/types/message';

import { apiClient } from '@/lib/api-client';

/**
 * Downloads an authenticated file attachment to the user's device.
 *
 * Fetches the bytes via `apiClient.getBlob` (bearer token attached), creates a
 * temporary object URL, and triggers a download through a programmatic anchor
 * click. The object URL is revoked after a short delay so the browser has time
 * to start the transfer before the blob is released (immediate revocation can
 * cancel the download in some engines).
 *
 * Rejects with the `ApiError` thrown by `apiClient.getBlob` (e.g., a 403 when
 * the caller lacks access, or a network failure); callers surface it to the
 * user, typically via a Sonner toast.
 *
 * @param file - The attachment to download; only `url` and `originalName` are read.
 */
export async function downloadFile(
  file: Pick<FileAttachment, 'url' | 'originalName'>,
): Promise<void> {
  const blob = await apiClient.getBlob(file.url);
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = file.originalName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Defer revocation so the browser has initiated the download before the
  // object URL is released; immediate revocation can cancel it in some engines.
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 10_000);
}
