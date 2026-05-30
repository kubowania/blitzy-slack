import * as React from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  Link as LinkIcon,
  ListOrdered,
  List,
  Quote,
  Code,
  Code2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { MAX_MESSAGE_LENGTH } from '@app/shared/constants/limits';

/**
 * Public props for {@link RichTextEditor}.
 *
 * The editor is fully controlled: the parent owns `value` and receives every
 * mutation through `onChange`, and decides what submission means through
 * `onSubmit`. An optional `textareaRef` is forwarded to the underlying
 * `<textarea>` so the parent can drive imperative focus (for example, after
 * sending a message or opening a thread panel).
 */
export interface RichTextEditorProps {
  /** Current value of the editor. */
  value: string;
  /** Called whenever the value changes, with the next string value. */
  onChange: (next: string) => void;
  /**
   * Called when the user submits (Enter without Shift). The parent decides
   * whether to send the message or ignore the submission.
   */
  onSubmit: () => void;
  /** Placeholder text shown when the editor is empty, e.g. `Message #design-project`. */
  placeholder?: string;
  /** Disables the textarea and every toolbar button. */
  disabled?: boolean;
  /** Focuses the textarea once after mount. */
  autoFocus?: boolean;
  /** Forwarded className applied to the outer container. */
  className?: string;
  /** Imperative ref to the underlying textarea, for parent-driven focus control. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

/**
 * Declarative description of a single formatting toolbar button: a stable
 * React key, the accessible label surfaced in the tooltip and as `aria-label`,
 * and the lucide icon component rendered inside the button.
 */
interface FormatButtonSpec {
  readonly key: string;
  readonly label: string;
  readonly Icon: React.ComponentType<React.SVGAttributes<SVGElement>>;
}

/**
 * The ordered set of formatting controls shown in the composer toolbar. The
 * order mirrors the Slack web composer (Bold, Italic, Strikethrough, Link,
 * Numbered list, Bulleted list, Quote, Code, Code block).
 */
const FORMAT_BUTTONS: readonly FormatButtonSpec[] = [
  { key: 'bold', label: 'Bold', Icon: Bold },
  { key: 'italic', label: 'Italic', Icon: Italic },
  { key: 'strike', label: 'Strikethrough', Icon: Strikethrough },
  { key: 'link', label: 'Link', Icon: LinkIcon },
  { key: 'ol', label: 'Numbered list', Icon: ListOrdered },
  { key: 'ul', label: 'Bulleted list', Icon: List },
  { key: 'quote', label: 'Quote', Icon: Quote },
  { key: 'code', label: 'Code', Icon: Code },
  { key: 'codeBlock', label: 'Code block', Icon: Code2 },
] as const;

interface FormattingToolbarProps {
  disabled: boolean;
}

/**
 * The formatting toolbar rendered above the textarea. Each control is a
 * ghost-variant icon button wrapped in a tooltip that surfaces its label on
 * hover and focus. The buttons carry no click handler and `type` remains
 * `"button"` so they never trigger an enclosing form submission.
 */
function FormattingToolbar({ disabled }: FormattingToolbarProps): React.JSX.Element {
  return (
    <div
      data-slot="rich-text-editor-toolbar"
      className="flex items-center gap-0.5 border-b border-border px-2 py-1"
      role="toolbar"
      aria-label="Text formatting"
    >
      {FORMAT_BUTTONS.map(({ key, label, Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              disabled={disabled}
              aria-label={label}
            >
              <Icon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
      <Separator orientation="vertical" className="mx-1 h-5" />
    </div>
  );
}

/**
 * The composer's rich-text editing surface: a formatting toolbar above a
 * single autosizing textarea. Submission is keyboard-driven — `Enter` submits
 * while `Shift+Enter` inserts a newline — and IME composition is respected so
 * that confirming a composition with `Enter` never submits. Input is clamped
 * to {@link MAX_MESSAGE_LENGTH} on the client to mirror the server-side schema.
 */
export function RichTextEditor({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  autoFocus = false,
  className,
  textareaRef,
}: RichTextEditorProps): React.JSX.Element {
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);

  const setRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      if (typeof textareaRef === 'function') {
        textareaRef(node);
      } else if (textareaRef !== null && textareaRef !== undefined) {
        textareaRef.current = node;
      }
    },
    [textareaRef],
  );

  React.useEffect(() => {
    if (autoFocus) {
      localRef.current?.focus();
    }
  }, [autoFocus]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onSubmit();
      }
    },
    [onSubmit],
  );

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      if (next.length <= MAX_MESSAGE_LENGTH) {
        onChange(next);
      } else {
        onChange(next.slice(0, MAX_MESSAGE_LENGTH));
      }
    },
    [onChange],
  );

  return (
    <div
      data-slot="rich-text-editor"
      className={cn(
        'flex flex-col rounded-lg border border-input bg-background',
        'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20',
        'transition-colors',
        className,
      )}
    >
      <FormattingToolbar disabled={disabled} />
      <Textarea
        ref={setRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Message content"
        rows={1}
        className="resize-none border-0 px-3 py-2 shadow-none focus-visible:border-0 focus-visible:ring-0"
      />
    </div>
  );
}
