import * as React from 'react';
import { Link } from 'react-router';
import { Hash, Lock, ImageIcon, FileText, File as FileIcon } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

import type { Channel } from '@app/shared/types/channel';
import type { FileAttachment, MessageWithAuthor } from '@app/shared/types/message';

export type SearchResultItemProps =
  | {
      variant: 'message';
      result: MessageWithAuthor;
      query: string;
      className?: string;
    }
  | {
      variant: 'channel';
      result: Channel;
      className?: string;
    }
  | {
      variant: 'file';
      result: FileAttachment;
      originatingMessage?: MessageWithAuthor;
      className?: string;
    };

export function SearchResultItem(props: SearchResultItemProps) {
  if (props.variant === 'message') {
    return (
      <MessageSearchResult result={props.result} query={props.query} className={props.className} />
    );
  }
  if (props.variant === 'channel') {
    return <ChannelSearchResult result={props.result} className={props.className} />;
  }
  return (
    <FileSearchResult
      result={props.result}
      originatingMessage={props.originatingMessage}
      className={props.className}
    />
  );
}

interface MessageSearchResultProps {
  result: MessageWithAuthor;
  query: string;
  className?: string;
}

function MessageSearchResult({ result, query, className }: MessageSearchResultProps) {
  const { author, channelId, dmId, content, createdAt, id: messageId } = result;
  const target = channelId
    ? `/app/channels/${channelId}#message-${messageId}`
    : dmId
      ? `/app/dms/${dmId}#message-${messageId}`
      : '#';
  const relativeTime = formatDistanceToNow(new Date(createdAt), { addSuffix: true });
  const initials = author.displayName.charAt(0).toUpperCase();
  const contextLabel = channelId ? 'in a channel' : 'in a direct message';

  return (
    <Item
      asChild
      variant="default"
      size="default"
      className={cn('hover:bg-muted transition-colors', className)}
    >
      <Link to={target}>
        <ItemMedia variant="default">
          <Avatar className="size-10 rounded-md">
            <AvatarImage src={author.avatarUrl ?? undefined} alt={author.displayName} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            <span className="font-semibold">{author.displayName}</span>
            <span className="text-muted-foreground text-xs font-normal">
              {contextLabel} · {relativeTime}
            </span>
          </ItemTitle>
          <ItemDescription>
            <HighlightedExcerpt content={content} query={query} />
          </ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  );
}

interface HighlightedExcerptProps {
  content: string;
  query: string;
}

function HighlightedExcerpt({ content, query }: HighlightedExcerptProps) {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return <>{content}</>;
  }
  const lowerContent = content.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  let idx = 0;
  while (cursor < content.length) {
    const matchAt = lowerContent.indexOf(lowerQuery, cursor);
    if (matchAt === -1) {
      segments.push(<React.Fragment key={`f-${idx}`}>{content.slice(cursor)}</React.Fragment>);
      idx += 1;
      break;
    }
    if (matchAt > cursor) {
      segments.push(
        <React.Fragment key={`f-${idx}`}>{content.slice(cursor, matchAt)}</React.Fragment>,
      );
      idx += 1;
    }
    segments.push(
      <mark key={`m-${idx}`} className="bg-yellow-200/70 text-foreground rounded-sm px-0.5">
        {content.slice(matchAt, matchAt + trimmedQuery.length)}
      </mark>,
    );
    idx += 1;
    cursor = matchAt + trimmedQuery.length;
  }
  return <>{segments}</>;
}

interface ChannelSearchResultProps {
  result: Channel;
  className?: string;
}

function ChannelSearchResult({ result, className }: ChannelSearchResultProps) {
  const IconComponent = result.isPrivate ? Lock : Hash;
  const description = result.description ?? '';
  return (
    <Item
      asChild
      variant="default"
      size="default"
      className={cn('hover:bg-muted transition-colors', className)}
    >
      <Link to={`/app/channels/${result.id}`}>
        <ItemMedia variant="icon">
          <IconComponent className="size-4" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{result.name}</ItemTitle>
          {description.length > 0 ? <ItemDescription>{description}</ItemDescription> : null}
        </ItemContent>
      </Link>
    </Item>
  );
}

interface FileSearchResultProps {
  result: FileAttachment;
  originatingMessage?: MessageWithAuthor;
  className?: string;
}

function FileSearchResult({ result, originatingMessage, className }: FileSearchResultProps) {
  const FileTypeIcon = pickFileTypeIcon(result.mimeType);
  const sizeText = formatFileSize(result.sizeBytes);
  const uploadedAt = formatDistanceToNow(new Date(result.createdAt), {
    addSuffix: true,
  });
  const contextText = originatingMessage
    ? originatingMessage.channelId
      ? `Shared in a channel · ${uploadedAt}`
      : `Shared in a direct message · ${uploadedAt}`
    : `Uploaded ${uploadedAt}`;

  return (
    <Item
      asChild
      variant="default"
      size="default"
      className={cn('hover:bg-muted transition-colors', className)}
    >
      <a
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${result.originalName}`}
      >
        <ItemMedia variant="icon">
          <FileTypeIcon className="size-4" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{result.originalName}</ItemTitle>
          <ItemDescription>
            {sizeText} · {contextText}
          </ItemDescription>
        </ItemContent>
      </a>
    </Item>
  );
}

function pickFileTypeIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) {
    return ImageIcon;
  }
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/pdf' ||
    mimeType === 'application/json'
  ) {
    return FileText;
  }
  return FileIcon;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
