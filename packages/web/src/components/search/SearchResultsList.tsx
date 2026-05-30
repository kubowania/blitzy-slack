import * as React from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';

import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { SearchResultItem } from '@/components/search/SearchResultItem';

import type { MessageWithAuthor } from '@app/shared/types/message';

export interface SearchResultsListProps {
  className?: string;
}

export function SearchResultsList({ className }: SearchResultsListProps) {
  const [searchParams] = useSearchParams();
  const rawQuery = searchParams.get('q') ?? '';
  const query = rawQuery.trim();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['search', query],
    queryFn: () => apiClient.get<MessageWithAuthor[]>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const messages = React.useMemo<MessageWithAuthor[]>(() => data ?? [], [data]);
  const fileMessages = React.useMemo<MessageWithAuthor[]>(
    () => messages.filter((message) => message.file !== null),
    [messages],
  );
  const channelIds = React.useMemo<string[]>(
    () =>
      Array.from(
        new Set(
          messages
            .map((message) => message.channelId)
            .filter((channelId): channelId is string => channelId !== null),
        ),
      ),
    [messages],
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {query.length === 0 ? (
        <EmptySearchPrompt />
      ) : (
        <Tabs defaultValue="messages" className="flex h-full flex-col">
          <TabsList className="w-fit">
            <TabsTrigger value="messages">Messages ({messages.length})</TabsTrigger>
            <TabsTrigger value="channels">Channels ({channelIds.length})</TabsTrigger>
            <TabsTrigger value="files">Files ({fileMessages.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="messages" className="mt-4 min-h-0 flex-1">
            <MessagesTabContent
              query={query}
              messages={messages}
              isLoading={isLoading}
              isError={isError}
              error={error}
            />
          </TabsContent>

          <TabsContent value="channels" className="mt-4 min-h-0 flex-1">
            <ChannelsTabContent />
          </TabsContent>

          <TabsContent value="files" className="mt-4 min-h-0 flex-1">
            <FilesTabContent
              fileMessages={fileMessages}
              isLoading={isLoading}
              isError={isError}
              error={error}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function EmptySearchPrompt() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchIcon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>Search Blitzy Slack</EmptyTitle>
        <EmptyDescription>
          Type a search term in the top bar to find messages, channels, and files.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

interface MessagesTabContentProps {
  query: string;
  messages: MessageWithAuthor[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

function MessagesTabContent({
  query,
  messages,
  isLoading,
  isError,
  error,
}: MessagesTabContentProps) {
  if (isLoading) {
    return <SearchSkeletons />;
  }
  if (isError) {
    return <SearchErrorState error={error} />;
  }
  if (messages.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon className="size-5" />
          </EmptyMedia>
          <EmptyTitle>No messages found</EmptyTitle>
          <EmptyDescription>
            No messages match &ldquo;{query}&rdquo;. Try a different search term.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1 pr-2">
        {messages.map((message) => (
          <SearchResultItem key={message.id} variant="message" result={message} query={query} />
        ))}
      </div>
    </ScrollArea>
  );
}

interface FilesTabContentProps {
  fileMessages: MessageWithAuthor[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

function FilesTabContent({ fileMessages, isLoading, isError, error }: FilesTabContentProps) {
  if (isLoading) {
    return <SearchSkeletons />;
  }
  if (isError) {
    return <SearchErrorState error={error} />;
  }
  if (fileMessages.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon className="size-5" />
          </EmptyMedia>
          <EmptyTitle>No files found</EmptyTitle>
          <EmptyDescription>
            No files match your search. Try a different search term.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1 pr-2">
        {fileMessages.map((message) =>
          message.file !== null ? (
            <SearchResultItem
              key={`file-${message.file.id}`}
              variant="file"
              result={message.file}
              originatingMessage={message}
            />
          ) : null,
        )}
      </div>
    </ScrollArea>
  );
}

function ChannelsTabContent() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchIcon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>Channel search coming soon</EmptyTitle>
        <EmptyDescription>
          Search currently matches message content. To browse channels, use the sidebar.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SearchSkeletons() {
  return (
    <div className="flex flex-col gap-3 pr-2">
      {Array.from({ length: 5 }).map((_, idx) => (
        <div key={idx} className="flex items-start gap-3 p-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchIcon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>Search failed</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <span className="text-muted-foreground text-xs">Try again in a moment.</span>
      </EmptyContent>
    </Empty>
  );
}
