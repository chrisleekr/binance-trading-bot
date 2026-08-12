import { SignUpRequest } from '@app/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ApiError, RateLimitedError, ValidationFailedError } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';
import { signUp } from '@/features/auth/api/auth-mutations';
import { ONBOARDING_STATUS_QUERY_KEY } from '@/features/auth/api/auth';
import { rootRoute } from '@/app/__root';

interface FieldErrors {
  email?: string;
  password?: string;
  form?: string;
}

function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setErrors({});

    const parsed = SignUpRequest.safeParse({ email, password });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email') next.email = t('onboarding.error.invalid_email');
        else if (field === 'password') next.password = t('onboarding.error.password_too_short');
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    try {
      await signUp(parsed.data);
      queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true });
      // Sign-up already established a session (Better Auth autoSignIn), so land
      // on the app directly instead of forcing a re-login with the same
      // credentials. `/` redirects to the auto-seeded account dashboard.
      await router.navigate({ to: '/' });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ONBOARDING_CLOSED') {
        queryClient.setQueryData(ONBOARDING_STATUS_QUERY_KEY, { masterExists: true });
        setErrors({ form: t('onboarding.error.closed') });
        await router.navigate({ to: '/login' });
        return;
      }
      if (cause instanceof ValidationFailedError) {
        setErrors({ form: cause.message || t('auth.error.generic') });
        return;
      }
      if (cause instanceof RateLimitedError) {
        setErrors({ form: t('login.error.rate_limited.no_retry') });
        return;
      }
      const message = cause instanceof Error ? cause.message : t('auth.error.generic');
      setErrors({ form: message || t('auth.error.generic') });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-md space-y-6 rounded-md border border-border-strong bg-bg-elevated p-8">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold text-fg">{t('onboarding.title')}</h1>
        <p className="text-sm text-muted-fg">{t('onboarding.subtitle')}</p>
      </header>

      <Alert variant="warning" data-testid="onboarding-warning">
        <AlertTitle>{t('onboarding.warning.title')}</AlertTitle>
        <AlertDescription>{t('onboarding.warning.body')}</AlertDescription>
      </Alert>

      <form noValidate className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="onboarding-email">{t('auth.field.email')}</Label>
          <Input
            id="onboarding-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            placeholder={t('auth.field.email.placeholder')}
            disabled={submitting}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'onboarding-email-error' : undefined}
          />
          {errors.email && (
            <p id="onboarding-email-error" className="text-sm text-danger">
              {errors.email}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-password">{t('auth.field.password')}</Label>
          <Input
            id="onboarding-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            placeholder={t('auth.field.password.placeholder')}
            disabled={submitting}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
            aria-describedby={
              errors.password ? 'onboarding-password-error' : 'onboarding-password-help'
            }
          />
          {errors.password ? (
            <p id="onboarding-password-error" className="text-sm text-danger">
              {errors.password}
            </p>
          ) : (
            <p id="onboarding-password-help" className="text-sm text-muted-fg">
              {t('auth.field.password.help')}
            </p>
          )}
        </div>

        {errors.form && (
          <Alert variant="danger" data-testid="onboarding-form-error">
            <AlertDescription>{errors.form}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
          {submitting ? t('onboarding.submitting') : t('onboarding.submit')}
        </Button>
      </form>
    </section>
  );
}

export const onboardingRoute = createRoute({
  staticData: { title: 'Onboarding' },
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
});
