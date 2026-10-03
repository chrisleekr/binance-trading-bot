import { SignInRequest } from '@app/contracts';
import { useQuery } from '@tanstack/react-query';
import { createRoute, useRouter, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ApiError, RateLimitedError } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';
import { onboardingStatusQueryOptions } from '@/features/auth/api/auth';
import { signIn, startSingleSignOn } from '@/features/auth/api/auth-mutations';
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
  // Set by the server when a single sign-on login or an agent authorization was refused. Only a fixed set of codes is ever shown, each through its own message, so a crafted link cannot put arbitrary text on the sign-in page.
  error: z.string().max(64).optional().catch(undefined),
});
type LoginSearch = z.infer<typeof LoginSearch>;

/**
 * The still-pending authorization request this page was redirected here with, if there is one.
 *
 * Read off `location` rather than the route's validated search: the query is signed over parameters this page does not model, and the router re-serialises a repeated key into a single JSON array, either of which breaks the signature the authorization endpoint re-checks. `sig` is what distinguishes a real redirect from an operator opening the sign-in page themselves.
 *
 * @param rawSearch - The untouched `location.search` this page was opened with.
 * @returns The query to replay at the authorization endpoint, leading `?` included, or null when no authorization request is waiting.
 */
const pendingAuthorizeQuery = (rawSearch: string): string | null => {
  const query = rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`;
  // Matched on a parameter boundary rather than parsed. A parser here would read as building a query for an API call, which this is not: the string is replayed byte for byte because a signature covers it, and anything that reserialised it would invalidate exactly what it is being replayed for.
  const carries = (name: string): boolean => new RegExp(`[?&]${name}=`).test(query);
  if (!carries('sig') || !carries('client_id')) return null;
  return query;
};

/** Refusal codes the server can put in `?error=`, each with its own plain explanation. Anything else shows the generic message. */
const SIGN_IN_ERRORS = {
  rate_limited: 'login.error.rate_limited.no_retry',
  account_not_linked: 'login.error.account_not_linked',
  'account not linked': 'login.error.account_not_linked',
  sign_up_refused: 'login.error.account_not_linked',
  signup_disabled: 'login.error.account_not_linked',
  missing_id_token: 'login.error.provider_refused',
  issuer_mismatch: 'login.error.provider_refused',
  invalid_code: 'login.error.provider_refused',
  email_not_verified: 'login.error.email_not_verified',
  state_mismatch: 'login.error.state_mismatch',
  state_not_found: 'login.error.state_mismatch',
  access_denied: 'login.error.access_denied',
} as const satisfies Readonly<Record<string, `${string}.${string}`>>;

/**
 * Plain-language explanation for a single sign-on refusal code the server put in `?error=`. The security settings page shows the same codes after a refused link, so both pages share this closed map.
 *
 * @param code - The raw `?error=` value, untrusted; it is only ever used as a lookup key and never rendered.
 * @returns The mapped message, or the generic "did not complete" message for any code outside the map.
 */
export const signInErrorMessage = (code: string): string =>
  t(
    Object.hasOwn(SIGN_IN_ERRORS, code)
      ? SIGN_IN_ERRORS[code as keyof typeof SIGN_IN_ERRORS]
      : 'login.error.single_sign_on_failed',
  );

const AUTH_PATHS = new Set(['/login', '/onboarding']);

/**
 * Keeps the post-sign-in destination inside this app. A prefix check alone is not enough: the browser's URL parser strips tab and newline characters and reads a backslash as a slash, so `/\t/evil.example` or `/\evil.example` pass a "starts with one slash" test and still resolve to another site. Resolving the value the same way the browser will, then comparing origins, closes every such spelling at once. The auth pages are rejected too, so a leftover `?from=/login` cannot strand a freshly signed-in operator on the sign-in page.
 *
 * @param from - The untrusted `?from=` value; it becomes both the navigation target and the single sign-on `returnTo`.
 * @returns A same-origin path with its query and fragment, re-serialised from the parsed URL, or `/` when the value is missing, leaves this origin, or points at an auth page.
 */
const sanitiseFrom = (from: string | undefined): string => {
  if (!from || !from.startsWith('/')) return '/';
  let url: URL;
  try {
    url = new URL(from, window.location.origin);
  } catch {
    return '/';
  }
  if (url.origin !== window.location.origin) return '/';
  // Strip a trailing slash so `/login/` is caught by the exact-match guard.
  const path = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (AUTH_PATHS.has(path)) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
};

function LoginPage() {
  const router = useRouter();
  const search = useSearch({ from: loginRoute.id });
  const { data: status } = useQuery(onboardingStatusQueryOptions);
  // Absent means an older server or a still-loading status: keep the form, which every server supports.
  const passwordSignIn = status?.passwordSignIn !== false;
  const singleSignOn = status?.singleSignOn ?? null;
  const [redirecting, setRedirecting] = useState(false);
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
      // An authorization request that found no session was sent here carrying its own signed query, and it is still waiting. Bouncing to the dashboard strands the agent that started it: the operator signs in, sees their account, and nothing ever completes. Replaying the query at the authorization endpoint resumes it, and the server answers with the redirect on to consent.
      const pending = pendingAuthorizeQuery(window.location.search);
      if (pending !== null) {
        window.location.href = `/api/auth/oauth2/authorize${pending}`;
        return;
      }
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

  const onSingleSignOn = async (): Promise<void> => {
    setGenericError(null);
    setRedirecting(true);
    try {
      const pending = pendingAuthorizeQuery(window.location.search);
      const { url } = await startSingleSignOn({
        returnTo: sanitiseFrom(search.from),
        ...(pending !== null ? { pendingAuthorization: pending } : {}),
      });
      window.location.href = url;
    } catch (cause) {
      setRedirecting(false);
      if (cause instanceof RateLimitedError) {
        setRateLimit({ message: t('login.error.rate_limited.no_retry') });
        return;
      }
      setGenericError(t('login.error.single_sign_on_failed'));
    }
  };

  const inputsDisabled = submitting || !!rateLimit || redirecting;

  return (
    <section className="mx-auto w-full max-w-md space-y-6 rounded-md border border-border-strong bg-bg-elevated p-8">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold text-fg">{t('login.title')}</h1>
        <p className="text-sm text-muted-fg">{t('login.subtitle')}</p>
      </header>

      {search.reason === 'expired' && !rateLimit && (
        <Alert variant="default" data-testid="login-session-expired" aria-live="polite">
          <AlertDescription>{t('login.session_expired')}</AlertDescription>
        </Alert>
      )}

      {status?.passwordSignInForced === true && (
        <Alert variant="default" data-testid="login-password-forced" aria-live="polite">
          <AlertDescription>{t('login.password_forced')}</AlertDescription>
        </Alert>
      )}

      {search.error !== undefined && !rateLimit && (
        <Alert variant="danger" data-testid="login-server-error" aria-live="assertive">
          <AlertDescription>{signInErrorMessage(search.error)}</AlertDescription>
        </Alert>
      )}

      {rateLimit && (
        <Alert variant="danger" data-testid="login-rate-limit" aria-live="assertive">
          <AlertTitle>{t('login.title')}</AlertTitle>
          <AlertDescription>{rateLimit.message}</AlertDescription>
        </Alert>
      )}

      {singleSignOn !== null && (
        <div className="space-y-2">
          <Button
            type="button"
            variant={passwordSignIn ? 'outline' : 'primary'}
            className="w-full"
            disabled={inputsDisabled || !singleSignOn.available}
            onClick={() => void onSingleSignOn()}
            data-testid="login-single-sign-on"
          >
            {redirecting ? t('login.single_sign_on.redirecting') : singleSignOn.buttonLabel}
          </Button>
          {!singleSignOn.available && (
            <p className="text-sm text-muted-fg" data-testid="login-single-sign-on-unavailable">
              {t('login.single_sign_on.unavailable')}
            </p>
          )}
        </div>
      )}

      {singleSignOn !== null && passwordSignIn && (
        <p className="text-center text-xs tracking-wide text-muted-fg uppercase">{t('login.or')}</p>
      )}

      {passwordSignIn && (
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
              <p id="login-email-error" className="text-sm text-danger">
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
              <p id="login-password-error" className="text-sm text-danger">
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
      )}

      {!passwordSignIn && genericError && (
        <Alert variant="danger" data-testid="login-generic-error">
          <AlertDescription>{genericError}</AlertDescription>
        </Alert>
      )}
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
