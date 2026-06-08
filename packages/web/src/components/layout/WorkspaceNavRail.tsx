import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { Home, LogOut, MessageSquare } from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

/**
 * Derive a single uppercase avatar initial from an email address, falling back
 * to `'?'` when the email is absent or empty so the fallback never renders a
 * blank glyph.
 */
function getInitial(email: string | undefined): string {
  if (!email || email.length === 0) {
    return '?';
  }
  return email.charAt(0).toUpperCase();
}

/**
 * Far-left vertical icon rail of the authenticated app shell — the first of the
 * three columns shown in screenshots 29 and 100.
 *
 * Rendered top-to-bottom: a static workspace logo, a `Home` and a
 * `Direct messages` icon button that both route to `/app`, a flexible spacer,
 * and a profile avatar whose `DropdownMenu` surfaces the signed-in email and a
 * destructive `Log out` action. Logging out clears auth state and tears down the
 * Socket.io connection through {@link useAuth}, then redirects to `/login`.
 *
 * Every icon button carries an `aria-label` and every decorative glyph is
 * `aria-hidden`. Standard `<nav>` attributes (including `className`) are
 * forwarded so the app shell can compose layout, while the rail supplies its
 * own aubergine surface.
 */
export function WorkspaceNavRail({ className, ...props }: React.ComponentProps<'nav'>) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = React.useCallback(() => {
    logout();
    void navigate('/login', { replace: true });
  }, [logout, navigate]);

  const userInitial = getInitial(user?.email);

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label="Workspace"
        className={cn(
          'flex h-full w-16 shrink-0 flex-col items-center gap-2 border-r border-sidebar-border bg-sidebar-bg py-3 text-sidebar-foreground',
          className,
        )}
        {...props}
      >
        {/* Workspace logo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Avatar className="size-10 cursor-default rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
              <AvatarFallback className="rounded-lg bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground">
                BS
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent side="right">Blitzy Slack</TooltipContent>
        </Tooltip>

        {/* Primary navigation */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon"
              aria-label="Home"
              className="text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
            >
              <Link to="/app">
                <Home className="size-5" aria-hidden="true" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Home</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon"
              aria-label="Direct messages"
              className="text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
            >
              <Link to="/app">
                <MessageSquare className="size-5" aria-hidden="true" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Direct messages</TooltipContent>
        </Tooltip>

        {/* Spacer pushes the account menu to the bottom of the rail */}
        <div className="flex-1" aria-hidden="true" />

        {/* Account menu, opened from the user's profile avatar */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Account menu"
                  className="size-10 rounded-full p-0 hover:bg-sidebar-hover"
                >
                  <Avatar className="size-9">
                    <AvatarFallback className="bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground">
                      {userInitial}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">Account</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium leading-none">Signed in as</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {user?.email ?? 'Unknown user'}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault();
                handleLogout();
              }}
            >
              <LogOut className="size-4" aria-hidden="true" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </TooltipProvider>
  );
}
