import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Public marketing landing page rendered at the `/` route.
 *
 * Presents the Blitzy Slack value proposition through a header with sign-in and
 * sign-up calls to action, a centered hero, a three-card feature-highlight grid,
 * and a footer. Every call to action navigates to the `/login` or `/register`
 * route through a router `Link` rendered via the shadcn `Button` `asChild` slot,
 * combining button styling with client-side navigation.
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
          <Link
            to="/"
            aria-label="Blitzy Slack home"
            className="flex items-center gap-2 font-semibold text-lg"
          >
            Blitzy Slack
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild variant="default">
              <Link to="/register">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center gap-6">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Where work happens</h1>
          <p className="text-lg text-muted-foreground sm:text-xl">
            Blitzy Slack brings your team’s conversations, files, and tools into one place —
            channels, direct messages, threads, reactions, and real-time presence built with
            WebSockets.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild variant="default" size="lg">
              <Link to="/register">Create an account</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/login">Sign in to Blitzy Slack</Link>
            </Button>
          </div>
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
