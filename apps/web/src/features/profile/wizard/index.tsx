import { useQuery } from '@tanstack/react-query';
import { useReducer, type ReactNode } from 'react';

import { strategiesQueryOptions } from '@/features/profile/api/strategies';
import { initialState, reducer, TOTAL_STEPS } from '@/features/profile/wizard/reducer';
import { ProgressIndicator } from '@/features/profile/wizard/steps/ProgressIndicator';
import { Step1Name } from '@/features/profile/wizard/steps/Step1Name';
import { Step2Strategy } from '@/features/profile/wizard/steps/Step2Strategy';
import { useWizardSubmit } from '@/features/profile/wizard/use-wizard-submit';
import { PageHeader } from '@/shared/components/page';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { t } from '@/shared/lib/i18n';

/**
 * /profiles/new: multi-step wizard that walks the operator from a blank page
 * to a saved profile (Name → Strategy). Each step is a self-contained
 * component; shared state lives in the `reducer`, submit orchestration in
 * `useWizardSubmit`. The strategy step creates the profile with the strategy's
 * default config; the operator then tunes it on the profile's config page.
 * Symbols and the account API key are added afterward from their own pages.
 */
export function ProfileWizardPage(): ReactNode {
  const [state, dispatch] = useReducer(reducer, initialState);
  const strategiesQuery = useQuery(strategiesQueryOptions);
  const submit = useWizardSubmit(state, dispatch);

  return (
    <section className="space-y-6" data-testid="profile-new-wizard" aria-label={t('wizard.title')}>
      <PageHeader title={t('wizard.title')} description={t('wizard.subtitle')} />

      <ProgressIndicator current={state.step} total={TOTAL_STEPS} />

      {state.error ? (
        <Alert variant="danger" data-testid="wizard-error">
          <AlertTitle>{t('error.title')}</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {state.step === 1 ? <Step1Name state={state} dispatch={dispatch} /> : null}
      {state.step === 2 ? (
        <Step2Strategy
          state={state}
          dispatch={dispatch}
          strategies={strategiesQuery.data ?? []}
          loading={strategiesQuery.isLoading}
          error={strategiesQuery.error}
          onSubmit={submit}
        />
      ) : null}
    </section>
  );
}
