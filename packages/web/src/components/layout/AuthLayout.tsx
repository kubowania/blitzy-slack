import { Hash } from 'lucide-react';
import { Link } from 'react-router';

/**
 * AuthLayout — the shared presentational shell for the public authentication
 * screens (`/login`, `/register`).
 *
 * Reproduces the layout language of Slack's web sign-in screen (reference
 * screenshot `screenshots/Slack web Jul 2024 1.png`): a single centered column
 * on a white background with the Slack brand mark at the very top, the page's
 * form content beneath it, and a muted utility footer at the bottom. Keeping
 * this chrome in one place gives `/login` and `/register` identical branding,
 * spacing, and footer density from a single source.
 *
 * The brand mark is the same aubergine hash lozenge + "Blitzy Slack" wordmark
 * used by the marketing {@link Landing} header, so the product identity is
 * consistent across every public surface. It links back to `/` so a visitor can
 * always return to the landing page. All color comes from the Slack-aubergine
 * design tokens (`sidebar-bg`/`sidebar-foreground`); no raw color or size
 * literals are used (Rule 3).
 *
 * The footer renders Slack's familiar "Privacy & Terms · Contact Us" utility row
 * as non-interactive muted text — it reproduces the reference's visual density
 * without introducing dead placeholder links.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-between bg-background px-6 py-10">
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-8">
        <Link
          to="/"
          aria-label="Blitzy Slack home"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-lg bg-sidebar-bg text-sidebar-foreground"
          >
            <Hash className="size-5" />
          </span>
          <span className="text-xl font-bold tracking-tight">Blitzy Slack</span>
        </Link>

        {children}
      </div>

      <footer className="pt-10">
        <p className="text-center text-xs text-muted-foreground">
          Privacy &amp; Terms &middot; Contact Us
        </p>
      </footer>
    </div>
  );
}
