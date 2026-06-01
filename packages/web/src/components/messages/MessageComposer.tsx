/**
 * MessageComposer — the bottom-of-channel message input box (AAP §0.6.3,
 * screenshot "Slack web Jul 2024 29"). It is the single authoring surface for
 * channel messages, direct messages, and thread replies, selected by which of
 * `channelId` / `dmId` / `parentMessageId` the caller supplies.
 *
 * Composition:
 *   - {@link RichTextEditor} renders the text body with its own formatting
 *     toolbar and Enter / Shift+Enter submit semantics. The composer draws the
 *     outer border, so the editor's own border is removed through `className`.
 *   - {@link EmojiPicker} (the smile button) inserts a Unicode emoji at the
 *     current caret position in the body.
 *   - {@link FileUploadButton} uploads a single attachment to `/api/files` and
 *     {@link FilePreview} shows the attached file with a remove control — one
 *     file per message.
 *   - The Send button submits the form.
 *
 * Form state is owned by react-hook-form with `zodResolver(sendMessageSchema)`,
 * so the client enforces exactly the rules the API validates (Gate 12). On
 * submit the composer POSTs to the single `/api/messages` endpoint with the
 * scope (channelId / dmId / parentId) carried in the request body; the server
 * then emits a `message:new` Socket.io event that the message-list cache
 * subscriber applies, so the new message appears in the timeline without a
 * manual cache write (Rule 2 — real-time fan-out, never polling). Typing
 * notifications are emitted through {@link useTyping} while composing and
 * stopped on submit.
 *
 * Design rationale for this component is recorded in /docs/decision-log.md, the
 * single source of truth for such decisions, not in these comments.
 */
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Smile, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RichTextEditor } from './RichTextEditor';
import { EmojiPicker } from './EmojiPicker';
import { TypingIndicator } from './TypingIndicator';
import { FileUploadButton } from '@/components/files/FileUploadButton';
import { FilePreview } from '@/components/files/FilePreview';
import { useTyping } from '@/hooks/useTyping';
import { apiClient, type ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { sendMessageSchema, type SendMessageInput } from '@app/shared/schemas/message';
import type { FileAttachment, MessageWithAuthor } from '@app/shared/types/message';

/**
 * Public props for {@link MessageComposer}.
 *
 * Exactly one of `channelId`, `dmId`, or `parentMessageId` selects the send
 * scope. In thread mode the caller passes `parentMessageId` together with the
 * parent's `channelId` or `dmId` so typing events stay scoped to the parent
 * conversation.
 */
export interface MessageComposerProps {
  /** Channel scope. Mutually exclusive with `dmId` and `parentMessageId`. */
  channelId?: string;
  /** DM scope. Mutually exclusive with `channelId` and `parentMessageId`. */
  dmId?: string;
  /**
   * Thread parent ID. When provided, the composer sends the same canonical
   * `POST /api/messages` request as a channel/DM message but adds `parentId`
   * to the body so the server attaches the reply to its parent. Used by the
   * thread panel.
   */
  parentMessageId?: string;
  /**
   * Display name of the scope used for the placeholder (e.g. "design-project"
   * for `Message #design-project`, or "Alice" for `Message Alice` in a DM).
   */
  scopeName?: string;
  /**
   * If `true`, suppresses the {@link TypingIndicator} rendered above the
   * composer. Useful when the parent already renders one. Defaults to `false`.
   */
  hideTypingIndicator?: boolean;
  /** Optional className for the outer wrapper. */
  className?: string;
}

/**
 * The bottom-of-channel message composer. See the module docblock for the full
 * behavioral contract.
 */
export function MessageComposer({
  channelId,
  dmId,
  parentMessageId,
  scopeName,
  hideTypingIndicator = false,
  className,
}: MessageComposerProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [emojiOpen, setEmojiOpen] = React.useState<boolean>(false);
  const [attachedFile, setAttachedFile] = React.useState<FileAttachment | null>(null);

  // Determine scope for typing events. For thread replies, the scope follows
  // the parent's channelId/dmId (the caller passes both in thread mode).
  const typingScope = channelId !== undefined ? { channelId } : { dmId };
  const { notifyTyping, stopTyping } = useTyping(typingScope);

  // Canonical react-hook-form input. parentMessageId is only set in thread
  // mode; the Zod XOR refinement requires exactly one of channelId / dmId.
  const form = useForm<SendMessageInput>({
    resolver: zodResolver(sendMessageSchema),
    defaultValues: {
      content: '',
      channelId,
      dmId,
      parentId: parentMessageId,
      fileId: undefined,
    },
    mode: 'onChange',
  });

  // Keep form fields in sync when the props change (e.g. the user navigates
  // between channels) and drop any in-progress attachment.
  React.useEffect(() => {
    form.reset({
      content: '',
      channelId,
      dmId,
      parentId: parentMessageId,
      fileId: undefined,
    });
    setAttachedFile(null);
  }, [channelId, dmId, parentMessageId, form]);

  const sendMutation = useMutation<MessageWithAuthor, ApiError, SendMessageInput>({
    mutationFn: async (payload: SendMessageInput): Promise<MessageWithAuthor> => {
      // Single canonical write endpoint. The API exposes only POST /api/messages
      // (there are no /api/channels/:id/messages, /api/dms/:id/messages, or
      // /api/messages/:id/replies write routes). The server derives the scope
      // from the BODY's channelId / dmId / parentId, which the form's
      // defaultValues already populate, so the validated payload is sent verbatim.
      return apiClient.post<MessageWithAuthor>('/api/messages', payload);
    },
    onError: (error: ApiError) => {
      toast.error('Failed to send message', { description: error.message });
    },
    onSuccess: () => {
      // Reset the form on success. The socket-driven cache update renders the
      // new message in the timeline; no manual cache write is needed here.
      form.reset({
        content: '',
        channelId,
        dmId,
        parentId: parentMessageId,
        fileId: undefined,
      });
      setAttachedFile(null);
      stopTyping();
      // Refocus the textarea so the user can immediately keep typing.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      // Passive safety net; the socket subscriber owns real-time updates.
      void queryClient.invalidateQueries({
        queryKey: ['messages'],
        exact: false,
        refetchType: 'none',
      });
    },
  });

  // Mirror the form's content field into the controlled RichTextEditor.
  const content = form.watch('content');

  const handleContentChange = React.useCallback(
    (next: string) => {
      form.setValue('content', next, { shouldValidate: true });
      if (next.trim().length > 0) {
        notifyTyping();
      }
    },
    [form, notifyTyping],
  );

  const submit = React.useCallback(() => {
    const values = form.getValues();
    if (!form.formState.isValid || values.content.trim().length === 0) {
      return;
    }
    sendMutation.mutate({
      ...values,
      content: values.content.trim(),
    });
  }, [form, sendMutation]);

  // Insert the chosen emoji at the current caret position in the textarea.
  const handleEmojiSelect = React.useCallback(
    (emoji: string) => {
      const ta = textareaRef.current;
      if (ta === null) {
        // Fallback when the textarea ref is not yet attached: append to the end.
        form.setValue('content', `${content}${emoji}`, { shouldValidate: true });
        return;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = content.slice(0, start) + emoji + content.slice(end);
      form.setValue('content', next, { shouldValidate: true });
      // Restore the caret to just after the inserted emoji.
      requestAnimationFrame(() => {
        if (ta !== null) {
          ta.focus();
          const newPos = start + emoji.length;
          ta.setSelectionRange(newPos, newPos);
        }
      });
    },
    [content, form],
  );

  const handleFileUploaded = React.useCallback(
    (file: FileAttachment) => {
      setAttachedFile(file);
      form.setValue('fileId', file.id, { shouldValidate: true });
    },
    [form],
  );

  const handleFileRemove = React.useCallback(() => {
    setAttachedFile(null);
    form.setValue('fileId', undefined, { shouldValidate: true });
  }, [form]);

  const placeholder = computePlaceholder({ channelId, dmId, parentMessageId, scopeName });
  const isSubmitDisabled =
    sendMutation.isPending || content.trim().length === 0 || !form.formState.isValid;

  return (
    <div data-slot="message-composer" className={cn('flex flex-col', className)}>
      {!hideTypingIndicator ? <TypingIndicator channelId={channelId} dmId={dmId} /> : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="px-4 pb-4"
        noValidate
      >
        <div className="flex flex-col rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 transition-colors">
          {/* The composer owns the outer border, so the editor's own border,
              ring, and rounding are removed via the className override. */}
          <RichTextEditor
            value={content}
            onChange={handleContentChange}
            onSubmit={submit}
            placeholder={placeholder}
            disabled={sendMutation.isPending}
            textareaRef={textareaRef}
            className="border-0 focus-within:border-0 focus-within:ring-0 rounded-none"
          />

          {/* Attached-file preview, between the editor body and the toolbar. */}
          {attachedFile !== null ? (
            <div className="px-3 pb-2 flex items-start gap-2">
              <div className="flex-1">
                <FilePreview file={attachedFile} />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={handleFileRemove}
                    aria-label="Remove attachment"
                  >
                    <X className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove attachment</TooltipContent>
              </Tooltip>
            </div>
          ) : null}

          {/* Bottom toolbar. */}
          <div className="flex items-center justify-between px-2 py-1.5 border-t border-border">
            {/* Left cluster: emoji picker and file upload — the only in-scope
                composer actions for this proof-of-concept. */}
            <div
              className="flex items-center gap-0.5"
              role="toolbar"
              aria-label="Composer actions"
            >
              <EmojiPicker
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={sendMutation.isPending}
                    aria-label="Add emoji"
                  >
                    <Smile className="size-4" />
                  </Button>
                }
                onSelect={handleEmojiSelect}
                open={emojiOpen}
                onOpenChange={setEmojiOpen}
                align="start"
                side="top"
              />

              <FileUploadButton
                onFileUploaded={handleFileUploaded}
                disabled={attachedFile !== null || sendMutation.isPending}
              />
            </div>

            {/* Right cluster: the send button. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  className="size-8"
                  disabled={isSubmitDisabled}
                  aria-label="Send message"
                >
                  <Send className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * Arguments accepted by {@link computePlaceholder}.
 */
interface PlaceholderArgs {
  channelId?: string;
  dmId?: string;
  parentMessageId?: string;
  scopeName?: string;
}

/**
 * Computes the composer placeholder text for the active scope: `Reply...` in a
 * thread, `Message #<channel>` in a channel, and `Message <name>` in a DM,
 * falling back to generic text when no scope name is available.
 */
function computePlaceholder({
  channelId,
  dmId,
  parentMessageId,
  scopeName,
}: PlaceholderArgs): string {
  if (parentMessageId !== undefined) {
    return 'Reply...';
  }
  if (channelId !== undefined) {
    if (scopeName !== undefined && scopeName.length > 0) {
      return `Message #${scopeName}`;
    }
    return 'Message channel';
  }
  if (dmId !== undefined) {
    if (scopeName !== undefined && scopeName.length > 0) {
      return `Message ${scopeName}`;
    }
    return 'Message';
  }
  return 'Message';
}
