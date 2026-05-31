import { useState } from 'react';
import {
  Download,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Image as ImageIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import type { FileAttachment } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuthenticatedImage } from '@/hooks/useAuthenticatedImage';
import { downloadFile } from '@/lib/file-download';
import { cn } from '@/lib/utils';

/**
 * Props for {@link FilePreview}.
 */
export interface FilePreviewProps {
  /**
   * File metadata to render. Supplied by the parent Message component from the
   * hydrated `MessageWithAuthor.file` field (never fetched here).
   */
  file: FileAttachment;
  /**
   * Optional class names merged onto the outer Card — used by the parent to
   * constrain the preview's max-width or spacing within the message row.
   */
  className?: string;
}

/**
 * Resolves a lucide icon component for a file's MIME type. Image, video,
 * audio, text and common code types map to dedicated icons; everything else
 * (PDF, octet-stream, office documents, …) falls back to the generic file
 * icon.
 */
function selectFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.startsWith('text/')) return FileText;
  if (mimeType === 'application/json') return FileCode;
  if (mimeType.startsWith('application/javascript')) return FileCode;
  if (mimeType.startsWith('application/typescript')) return FileCode;
  return FileIcon;
}

/**
 * Formats a byte count as a human-readable string with a unit suffix
 * (`B` / `KB` / `MB` / `GB`). Sub-kilobyte values render as whole bytes; all
 * larger units use one-decimal precision.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * FilePreview renders a single file attachment from a Message. Image files
 * render inline (and open in a Dialog-based lightbox on click); non-image files
 * render as a card tile with a type icon, filename, size, and a download
 * button.
 *
 * File bytes are served by the auth-gated `GET /api/files/:id` route, which a
 * raw `<img src>` or anchor `href` cannot reach (no bearer token → 401). All
 * access here therefore goes through the authenticated API client: images are
 * fetched as blobs and shown via object URLs ({@link useAuthenticatedImage}),
 * and downloads stream the bytes through {@link downloadFile}.
 */
export function FilePreview({ file, className }: FilePreviewProps) {
  const isImage = file.mimeType.startsWith('image/');
  if (isImage) {
    return <ImageFilePreview file={file} className={className} />;
  }
  return <FileCard file={file} className={className} />;
}

/**
 * Inline image attachment: fetches the bitmap through the authenticated API
 * client, shows a Skeleton while loading, and opens a lightbox Dialog (reusing
 * the same object URL) on click. Falls back to the downloadable {@link FileCard}
 * if the authenticated fetch fails.
 */
function ImageFilePreview({ file, className }: FilePreviewProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { objectUrl, status } = useAuthenticatedImage(file.url);

  // If the bitmap could not be fetched (e.g., revoked access or a network
  // error), degrade to the downloadable card so the file is still reachable.
  if (status === 'error') {
    return <FileCard file={file} className={className} />;
  }

  return (
    <>
      <Card className={cn('overflow-hidden p-0', className)}>
        <CardContent className="p-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (objectUrl !== null) {
                setLightboxOpen(true);
              }
            }}
            aria-label={`Open ${file.originalName} at full size`}
            className="block h-auto w-full overflow-hidden rounded-md p-0 text-left hover:bg-transparent"
          >
            <div className="relative">
              {status === 'loading' ? <Skeleton className="h-48 w-full max-w-md" /> : null}
              {status === 'loaded' && objectUrl !== null ? (
                <img
                  src={objectUrl}
                  alt={file.originalName}
                  className="block max-h-96 max-w-md rounded-md object-contain"
                />
              ) : null}
            </div>
          </Button>
        </CardContent>
      </Card>
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-4xl" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{file.originalName}</DialogTitle>
          {objectUrl !== null ? (
            <img
              src={objectUrl}
              alt={file.originalName}
              className="block h-auto max-h-[80vh] w-auto max-w-full object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Non-image attachment (and the fallback for a failed image fetch): a card tile
 * with a type icon, truncated filename, human-readable size, and a download
 * button. The button streams the file through the authenticated API client
 * ({@link downloadFile}) rather than a raw anchor, surfacing failures via toast.
 */
function FileCard({ file, className }: FilePreviewProps) {
  const [downloading, setDownloading] = useState(false);
  const Icon = selectFileIcon(file.mimeType);

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadFile(file);
    } catch (error) {
      toast.error('Download failed', {
        description: error instanceof Error ? error.message : 'Unable to download the file.',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className={cn('w-fit max-w-md p-0', className)}>
      <CardContent className="flex items-center gap-3 p-3">
        <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={file.originalName}>
            {file.originalName}
          </span>
          <span className="text-muted-foreground block text-xs">
            {formatFileSize(file.sizeBytes)}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void handleDownload();
          }}
          disabled={downloading}
          aria-label={`Download ${file.originalName}`}
        >
          {downloading ? <Spinner className="size-4" /> : <Download className="size-4" />}
          <span className="sr-only sm:not-sr-only">Download</span>
        </Button>
      </CardContent>
    </Card>
  );
}
