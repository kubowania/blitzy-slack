import * as React from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import { createChannelSchema, type CreateChannelInput } from '@app/shared/schemas/channel';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCreateChannel } from '@/hooks/useChannels';

/**
 * Props for {@link CreateChannelDialog}.
 *
 * The dialog is a controlled component: the parent (the sidebar
 * `ChannelList`) owns the open/closed state and passes it down, matching the
 * shadcn `Dialog` controlled API exactly.
 */
export interface CreateChannelDialogProps {
  /** Controls dialog visibility. Owned by the parent. */
  open: boolean;
  /** Invoked on backdrop click, the close `X`, Escape, Cancel, or after a successful create. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Stable DOM id shared between the `isPrivate` {@link Checkbox} and its
 * associated {@link Label} so that clicking the label toggles the checkbox.
 */
const IS_PRIVATE_FIELD_ID = 'create-channel-isPrivate';

/**
 * Modal dialog for creating a public or private channel.
 *
 * Composes the shadcn `Dialog` shell (centered overlay, backdrop, auto close
 * button) with the shadcn `Form` primitives bridged to `react-hook-form` via
 * `zodResolver(createChannelSchema)` — the same Zod schema the API validates,
 * so the client and server enforce identical rules.
 *
 * Fields:
 *  - `name`        — required; lowercase letters, digits, hyphen, underscore.
 *  - `description` — optional; up to 250 characters.
 *  - `isPrivate`   — boolean toggle rendered with the shadcn `Checkbox` primitive.
 *
 * On submit it creates the channel through the canonical {@link useCreateChannel}
 * mutation (which POSTs `/api/channels`, returning the base `Channel` DTO, and
 * invalidates the cached `['channels']` list so the sidebar refetches). The
 * dialog-specific side effects — confirmation toast, form reset, close, and
 * navigation to the new channel — run in the per-call `onSuccess`; failures
 * surface the error message via a toast.
 */
export function CreateChannelDialog({
  open,
  onOpenChange,
}: CreateChannelDialogProps): React.JSX.Element {
  const navigate = useNavigate();
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);

  const form = useForm<CreateChannelInput>({
    resolver: zodResolver(createChannelSchema),
    defaultValues: {
      name: '',
      description: '',
      isPrivate: false,
    },
  });

  // Canonical create mutation (typed to the base `Channel` DTO the backend
  // actually returns, NOT `ChannelWithMembers`). The hook invalidates the
  // `['channels']` list on success; the dialog adds its own UX side effects
  // via the per-call callbacks below.
  const createChannelMutation = useCreateChannel();

  React.useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        nameInputRef.current?.focus();
      });
      return () => {
        window.cancelAnimationFrame(id);
      };
    }
    return undefined;
  }, [open]);

  const handleSubmit = form.handleSubmit((values) => {
    // Omit `description` entirely when blank so the backend stores `null`
    // rather than an empty string.
    const body: CreateChannelInput = {
      name: values.name,
      isPrivate: values.isPrivate,
      ...(values.description !== undefined && values.description.length > 0
        ? { description: values.description }
        : {}),
    };
    createChannelMutation.mutate(body, {
      onSuccess: (newChannel) => {
        toast.success(`Channel #${newChannel.name} created`);
        form.reset();
        onOpenChange(false);
        void navigate(`/app/channels/${newChannel.id}`);
      },
      onError: (err) => {
        toast.error(err.message.length > 0 ? err.message : 'Failed to create channel');
      },
    });
  });

  const isSubmitting = createChannelMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where your team communicates. They’re best when organized around a topic —
            #marketing, for example.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      ref={(node) => {
                        field.ref(node);
                        nameInputRef.current = node;
                      }}
                      placeholder="e.g. marketing"
                      maxLength={80}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </FormControl>
                  <FormDescription>
                    Lowercase letters, numbers, hyphens, and underscores only.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="What’s this channel about?"
                      maxLength={250}
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isPrivate"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <FormControl>
                      <Checkbox
                        id={IS_PRIVATE_FIELD_ID}
                        checked={field.value}
                        onChange={(event) => {
                          field.onChange(event.target.checked);
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        className="mt-0.5"
                      />
                    </FormControl>
                    <div className="flex-1">
                      <Label
                        htmlFor={IS_PRIVATE_FIELD_ID}
                        className="cursor-pointer text-sm font-medium leading-none"
                      >
                        Make private
                      </Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Only invited members can see and join this channel.
                      </p>
                    </div>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
