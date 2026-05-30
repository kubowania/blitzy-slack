import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';

import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, type FileAttachment } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiClient, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * MIME types offered to the OS file picker. Restricting to images, PDFs, and
 * plain text covers the Slack proof-of-concept use-cases (screenshots, docs,
 * snippets). This attribute only filters the picker UX — the server's multer
 * middleware remains the authoritative gatekeeper for accepted file types.
 */
const ACCEPTED_FILE_TYPES = 'image/*,application/pdf,text/plain';

/**
 * Props for {@link FileUploadButton}.
 */
export interface FileUploadButtonProps {
  /**
   * Invoked with the FileAttachment metadata after a successful upload. The
   * parent MessageComposer stores the file id in its form state so the
   * subsequent send-message call links the attachment to the message.
   */
  onFileUploaded: (file: FileAttachment) => void;
  /**
   * When true, the trigger is disabled. The parent composer sets this once a
   * file is already attached so a single message carries at most one
   * attachment.
   */
  disabled?: boolean;
  /** Optional class names merged onto the trigger Button. */
  className?: string;
}

/**
 * FileUploadButton — the paperclip "attach a file" affordance rendered in the
 * MessageComposer toolbar. Clicking it opens the browser's native file picker;
 * on selection the chosen file is validated against the shared 10 MB cap,
 * uploaded via a multipart POST /api/files, and the resulting FileAttachment is
 * handed to the parent through {@link FileUploadButtonProps.onFileUploaded}.
 *
 * Sonner toasts (sharing the `file-upload` id so each replaces the previous one)
 * report the upload lifecycle, and the Button renders a Spinner in place of the
 * paperclip while the request is in flight. The hidden file input is reset on
 * every settle so that re-selecting the same file fires a fresh change event.
 */
export function FileUploadButton({
  onFileUploaded,
  disabled,
  className,
}: FileUploadButtonProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const mutation = useMutation<FileAttachment, Error, File>({
    mutationFn: async (file: File): Promise<FileAttachment> => {
      const formData = new FormData();
      formData.append('file', file);
      return apiClient.upload<FileAttachment>('/api/files', formData);
    },
    onMutate: (file) => {
      toast.loading(`Uploading ${file.name}…`, { id: 'file-upload' });
    },
    onSuccess: (uploaded, file) => {
      toast.success(`Uploaded ${file.name}`, { id: 'file-upload' });
      onFileUploaded(uploaded);
    },
    onError: (error, file) => {
      const message = error instanceof ApiError ? error.message : `Could not upload ${file.name}`;
      toast.error(message, { id: 'file-upload' });
    },
    onSettled: () => {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    },
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      toast.error(
        `File exceeds the ${MAX_FILE_SIZE_MB} MB limit (size: ${(file.size / 1024 / 1024).toFixed(1)} MB)`,
      );
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      return;
    }

    mutation.mutate(file);
  };

  const handleButtonClick = (): void => {
    inputRef.current?.click();
  };

  const isUploading = mutation.isPending;
  const isDisabled = disabled === true || isUploading;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleButtonClick}
        disabled={isDisabled}
        aria-label="Attach a file"
        className={cn(className)}
      >
        {isUploading ? <Spinner /> : <Paperclip className="size-4" />}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  );
}
