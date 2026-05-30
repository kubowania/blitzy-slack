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

import type { FileAttachment } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
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
 * render inline with a Skeleton overlay until the bitmap loads and open in a
 * Dialog-based lightbox on click; non-image files render as a card tile with a
 * type icon, truncated filename, human-readable size, and a download button
 * backed by a native `<a download>` anchor.
 */
export function FilePreview({ file, className }: FilePreviewProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const apiBaseUrl = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  const absoluteUrl = `${apiBaseUrl}${file.url}`;
  const isImage = file.mimeType.startsWith('image/');

  if (isImage) {
    return (
      <>
        <Card className={cn('overflow-hidden p-0', className)}>
          <CardContent className="p-2">
            <button
              type="button"
              onClick={() => {
                setLightboxOpen(true);
              }}
              className="block w-full text-left"
              aria-label={`Open ${file.originalName} at full size`}
            >
              <div className="relative">
                {!imageLoaded && <Skeleton className="absolute inset-0 h-full w-full" />}
                <img
                  src={absoluteUrl}
                  alt={file.originalName}
                  onLoad={() => {
                    setImageLoaded(true);
                  }}
                  className={cn(
                    'block max-h-96 max-w-md rounded-md object-contain transition-opacity',
                    imageLoaded ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </div>
            </button>
          </CardContent>
        </Card>
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-w-4xl" aria-describedby={undefined}>
            <DialogTitle className="sr-only">{file.originalName}</DialogTitle>
            <img
              src={absoluteUrl}
              alt={file.originalName}
              className="block h-auto max-h-[80vh] w-auto max-w-full object-contain"
            />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  const Icon = selectFileIcon(file.mimeType);
  return (
    <Card className={cn('w-fit max-w-md', className)}>
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
        <Button asChild variant="outline" size="sm" aria-label={`Download ${file.originalName}`}>
          <a href={absoluteUrl} download={file.originalName}>
            <Download className="size-4" />
            <span className="sr-only sm:not-sr-only">Download</span>
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
