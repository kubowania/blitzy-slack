import * as React from 'react';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Props for {@link InviteSentDialog}.
 *
 * The dialog is controlled: the parent owns the open/closed state. `email` is
 * the address that was invited and is named verbatim in the confirmation body.
 */
export interface InviteSentDialogProps {
  /** Controls dialog visibility. Owned by the parent. */
  open: boolean;
  /** Invoked on backdrop click, the close `X`, Escape, or the Done button. */
  onOpenChange: (open: boolean) => void;
  /** The invited email address, shown in bold within the confirmation text. */
  email: string;
  /**
   * Ref to the control that began the invite flow. The dialog is opened
   * programmatically (not via a Radix `DialogTrigger`), so focus is restored to
   * this element on close, returning keyboard and screen-reader users to the
   * trigger (WAI-ARIA dialog pattern) instead of being dropped to the body.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

/**
 * "Invitation sent" confirmation modal — the centered modal-overlay screen
 * captured in screenshots/Slack web Jul 2024 500.png (AAP §0.6.3).
 *
 * Composes the shadcn `Dialog` shell (centered overlay, backdrop, auto close
 * button) with a success check badge, a centered title, a body that names the
 * invited address, and a single primary "Done" action that dismisses the modal.
 * It is purely presentational: it performs no network request of its own (the
 * external-invitation flow has no backend in this proof-of-concept; that scope
 * decision is recorded in /docs/decision-log.md).
 */
export function InviteSentDialog({
  open,
  onOpenChange,
  email,
  triggerRef,
}: InviteSentDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (triggerRef?.current) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader className="items-center text-center sm:text-center">
          {/* Success check badge */}
          <span
            className="mb-2 flex size-16 items-center justify-center rounded-full bg-green-100"
            aria-hidden="true"
          >
            <Check className="size-8 text-green-600" />
          </span>
          <DialogTitle className="text-xl">Invitation sent</DialogTitle>
          <DialogDescription className="text-left text-sm leading-relaxed">
            You’ve invited <span className="font-semibold text-foreground">{email}</span> to start a
            conversation in Slack. They’ll have 14 days to accept — once they do, they’ll appear in
            your list of DMs.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
