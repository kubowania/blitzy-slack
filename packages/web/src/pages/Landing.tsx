import { Link } from 'react-router';
import { Hash } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Public marketing landing page rendered at the `/` route.
 *
 * Reproduces the layout language of the Slack web landing page (reference
 * screenshot `screenshots/Slack web Jul 2024 0.png`): a logo + auth-CTA header,
 * a centered two-tone hero headline (foreground + aubergine accent) above a
 * prominent aubergine "Get started" call to action and a "free to try" subline,
 * a three-card feature-highlight grid, and a footer. The aubergine accent and
 * CTA use the `sidebar-bg`/`sidebar-hover`/`sidebar-foreground` design tokens
 * (Slack's dark-aubergine palette) rather than the blue `primary` token, and no
 * raw color/size literals are used (Rule 3).
 *
 * Every call to action navigates to the `/login` or `/register` route through a
 * router `Link` rendered via the shadcn `Button` `asChild` slot, combining
 * button styling with client-side navigation.
 *
 * The component is purely presentational: it performs no data fetching, holds no
 * state, and reads no authentication context. The router guards the `/` route so
 * that authenticated visitors are redirected away before this page renders.
 */
export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" aria-label="Blitzy Slack home" className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-lg bg-sidebar-bg text-sidebar-foreground"
            >
              <Hash className="size-5" />
            </span>
            <span className="text-lg font-bold tracking-tight">Blitzy Slack</span>
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button
              asChild
              className="bg-sidebar-bg text-sidebar-foreground hover:bg-sidebar-hover"
            >
              <Link to="/register">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-16 sm:py-24">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-8 text-center">
          <h1 className="text-balance text-5xl font-extrabold tracking-tight sm:text-6xl">
            <span className="text-foreground">Made for people. </span>
            <span className="text-sidebar-bg">Built for productivity.</span>
          </h1>
          <Button
            asChild
            size="lg"
            className="bg-sidebar-bg px-8 text-sidebar-foreground hover:bg-sidebar-hover"
          >
            <Link to="/register">Get started</Link>
          </Button>
          <p className="text-base text-muted-foreground">
            <span className="font-semibold text-foreground">Blitzy Slack is free to try</span> — for
            as long as you’d like.
          </p>
        </div>

        <section
          aria-label="Features"
          className="mx-auto mt-20 grid w-full max-w-5xl gap-4 sm:grid-cols-3"
        >
          <Card>
            <CardHeader>
              <CardTitle>Channels</CardTitle>
              <CardDescription>
                Organize conversations by topic. Public for everyone, private for your team.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Direct messages</CardTitle>
              <CardDescription>
                One-on-one conversations with anyone in your workspace.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Real-time</CardTitle>
              <CardDescription>
                Messages, reactions, and presence updates delivered instantly over WebSockets.
              </CardDescription>
            </CardHeader>
          </Card>
        </section>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 text-sm text-muted-foreground">
          <span>© Blitzy Slack — proof of concept</span>
          <span>Made with React, Tailwind v4, and Socket.io</span>
        </div>
      </footer>
    </div>
  );
}
