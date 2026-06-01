import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';

import { registerSchema, type RegisterInput } from '@app/shared/schemas/auth';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api-client';

/**
 * Registration page rendered at the `/register` route.
 *
 * Collects a display name, email, and password, then submits them to
 * `POST /api/auth/register` through the {@link useAuth} orchestrator, which
 * persists the returned JWT and user in the auth store. On success the new user
 * is auto-authenticated and redirected to the workspace root (`/app`), landing
 * in the default channel.
 *
 * Validation is driven entirely by `registerSchema` from `@app/shared` via
 * `zodResolver`, so the form enforces exactly the rules the API applies on the
 * server: a trimmed display name of 1–80 characters, a valid email address, and
 * a password of at least 8 characters. Native browser validation is disabled
 * (`noValidate`) so Zod is the single source of validation truth, and each
 * field surfaces its message through the shadcn `FormMessage` primitive.
 *
 * Server-side failures raised as {@link ApiError} — most notably a `409` email
 * conflict or a `400` validation rejection — are mapped onto the form's root
 * error and rendered above the submit button; any other failure (e.g. a network
 * error) falls back to a generic message.
 *
 * The route is wrapped by the router's `RedirectIfAuthenticated` guard, so an
 * already-signed-in visitor is redirected to `/app` before this component
 * renders.
 */
export default function Register() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email: '',
      password: '',
      displayName: '',
    },
  });

  async function onSubmit(values: RegisterInput): Promise<void> {
    try {
      await register(values.email, values.password, values.displayName);
      void navigate('/app', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        form.setError('root', { type: 'server', message: error.message });
      } else {
        form.setError('root', {
          type: 'server',
          message: 'Unable to create account. Please try again.',
        });
      }
    }
  }

  const handleSubmit = form.handleSubmit(onSubmit);
  const rootError = form.formState.errors.root?.message;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Create your account</CardTitle>
          <CardDescription>
            Join your team on Blitzy Slack. It takes less than a minute.
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
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="displayName">Display name</FormLabel>
                    <FormControl>
                      <Input
                        id="displayName"
                        type="text"
                        autoComplete="name"
                        placeholder="Ada Lovelace"
                        maxLength={80}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

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
                      <Input id="password" type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormDescription>At least 8 characters.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {rootError ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {rootError}
                </p>
              ) : null}

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner className="mr-2 size-4" />
                    Creating account...
                  </>
                ) : (
                  'Create account'
                )}
              </Button>
            </form>
          </Form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
