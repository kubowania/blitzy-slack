import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { InviteSentDialog } from './InviteSentDialog';

/**
 * Validation schema for the invite-by-email field. A friendly message replaces
 * the raw validator string so the inline form error is human-readable (UX-001).
 */
const inviteEmailSchema = z.object({
  email: z.string().email('Enter a valid email address'),
});

type InviteEmailInput = z.infer<typeof inviteEmailSchema>;

/**
 * Props for {@link InvitePeople}. `className` styles the trigger button so the
 * sidebar can present it on the aubergine surface.
 */
export interface InvitePeopleProps {
  /** Optional className applied to the trigger button. */
  className?: string;
}

/**
 * Invite-people flow: a trigger button that opens an email-entry dialog and,
 * on submit, surfaces the required {@link InviteSentDialog} confirmation
 * (screenshots/Slack web Jul 2024 500.png).
 *
 * This component owns both steps of the flow and all of its state. The
 * external-invitation feature has no backend in this proof-of-concept, so the
 * submit performs no network request — it is a faithful reproduction of Slack's
 * invite UI culminating in the confirmation modal the AAP requires. That scope
 * decision is recorded in /docs/decision-log.md.
 */
export function InvitePeople({ className }: InvitePeopleProps): React.JSX.Element {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const emailInputRef = React.useRef<HTMLInputElement | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState<boolean>(false);
  const [sentOpen, setSentOpen] = React.useState<boolean>(false);
  const [invitedEmail, setInvitedEmail] = React.useState<string>('');

  const form = useForm<InviteEmailInput>({
    resolver: zodResolver(inviteEmailSchema),
    defaultValues: { email: '' },
  });

  React.useEffect(() => {
    if (inviteOpen) {
      const id = window.requestAnimationFrame(() => {
        emailInputRef.current?.focus();
      });
      return () => {
        window.cancelAnimationFrame(id);
      };
    }
    return undefined;
  }, [inviteOpen]);

  const handleSubmit = form.handleSubmit((values) => {
    setInvitedEmail(values.email);
    setInviteOpen(false);
    setSentOpen(true);
    form.reset();
  });

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        onClick={() => {
          setInviteOpen(true);
        }}
        className={cn('w-full justify-start gap-2', className)}
      >
        <UserPlus className="size-4 shrink-0" aria-hidden="true" />
        <span>Invite people</span>
      </Button>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            // Restore focus to the trigger only when the invite dialog closes
            // WITHOUT advancing to the confirmation modal; otherwise the
            // confirmation owns focus restoration when it later closes.
            if (!sentOpen && triggerRef.current) {
              event.preventDefault();
              triggerRef.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite people to Slack</DialogTitle>
            <DialogDescription>
              Enter an email address to invite someone to start a conversation.
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
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email address</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        ref={(node) => {
                          field.ref(node);
                          emailInputRef.current = node;
                        }}
                        type="email"
                        placeholder="name@example.com"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setInviteOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit">Send invitation</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <InviteSentDialog
        open={sentOpen}
        onOpenChange={setSentOpen}
        email={invitedEmail}
        triggerRef={triggerRef}
      />
    </>
  );
}
