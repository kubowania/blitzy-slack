import * as React from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { searchQuerySchema, type SearchQueryInput } from '@app/shared/schemas/message';

export interface SearchBarProps {
  className?: string;
  placeholder?: string;
  initialQuery?: string;
  debounceMs?: number;
}

export function SearchBar({ className, placeholder, initialQuery, debounceMs }: SearchBarProps) {
  const navigate = useNavigate();
  const effectiveDebounceMs = debounceMs ?? 300;

  const form = useForm<SearchQueryInput>({
    resolver: zodResolver(searchQuerySchema),
    defaultValues: { q: initialQuery ?? '' },
    mode: 'onChange',
  });

  // Debounce timer for search-as-you-type. Held in a ref so it survives
  // re-renders and is cleared on unmount. Navigation fires ONLY from a user
  // keystroke (onChange) or submit (Enter) — never from a location-driven
  // re-render — so leaving /app/search does not bounce the user back.
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const goToSearch = React.useCallback(
    (raw: string): void => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return;
      }
      void navigate(`/app/search?q=${encodeURIComponent(trimmed)}`);
    },
    [navigate],
  );

  const registration = form.register('q');

  const onSubmit = form.handleSubmit((data) => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    goToSearch(data.q);
  });

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      role="search"
      className={cn('relative w-full max-w-md', className)}
    >
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        role="searchbox"
        placeholder={placeholder ?? 'Search Blitzy Slack'}
        autoComplete="off"
        spellCheck={false}
        className="pl-9"
        {...registration}
        onChange={(event) => {
          void registration.onChange(event);
          const value = event.target.value;
          if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
          }
          debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            goToSearch(value);
          }, effectiveDebounceMs);
        }}
      />
    </form>
  );
}
