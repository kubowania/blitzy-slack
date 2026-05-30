import * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * EmojiPicker — a Popover-hosted grid of Unicode emojis the user can select.
 *
 * shadcn/ui ships no emoji picker primitive, so this component composes one
 * from the shadcn `Popover`, `Tabs`, `Input`, `ScrollArea`, and `Button`
 * primitives. It is consumed in two contexts:
 *
 *  1. The message composer's smile button — to insert an emoji at the caret.
 *  2. The reaction picker — to attach an emoji reaction to a message.
 *
 * This file owns ONLY the picker overlay (search input + tabbed category grid).
 * Supplying the element that opens the picker is the consumer's responsibility:
 * the consumer passes it as the `trigger` prop, which is rendered inside a
 * `PopoverTrigger asChild`.
 *
 * For this proof-of-concept the emoji data set is a curated list of popular
 * Unicode emojis grouped into nine categories; the full Unicode set and
 * name-indexed search are deferred (the deferral is recorded in
 * /docs/decision-log.md, the single source of truth for such decisions).
 */

/**
 * The nine emoji category keys surfaced as tabs in the picker. This union is
 * exhaustive: every entry in {@link EMOJI_CATEGORIES} uses one of these keys
 * and the active-category state is typed against it.
 */
type EmojiCategoryKey =
  | 'smileys'
  | 'people'
  | 'hearts'
  | 'animals'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols';

/**
 * A single emoji category: a stable {@link EmojiCategoryKey}, a human-readable
 * label (used as the group's accessible name and section heading), the emoji
 * rendered inside the category's `TabsTrigger`, and the ordered list of emojis
 * shown in that category's grid.
 */
interface EmojiCategory {
  readonly key: EmojiCategoryKey;
  readonly label: string;
  /** The emoji displayed in the category's TabsTrigger. */
  readonly tabIcon: string;
  readonly emojis: readonly string[];
}

/**
 * The curated emoji data set rendered by the picker. Declared `as const` so the
 * literal keys narrow to {@link EmojiCategoryKey} and every nested array is
 * deeply immutable at module scope.
 */
const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  {
    key: 'smileys',
    label: 'Smileys',
    tabIcon: '😀',
    emojis: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '😂',
      '🤣',
      '😊',
      '😇',
      '🙂',
      '😉',
      '😌',
      '😍',
      '🥰',
      '😘',
      '😎',
      '🤩',
      '🥳',
      '🤔',
      '🤨',
      '😐',
      '😑',
      '😶',
      '🙄',
      '😏',
      '😣',
      '😥',
      '😮',
      '🤐',
      '😯',
      '😪',
    ],
  },
  {
    key: 'people',
    label: 'People',
    tabIcon: '👋',
    emojis: ['👍', '👎', '👏', '🙏', '🤝', '💪', '👋', '🫡', '✌️', '🤞', '🤟', '🤘'],
  },
  {
    key: 'hearts',
    label: 'Hearts',
    tabIcon: '❤️',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕'],
  },
  {
    key: 'animals',
    label: 'Animals',
    tabIcon: '🐶',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮'],
  },
  {
    key: 'food',
    label: 'Food',
    tabIcon: '🍕',
    emojis: ['🍕', '🍔', '🍟', '🌭', '🥗', '🍰', '🍩', '🍪', '🍫', '☕', '🍺', '🥂'],
  },
  {
    key: 'activities',
    label: 'Activities',
    tabIcon: '⚽',
    emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🎮', '🎲', '🎯', '🎉', '🎊', '🎁', '🏆'],
  },
  {
    key: 'travel',
    label: 'Travel',
    tabIcon: '✈️',
    emojis: ['✈️', '🚀', '🚗', '🚕', '🚌', '🚢', '⛵', '🚲', '🛵', '🏠', '🏢', '🌍'],
  },
  {
    key: 'objects',
    label: 'Objects',
    tabIcon: '💻',
    emojis: ['📱', '💻', '⌨️', '🖥️', '🖱️', '📦', '📚', '✏️', '📝', '📌', '📎', '🔑'],
  },
  {
    key: 'symbols',
    label: 'Symbols',
    tabIcon: '✅',
    emojis: ['✅', '❌', '⚠️', '💯', '🔥', '✨', '⭐', '🌟', '❗', '❓', '💡', '🚀'],
  },
] as const;

