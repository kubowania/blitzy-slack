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
 * The set of formatting commands the toolbar can apply. Each maps to a Markdown
 * transformation in {@link applyMarkdownFormat}. `Message.content` is stored as
 * plain text, so formatting is expressed as Markdown markers in the text.
 */
type FormatKey =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'link'
  | 'ol'
  | 'ul'
  | 'quote'
  | 'code'
  | 'codeBlock';

/**
 * Result of a formatting transformation: the next editor value plus the
 * selection range to restore afterwards (so the inserted/placeholder text stays
 * selected and the caret lands sensibly).
 */
interface FormatResult {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * Inline "wrap the selection" formats: a prefix/suffix pair plus the placeholder
 * inserted (and selected) when there is no active selection.
 */
const WRAP_MARKERS: Readonly<
  Partial<Record<FormatKey, { prefix: string; suffix: string; placeholder: string }>>
> = {
  bold: { prefix: '**', suffix: '**', placeholder: 'bold text' },
  italic: { prefix: '_', suffix: '_', placeholder: 'italic text' },
  strike: { prefix: '~~', suffix: '~~', placeholder: 'strikethrough' },
  code: { prefix: '`', suffix: '`', placeholder: 'code' },
  link: { prefix: '[', suffix: '](url)', placeholder: 'link text' },
};

/**
 * Per-line prefix formats: given a zero-based line index within the selection,
 * returns the marker to prepend. `ol` numbers each line sequentially.
 */
const LINE_PREFIXES: Readonly<Partial<Record<FormatKey, (lineIndex: number) => string>>> = {
  quote: () => '> ',
  ul: () => '- ',
  ol: (lineIndex) => `${lineIndex + 1}. `,
};

/**
 * Pure Markdown transformation applied by the formatting toolbar.
 *
 * Three families are handled:
 *  - Inline wrap ({@link WRAP_MARKERS}): bold/italic/strike/code/link surround
 *    the selection (or a selected placeholder) with marker pairs.
 *  - Fenced code block: wraps the selection in triple-backtick fences on their
 *    own lines.
 *  - Line prefix ({@link LINE_PREFIXES}): quote/ul/ol expand the selection to
 *    whole lines and prepend a marker to each.
 *
 * Returns the next value and the selection range to restore. Never mutates its
 * inputs.
 *
 * @param key - The formatting command to apply.
 * @param value - The current editor text.
 * @param selectionStart - Caret/selection start index into `value`.
 * @param selectionEnd - Caret/selection end index into `value`.
 */
function applyMarkdownFormat(
  key: FormatKey,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): FormatResult {
  const selected = value.slice(selectionStart, selectionEnd);

  const wrap = WRAP_MARKERS[key];
  if (wrap !== undefined) {
    const inner = selected.length > 0 ? selected : wrap.placeholder;
    const next =
      value.slice(0, selectionStart) + wrap.prefix + inner + wrap.suffix + value.slice(selectionEnd);
    const innerStart = selectionStart + wrap.prefix.length;
    return { value: next, selectionStart: innerStart, selectionEnd: innerStart + inner.length };
  }

  if (key === 'codeBlock') {
    const fence = '```';
    const inner = selected.length > 0 ? selected : 'code';
    const block = `${fence}\n${inner}\n${fence}`;
    const next = value.slice(0, selectionStart) + block + value.slice(selectionEnd);
    const innerStart = selectionStart + fence.length + 1;
    return { value: next, selectionStart: innerStart, selectionEnd: innerStart + inner.length };
  }

  const linePrefixFor = LINE_PREFIXES[key];
  if (linePrefixFor !== undefined) {
    // Expand the selection to the whole lines it touches.
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const newlineAfter = value.indexOf('\n', selectionEnd);
    const lineEnd = newlineAfter === -1 ? value.length : newlineAfter;
    const prefixed = value
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((line, lineIndex) => `${linePrefixFor(lineIndex)}${line}`)
      .join('\n');
    const next = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    return { value: next, selectionStart: lineStart, selectionEnd: lineStart + prefixed.length };
  }

  // Defensive fallback: every FormatKey is handled above.
  return { value, selectionStart, selectionEnd };
}

/**
 * Declarative description of a single formatting toolbar button: the
 * {@link FormatKey} command it applies (also used as the React key), the
 * accessible label surfaced in the tooltip and as `aria-label`, and the lucide
 * icon component rendered inside the button.
 */
interface FormatButtonSpec {
  readonly key: FormatKey;
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
  /** Invoked with the {@link FormatKey} when a formatting button is clicked. */
  onFormat: (key: FormatKey) => void;
}

/**
 * The formatting toolbar rendered above the textarea. Each control is a
 * ghost-variant icon button wrapped in a tooltip that surfaces its label on
 * hover and focus. Clicking a button applies its Markdown transformation to the
 * textarea selection via {@link FormattingToolbarProps.onFormat}; `type`
 * remains `"button"` so a click never triggers an enclosing form submission.
 */
function FormattingToolbar({ disabled, onFormat }: FormattingToolbarProps): React.JSX.Element {
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
              onClick={() => {
                onFormat(key);
              }}
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
 *
 * The toolbar buttons apply Markdown formatting to the current textarea
 * selection via {@link applyMarkdownFormat}: the controlled `value` is updated
 * through `onChange` and the resulting selection is restored on the next frame
 * so the user can keep typing over an inserted placeholder.
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

  const handleFormat = React.useCallback(
    (key: FormatKey) => {
      const node = localRef.current;
      if (node === null) {
        return;
      }
      // `selectionStart`/`selectionEnd` are `number | null`; fall back to the
      // end of the text when the textarea has never been focused.
      const start = node.selectionStart ?? value.length;
      const end = node.selectionEnd ?? value.length;
      const result = applyMarkdownFormat(key, value, start, end);
      // Clamp to the same limit as typed input so formatting can never push the
      // value past the server-side schema bound.
      const clamped =
        result.value.length <= MAX_MESSAGE_LENGTH
          ? result.value
          : result.value.slice(0, MAX_MESSAGE_LENGTH);
      onChange(clamped);
      // Restore focus and selection after the controlled re-render commits.
      window.requestAnimationFrame(() => {
        const el = localRef.current;
        if (el === null) {
          return;
        }
        el.focus();
        const max = el.value.length;
        el.setSelectionRange(
          Math.min(result.selectionStart, max),
          Math.min(result.selectionEnd, max),
        );
      });
    },
    [value, onChange],
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
      <FormattingToolbar disabled={disabled} onFormat={handleFormat} />
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
