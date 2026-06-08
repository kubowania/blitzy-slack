import { Hash, Search, Smile } from 'lucide-react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';

/**
 * Public marketing landing page rendered at the `/` route.
 *
 * Reproduces the layout language of the Slack web landing page (reference
 * screenshot `screenshots/Slack web Jul 2024 0.png`): a brand + multi-item
 * marketing navigation header with search, "Sign in", an outlined "Talk to
 * sales", and a filled "Get started"; a centered two-tone hero headline
 * ("Made for people." in the foreground colour, "Built for productivity." in
 * aubergine) above a prominent aubergine call to action and a "free to try"
 * subline; a muted "trusted by" wordmark row; and a large product-preview
 * mockup that mirrors Slack's three-column app shell (aubergine workspace rail,
 * aubergine channel sidebar, white message content with a reaction chip row).
 *
 * The aubergine accent, CTAs, and the preview chrome use the
 * `sidebar-bg`/`sidebar-hover`/`sidebar-foreground` design tokens (Slack's
 * dark-aubergine palette) rather than the blue `primary` token, and no raw
 * color/size literals are used (Rule 3).
 *
 * The decorative marketing-nav labels and the "trusted by" wordmarks are
 * non-interactive muted text — they reproduce the reference's visual density
 * without introducing dead placeholder links. Every real call to action
 * navigates to `/login` or `/register` through a router `Link` rendered via the
 * shadcn `Button` `asChild` slot.
 *
 * The component is purely presentational: it performs no data fetching, holds no
 * state, and reads no authentication context. The router guards the `/` route so
 * that authenticated visitors are redirected away before this page renders.
 */
export default function Landing() {
  const navItems = ['Features', 'Solutions', 'Enterprise', 'Resources', 'Pricing'];
  const trustedBy = ['Airbnb', 'NASA', 'Uber', 'Target', 'Intuit', 'Etsy'];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-8">
            <Link to="/" aria-label="Blitzy Slack home" className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-lg bg-sidebar-bg text-sidebar-foreground"
              >
                <Hash className="size-5" />
              </span>
              <span className="text-lg font-bold tracking-tight">Blitzy Slack</span>
            </Link>
            <nav aria-hidden="true" className="hidden items-center gap-6 lg:flex">
              {navItems.map((item) => (
                <span key={item} className="text-sm font-medium text-muted-foreground">
                  {item}
                </span>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="hidden size-9 items-center justify-center text-muted-foreground sm:flex"
            >
              <Search className="size-5" />
            </span>
            <Button asChild variant="ghost">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="hidden border-sidebar-bg text-sidebar-bg hover:bg-sidebar-bg/5 hover:text-sidebar-bg sm:inline-flex"
            >
              <Link to="/register">Talk to sales</Link>
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

      <main className="flex flex-1 flex-col items-center px-6 py-16 sm:py-20">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 text-center">
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

        <section aria-label="Trusted by teams everywhere" className="mt-14 w-full max-w-3xl">
          <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {trustedBy.map((name) => (
              <li
                key={name}
                aria-hidden="true"
                className="text-lg font-semibold tracking-tight text-muted-foreground/70"
              >
                {name}
              </li>
            ))}
          </ul>
        </section>

        <LandingPreview />
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-sm text-muted-foreground sm:flex-row">
          <span>© Blitzy Slack — proof of concept</span>
          <span>Made with React, Tailwind v4, and Socket.io</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * A static, non-interactive mockup of the authenticated Slack app shell, shown
 * beneath the hero to mirror the product screenshot in reference screenshot 0.
 * It is composed entirely from the Slack-aubergine design tokens and Tailwind
 * layout utilities; it renders no live data and contains no interactive
 * controls (it is hidden from assistive technology via `aria-hidden`).
 */
function LandingPreview() {
  const channels = ['announcements', 'project-gizmo', 'team-marketing'];

  return (
    <div
      aria-hidden="true"
      className="mt-16 w-full max-w-5xl overflow-hidden rounded-xl border border-border shadow-xl"
    >
      {/* Top search strip */}
      <div className="flex items-center gap-3 bg-sidebar-bg px-4 py-2.5">
        <div className="flex w-full max-w-md items-center gap-2 rounded-md bg-sidebar-hover/60 px-3 py-1.5 text-sidebar-foreground/80">
          <Search className="size-3.5" />
          <span className="text-xs">Search Acme Inc</span>
        </div>
      </div>

      <div className="flex h-80">
        {/* Workspace rail */}
        <div className="hidden w-14 flex-col items-center gap-3 bg-sidebar-bg/95 py-3 sm:flex">
          <div className="flex size-9 items-center justify-center rounded-lg bg-sidebar-foreground/15 text-sidebar-foreground">
            <Hash className="size-4" />
          </div>
          <div className="size-9 rounded-lg bg-sidebar-hover/50" />
          <div className="size-9 rounded-lg bg-sidebar-hover/50" />
        </div>

        {/* Channel sidebar */}
        <div className="hidden w-56 flex-col gap-1 bg-sidebar-bg px-3 py-3 text-sidebar-foreground md:flex">
          <div className="mb-2 flex items-center gap-1 text-sm font-bold">Acme Inc</div>
          <div className="px-1 text-xs font-semibold text-sidebar-foreground/70">Channels</div>
          {channels.map((name) => (
            <div
              key={name}
              className={
                name === 'team-marketing'
                  ? 'flex items-center gap-2 rounded-md bg-sidebar-primary px-2 py-1 text-sm text-sidebar-primary-foreground'
                  : 'flex items-center gap-2 rounded-md px-2 py-1 text-sm text-sidebar-foreground/90'
              }
            >
              <Hash className="size-3.5 opacity-80" />
              {name}
            </div>
          ))}
        </div>

        {/* Message content */}
        <div className="flex flex-1 flex-col bg-background">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <Hash className="size-4 text-muted-foreground" />
            <span className="text-base font-bold">team-marketing</span>
          </div>
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            <div className="flex gap-3">
              <div className="size-9 shrink-0 rounded-md bg-muted" />
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold">Lee Hao</span>
                  <span className="text-xs text-muted-foreground">9:41 AM</span>
                </div>
                <p className="text-sm text-foreground">
                  Hi team! Please add your project updates to the canvas.
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
                    <Smile className="size-3" /> 8
                  </span>
                  <span className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
                    ✅ 3
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