/** Flattened list of every emoji across all categories, used by search. */
const ALL_EMOJIS: readonly string[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/**
 * Public props for {@link EmojiPicker}. The component supports both controlled
 * and uncontrolled open state: omit `open`/`onOpenChange` to let the picker
 * manage its own visibility, or supply both to drive it from a parent.
 */
export interface EmojiPickerProps {
  /** Trigger element (the consumer-supplied button that opens the picker). */
  trigger: React.ReactNode;
  /** Called when the user selects an emoji. */
  onSelect: (emoji: string) => void;
  /** Controlled-open mode (optional). If omitted, internal state is used. */
  open?: boolean;
  /** Controlled-open setter (paired with `open`). */
  onOpenChange?: (open: boolean) => void;
  /** Popover `align` prop, defaults to 'start'. */
  align?: 'start' | 'center' | 'end';
  /** Popover `side` prop, defaults to 'top'. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Optional className for the PopoverContent. */
  contentClassName?: string;
}

/**
 * The emoji picker overlay. Renders the consumer's `trigger` inside a
 * `PopoverTrigger` and, when open, a search input above either the filtered
 * search results or the tabbed category grid.
 */
export function EmojiPicker({
  trigger,
  onSelect,
  open,
  onOpenChange,
  align = 'start',
  side = 'top',
  contentClassName,
}: EmojiPickerProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = React.useState<boolean>(false);
  const isControlled = open !== undefined;
  const actualOpen = isControlled ? open : internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      if (onOpenChange !== undefined) {
        onOpenChange(next);
      }
    },
    [isControlled, onOpenChange],
  );

  const [query, setQuery] = React.useState<string>('');
  const [activeCategory, setActiveCategory] = React.useState<EmojiCategoryKey>('smileys');

  // Reset the search query and active category whenever the picker closes so
  // the next open starts from a clean state.
  React.useEffect(() => {
    if (!actualOpen) {
      setQuery('');
      setActiveCategory('smileys');
    }
  }, [actualOpen]);

  const trimmedQuery = query.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  // Search matches by the emoji character itself (char-match only). Name-indexed
  // search is deferred for the PoC; the deferral is recorded in
  // /docs/decision-log.md.
  const searchResults: readonly string[] = React.useMemo(() => {
    if (!isSearching) {
      return [];
    }
    return ALL_EMOJIS.filter((emoji) => emoji.includes(trimmedQuery));
  }, [isSearching, trimmedQuery]);

  const handleSelect = React.useCallback(
    (emoji: string) => {
      onSelect(emoji);
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  return (
    <Popover open={actualOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        className={cn('w-80 p-0', contentClassName)}
        data-slot="emoji-picker"
      >
        <div className="flex flex-col">
          <div className="p-2 border-b border-border">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search emoji..."
              aria-label="Search emoji"
              className="h-8"
            />
          </div>

          {isSearching ? (
            <SearchResults results={searchResults} query={trimmedQuery} onSelect={handleSelect} />
          ) : (
            <Tabs
              value={activeCategory}
              onValueChange={(v) => setActiveCategory(v as EmojiCategoryKey)}
              className="flex flex-col"
            >
              <TabsList className="grid grid-cols-9 h-9 mx-2 mt-2">
                {EMOJI_CATEGORIES.map((cat) => (
                  <TabsTrigger
                    key={cat.key}
                    value={cat.key}
                    className="text-base px-0 size-7"
                    aria-label={cat.label}
                  >
                    <span>{cat.tabIcon}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {EMOJI_CATEGORIES.map((cat) => (
                <TabsContent key={cat.key} value={cat.key} className="mt-0">
                  <EmojiGrid label={cat.label} emojis={cat.emojis} onSelect={handleSelect} />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Props for the file-scoped {@link EmojiGrid}. */
interface EmojiGridProps {
  label: string;
  emojis: readonly string[];
  onSelect: (emoji: string) => void;
}

/**
 * A single category's emoji grid: a labelled section header above an
 * eight-column grid of ghost icon buttons, wrapped in a fixed-height
 * `ScrollArea`.
 */
function EmojiGrid({ label, emojis, onSelect }: EmojiGridProps): React.JSX.Element {
  return (
    <ScrollArea className="h-64">
      <div className="p-2" role="group" aria-label={label}>
        <p className="text-xs font-medium text-muted-foreground mb-1 px-1">{label}</p>
        <div className="grid grid-cols-8 gap-0.5">
          {emojis.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-lg p-0 hover:bg-accent"
              onClick={() => onSelect(emoji)}
              aria-label={`Select ${emoji}`}
            >
              {emoji}
            </Button>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

/** Props for the file-scoped {@link SearchResults}. */
interface SearchResultsProps {
  results: readonly string[];
  query: string;
  onSelect: (emoji: string) => void;
}

/**
 * The search results view shown while the query is non-empty: an empty-state
 * message when nothing matches, otherwise an eight-column grid of matching
 * emojis wrapped in a fixed-height `ScrollArea`.
 */
function SearchResults({ results, query, onSelect }: SearchResultsProps): React.JSX.Element {
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 px-4 text-center">
        <p className="text-sm text-muted-foreground">No emoji found for &quot;{query}&quot;</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-64">
      <div className="p-2" role="group" aria-label="Search results">
        <div className="grid grid-cols-8 gap-0.5">
          {results.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-lg p-0 hover:bg-accent"
              onClick={() => onSelect(emoji)}
              aria-label={`Select ${emoji}`}
            >
              {emoji}
            </Button>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
