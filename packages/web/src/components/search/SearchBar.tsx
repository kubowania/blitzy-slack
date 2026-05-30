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

  const query = form.watch('q');

  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return;
    }
    const handle = setTimeout(() => {
      void navigate(`/app/search?q=${encodeURIComponent(trimmed)}`);
    }, effectiveDebounceMs);
    return () => clearTimeout(handle);
  }, [query, effectiveDebounceMs, navigate]);

  const onSubmit = form.handleSubmit((data) => {
    const trimmed = data.q.trim();
    if (trimmed.length === 0) {
      return;
    }
    void navigate(`/app/search?q=${encodeURIComponent(trimmed)}`);
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
        {...form.register('q')}
      />
    </form>
  );
}
