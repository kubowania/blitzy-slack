import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Props for {@link ErrorBoundary}.
 */
export interface ErrorBoundaryProps {
  /** The subtree the boundary protects. */
  children: React.ReactNode;
}

/**
 * Internal state: whether a render error has been caught and the error itself.
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Application-level React error boundary.
 *
 * React `Suspense` does not catch errors, so a failed dynamic `import()` of a
 * lazily-loaded route chunk (for example, a navigation made while the network
 * is offline) would otherwise unmount the entire tree and leave a blank page
 * with no way to recover (UX-002). This boundary catches any render-phase error
 * below it and renders a recoverable destructive `Alert` with two actions:
 *
 *   - "Try again" resets the boundary so React re-renders the children, which
 *     re-attempts the failed dynamic import — succeeding once connectivity is
 *     restored, without a full reload (preserving in-memory state).
 *   - "Reload page" performs a hard reload as a last resort.
 *
 * Error boundaries must be class components (no Hooks equivalent exists for
 * `getDerivedStateFromError` / `componentDidCatch`).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // `console.error` is the allowed client-side surface for unexpected errors;
    // structured request/event logging lives on the API (Pino).
    console.error('ErrorBoundary caught a render error', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  public override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div role="alert" className="flex h-screen items-center justify-center bg-background p-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              The page failed to load. This can happen when your connection drops. Check your
              network and try again.
            </span>
            <span className="flex gap-2">
              <Button type="button" size="sm" onClick={this.handleReset}>
                Try again
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={this.handleReload}>
                Reload page
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}
