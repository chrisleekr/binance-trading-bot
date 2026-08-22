import { useState, type ReactNode } from 'react';

import { NavBar } from '@/features/profile/wizard/steps/NavBar';
import type { StepProps } from '@/features/profile/wizard/reducer';
import { Panel } from '@/shared/components/panel';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { t } from '@/shared/lib/i18n';

import type { StrategyDescriptor } from '@app/contracts';

/**
 * Step 2 (final): pick the strategy plugin that drives the profile. Confirming
 * creates the profile with the strategy's default config; the operator tunes it
 * afterward on the profile's config page.
 */
export function Step2Strategy({
  state,
  dispatch,
  strategies,
  loading,
  error,
  onSubmit,
}: StepProps & {
  strategies: readonly StrategyDescriptor[];
  loading: boolean;
  error: unknown;
  onSubmit: (
    config: unknown,
    strategy?: NonNullable<StepProps['state']['strategy']>,
  ) => Promise<void>;
}): ReactNode {
  const [pickError, setPickError] = useState<string | null>(null);
  const onlyStrategy = strategies.length === 1 ? strategies[0] : undefined;
  const selectedStrategy = state.strategy ?? onlyStrategy;

  const onSelect = (descriptor: StrategyDescriptor): void => {
    dispatch({
      type: 'set-strategy',
      strategy: {
        name: descriptor.name,
        version: descriptor.version,
        displayName: descriptor.displayName,
        defaultConfig: descriptor.defaultConfig,
        configSchema: descriptor.configSchema,
      },
    });
    setPickError(null);
  };

  const onNext = (): void => {
    if (!selectedStrategy) {
      setPickError(t('wizard.step2.error.required'));
      return;
    }
    // Create with the strategy's shipped defaults; the operator edits them on
    // the profile's config page. Pass the config explicitly — submit reads its
    // argument, not wizard state.
    void onSubmit(selectedStrategy.defaultConfig, selectedStrategy);
  };

  if (loading) {
    // The step is the whole page body here, so its placeholder has to carry the
    // panel chrome and the strategy cards the operator is about to choose from.
    return (
      // Its own id, not the loaded step's: `wizard-step-2` is what the wizard
      // tests wait on to mean "step 2 is interactive", and the placeholder
      // renders none of the controls that follows.
      <div className="space-y-5" data-testid="wizard-step-2-loading">
        <Panel title={t('wizard.step2.title')} description={t('wizard.step2.subtitle')}>
          <LoadingRows rows={3} />
        </Panel>
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="danger">
        <AlertTitle>{t('error.title')}</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : t('error.unknown')}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5" data-testid="wizard-step-2">
      <Panel title={t('wizard.step2.title')} description={t('wizard.step2.subtitle')}>
        <div className="space-y-4">
          {strategies.length === 0 ? (
            <Alert>
              <AlertDescription>{t('wizard.step2.empty')}</AlertDescription>
            </Alert>
          ) : (
            <ul
              aria-invalid={!!pickError}
              className={`space-y-2 ${pickError ? 'rounded-xs border border-danger p-2' : ''}`}
              data-testid="wizard-strategy-list"
            >
              {strategies.map((s) => {
                const picked =
                  selectedStrategy?.name === s.name && selectedStrategy.version === s.version;
                return (
                  <li key={`${s.name}@${s.version}`}>
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-xs border p-3 ${
                        picked ? 'border-accent bg-accent/5' : 'border-border'
                      }`}
                    >
                      <input
                        type="radio"
                        name="strategy"
                        checked={picked}
                        onChange={() => onSelect(s)}
                        className="mt-0.5"
                        data-testid={`wizard-strategy-${s.name}`}
                      />
                      <span className="flex flex-1 flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium">{s.displayName}</span>
                          <Badge variant="secondary">
                            {t('wizard.step2.version', { version: s.version })}
                          </Badge>
                        </span>
                        <span className="text-xs text-muted-fg">{s.description}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {pickError ? (
            <p role="alert" className="text-xs text-danger">
              {pickError}
            </p>
          ) : null}
        </div>
      </Panel>

      <NavBar
        onBack={() => dispatch({ type: 'goto', step: 1 })}
        onNext={onNext}
        nextLabel={state.creating ? t('wizard.nav.submitting') : t('wizard.nav.submit')}
        nextDisabled={state.creating}
        nextVariant="primary"
        backDisabled={state.creating}
      />
    </div>
  );
}
