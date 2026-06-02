import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';

import { loginSchema, type LoginInput } from '@app/shared/schemas/auth';

import AuthLayout from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api-client';

/**
 * Login page rendered at the `/login` route.
 *
 * Collects an email and password, then submits them to `POST /api/auth/login`
 * through the {@link useAuth} orchestrator, which persists the returned JWT and
 * user in the auth store. On success the user is redirected to the destination
 * they originally requested — captured as `location.state.from` by the router's
 * `RequireAuth` guard — or to the workspace root (`/app`) by default, always
 * with `replace: true` so the login screen is removed from the history stack.
 *
 * Validation is driven entirely by `loginSchema` from `@app/shared` via
 * `zodResolver`, so the form enforces exactly the rules the API applies on the
 * server: a valid email address and a non-empty password. Native browser
 * validation is disabled (`noValidate`) so Zod is the single source of
 * validation truth, and each field surfaces its message through the shadcn
 * `FormMessage` primitive.
 *
 * Server-side failures raised as {@link ApiError} — most notably a `401`
 * invalid-credentials rejection — are mapped onto the form's root error and
 * rendered above the submit button; any other failure (e.g. a network error)
 * falls back to a generic message.
 *
 * The route is wrapped by the router's `RedirectIfAuthenticated` guard, so an
 * already-signed-in visitor is redirected to `/app` before this component
 * renders.
 */
export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/app';

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  async function onSubmit(values: LoginInput): Promise<void> {
    try {
      await login(values.email, values.password);
      void navigate(from, { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        form.setError('root', { type: 'server', message: error.message });
      } else {
        form.setError('root', {
          type: 'server',
          message: 'Unable to sign in. Please try again.',
        });
      }
    }
  }

  const handleSubmit = form.handleSubmit(onSubmit);
  const rootError = form.formState.errors.root?.message;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <AuthLayout>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Sign in to Blitzy Slack</CardTitle>
          <CardDescription>
            Welcome back. Enter your email and password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={(event) => {
                void handleSubmit(event);
              }}
              className="flex flex-col gap-4"
              noValidate
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="email">Email</FormLabel>
                    <FormControl>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="password">Password</FormLabel>
                    <FormControl>
                      <Input
                        id="password"
                        type="password"
                        autoComplete="current-password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {rootError ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {rootError}
                </p>
              ) : null}

              <Button
                type="submit"
                className="w-full bg-sidebar-bg text-sidebar-foreground hover:bg-sidebar-hover"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner className="mr-2 size-4" />
                    Signing in...
                  </>
                ) : (
                  'Sign in'
                )}
              </Button>
            </form>
          </Form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{' '}
            <Link
              to="/register"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
