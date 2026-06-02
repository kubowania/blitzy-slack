import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

import { startDmSchema } from '@app/shared/schemas/dm';
import type { DMWithParticipants } from '@app/shared/types/dm';
import type { PublicUser } from '@app/shared/types/user';

export interface StartDmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Ref to the control that opens the dialog. The dialog is opened
   * programmatically (not via a Radix `DialogTrigger`), so focus is explicitly
   * restored to this element on close, returning keyboard users to the trigger
   * (WAI-ARIA dialog pattern) instead of being dropped to the document body.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

const SEARCH_DEBOUNCE_MS = 200;

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') {
    return '?';
  }
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function StartDmDialog({
  open,
  onOpenChange,
  triggerRef,
}: StartDmDialogProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);

  const [rawQuery, setRawQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(rawQuery);
    }, SEARCH_DEBOUNCE_MS);
    return (): void => {
      window.clearTimeout(timeout);
    };
  }, [rawQuery]);

  React.useEffect(() => {
    if (!open) {
      setRawQuery('');
      setDebouncedQuery('');
    }
  }, [open]);

  const usersQuery = useQuery<PublicUser[], Error>({
    queryKey: ['users', 'search', debouncedQuery],
    queryFn: ({ signal }) =>
      apiClient.get<PublicUser[]>(`/api/users?q=${encodeURIComponent(debouncedQuery)}`, { signal }),
    enabled: open && token !== null,
    staleTime: 30_000,
  });

  const candidates = React.useMemo<PublicUser[]>(() => {
    const list = usersQuery.data ?? [];
    if (currentUser === null) {
      return list;
    }
    return list.filter((candidate) => candidate.id !== currentUser.id);
  }, [usersQuery.data, currentUser]);

  const startDmMutation = useMutation<DMWithParticipants, Error, PublicUser>({
    mutationFn: (user) => {
      const payload = startDmSchema.parse({ targetUserId: user.id });
      return apiClient.post<DMWithParticipants>('/api/dms', payload);
    },
    onSuccess: (dm) => {
      void queryClient.invalidateQueries({ queryKey: ['dms'] });
      onOpenChange(false);
      void navigate(`/app/dms/${dm.id}`);
    },
  });

  const handleSelect = React.useCallback(
    (user: PublicUser): void => {
      if (startDmMutation.isPending) {
        return;
      }
      startDmMutation.mutate(user);
    },
    [startDmMutation],
  );

  const hasResults = candidates.length > 0;
  const isSearching = usersQuery.isFetching;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="start-dm-dialog"
        className="p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          // The dialog is opened programmatically (no Radix DialogTrigger), so
          // restore focus to the opening control ourselves on close. Without
          // this, focus falls to document.body and keyboard users lose place.
          if (triggerRef?.current) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>Start a direct message</DialogTitle>
          <DialogDescription>Search for a teammate to begin a 1:1 conversation.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="border-t">
          <CommandInput
            placeholder="Search by name…"
            value={rawQuery}
            onValueChange={setRawQuery}
            disabled={startDmMutation.isPending}
          />
          <CommandList>
            {isSearching ? (
              <div className="flex items-center justify-center py-6">
                <Spinner />
              </div>
            ) : null}
            {!isSearching && !hasResults ? (
              <CommandEmpty>
                <Empty className="border-0 py-6">
                  <EmptyTitle>No users found</EmptyTitle>
                  <EmptyDescription>Try a different name.</EmptyDescription>
                </Empty>
              </CommandEmpty>
            ) : null}
            {hasResults ? (
              <CommandGroup heading="People">
                {candidates.map((user) => (
                  <UserCommandItem
                    key={user.id}
                    user={user}
                    disabled={startDmMutation.isPending}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

interface UserCommandItemProps {
  user: PublicUser;
  disabled: boolean;
  onSelect: (user: PublicUser) => void;
}

function UserCommandItem({ user, disabled, onSelect }: UserCommandItemProps): React.JSX.Element {
  const handleSelect = React.useCallback((): void => {
    onSelect(user);
  }, [user, onSelect]);

  return (
    <CommandItem
      value={`${user.displayName} ${user.id}`}
      onSelect={handleSelect}
      disabled={disabled}
      className="gap-3"
    >
      <Avatar className="size-7">
        {user.avatarUrl !== null ? (
          <AvatarImage src={user.avatarUrl} alt={user.displayName} />
        ) : null}
        <AvatarFallback>{initialsFor(user.displayName)}</AvatarFallback>
      </Avatar>
      <span className="truncate text-sm">{user.displayName}</span>
    </CommandItem>
  );
}
