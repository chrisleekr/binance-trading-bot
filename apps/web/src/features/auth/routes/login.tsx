import { SignInRequest } from '@app/contracts';
import { createRoute, useRouter, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ApiError, RateLimitedError } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';
import { signIn } from '@/features/auth/api/auth-mutations';
import { rootRoute } from '@/app/__root';

interface FieldErrors {
  email?: string;
  password?: string;
}

interface RateLimitState {
  message: string;
}

const LoginSearch = z.object({
  from: z.string().optional(),
  // Stamped by the 401 handler (main.tsx) so an expired session lands with an
  // explanation instead of a silent bounce to the sign-in screen. `.catch`
  // makes a stale/garbage `?reason=` degrade to undefined rather than throw a
  // route error on the sign-in page — the worst place to hard-fail.
  reason: z.enum(['expired']).optional().catch(undefined),
});
type LoginSearch = z.infer<typeof LoginSearch>;

// Keep the post-login bounce inside the SPA. Anything that doesn't start with
// a single "/" (no protocol-relative "//", no absolute URL) falls back to "/".
// The auth pages themselves are rejected too: a `?from=/login` left over from
// a prior redirect would otherwise strand a freshly-authenticated operator on
// the sign-in page.
const AUTH_PATHS = new Set(['/login', '/onboarding']);
const sanitiseFrom = (from: string | undefined): string => {
  if (!from) return '/';
  if (!from.startsWith('/') || from.startsWith('//')) return '/';
  const rawPath = from.split('?')[0]?.split('#')[0] ?? from;
  // Strip a trailing slash so `/login/` is caught by the exact-match guard.
  const path = rawPath !== '/' ? rawPath.replace(/\/+$/, '') : rawPath;
  if (AUTH_PATHS.has(path)) return '/';
  return from;
};

function LoginPage() {
  const router = useRouter();
  const search = useSearch({ from: loginRoute.id });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [genericError, setGenericError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (rateLimit) return;
    setErrors({});
    setGenericError(null);

    const parsed = SignInRequest.safeParse({ email, password });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email') next.email = t('login.error.invalid_email');
        else if (field === 'password') next.password = t('login.error.password_required');
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await signIn(parsed.data);
      const target = sanitiseFrom(search.from);
      await router.navigate({ to: target });
    } catch (cause) {
      if (cause instanceof RateLimitedError) {
        const message =
          cause.retryAfterSeconds !== undefined
            ? t('login.error.rate_limited.with_retry', { seconds: cause.retryAfterSeconds })
            : t('login.error.rate_limited.no_retry');
        setRateLimit({ message });
        return;
      }
      if (cause instanceof ApiError && cause.status === 401) {
        setGenericError(t('login.error.invalid'));
        return;
      }
      const message = cause instanceof Error ? cause.message : t('auth.error.generic');
      setGenericError(message || t('auth.error.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const inputsDisabled = submitting || !!rateLimit;

  return (
    <section className="border-border-strong bg-bg-elevated mx-auto w-full max-w-md space-y-6 rounded-md border p-8">
      <header className="space-y-1 text-center">
        <h1 className="text-fg text-2xl font-semibold">{t('login.title')}</h1>
        <p className="text-muted-fg text-sm">{t('login.subtitle')}</p>
      </header>

      {search.reason === 'expired' && !rateLimit && (
        <Alert variant="default" data-testid="login-session-expired" aria-live="polite">
          <AlertDescription>{t('login.session_expired')}</AlertDescription>
        </Alert>
      )}

      {rateLimit && (
        <Alert variant="danger" data-testid="login-rate-limit" aria-live="assertive">
          <AlertTitle>{t('login.title')}</AlertTitle>
          <AlertDescription>{rateLimit.message}</AlertDescription>
        </Alert>
      )}

      <form noValidate className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="login-email">{t('auth.field.email')}</Label>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            placeholder={t('auth.field.email.placeholder')}
            disabled={inputsDisabled}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'login-email-error' : undefined}
          />
          {errors.email && (
            <p id="login-email-error" className="text-danger text-sm">
              {errors.email}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="login-password">{t('auth.field.password')}</Label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            placeholder={t('auth.field.password.placeholder')}
            disabled={inputsDisabled}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? 'login-password-error' : undefined}
          />
          {errors.password && (
            <p id="login-password-error" className="text-danger text-sm">
              {errors.password}
            </p>
          )}
        </div>

        {genericError && (
          <Alert variant="danger" data-testid="login-generic-error">
            <AlertDescription>{genericError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={inputsDisabled}>
          {submitting ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </section>
  );
}

export const loginRoute = createRoute({
  staticData: { title: 'Sign in' },
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  validateSearch: (raw): LoginSearch => LoginSearch.parse(raw),
});
