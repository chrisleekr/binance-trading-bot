import { useState, type FormEvent, type ReactNode } from 'react';

import { NavBar } from '@/features/profile/wizard/steps/NavBar';
import type { StepProps } from '@/features/profile/wizard/reducer';
import { Panel } from '@/shared/components/panel';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { t } from '@/shared/lib/i18n';

/** Step 1: profile name. The Binance test/live environment is a property of the
 * account, not the profile, so it is chosen when the account is created, not
 * here. */
export function Step1Name({ state, dispatch }: StepProps): ReactNode {
  const [name, setName] = useState(state.name);
  const [nameError, setNameError] = useState<string | null>(null);

  const onNext = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError(t('wizard.step1.error.name_required'));
      return;
    }
    if (trimmed.length > 64) {
      setNameError(t('wizard.step1.error.name_too_long'));
      return;
    }
    if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) {
      setNameError(t('wizard.step1.error.name_invalid'));
      return;
    }
    setNameError(null);
    dispatch({ type: 'set-name', name: trimmed });
    dispatch({ type: 'goto', step: 2 });
  };

  return (
    <form className="space-y-5" onSubmit={onNext} data-testid="wizard-step-1">
      <Panel title={t('wizard.step1.title')}>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t('wizard.step1.field.name')}</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('wizard.step1.field.name.placeholder')}
              aria-describedby="profile-name-help"
              aria-invalid={nameError !== null}
              autoFocus
            />
            <p id="profile-name-help" className="text-muted-fg text-xs">
              {t('wizard.step1.field.name.help')}
            </p>
            {nameError ? (
              <p role="alert" className="text-danger text-xs">
                {nameError}
              </p>
            ) : null}
          </div>
        </div>
      </Panel>

      <NavBar onNext="submit" />
    </form>
  );
}
