import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/shared/components/ui/button';
import { t } from '@/shared/lib/i18n';

/** Back/Next control row shared by every wizard step. */
export function NavBar({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  nextVariant,
  backDisabled,
}: {
  onBack?: () => void;
  onNext: 'submit' | (() => void);
  nextLabel?: string;
  nextDisabled?: boolean;
  nextVariant?: ComponentProps<typeof Button>['variant'];
  backDisabled?: boolean;
}): ReactNode {
  const next =
    onNext === 'submit' ? (
      <Button type="submit" variant={nextVariant} disabled={nextDisabled} data-testid="wizard-next">
        {nextLabel ?? t('wizard.nav.next')}
      </Button>
    ) : (
      <Button
        type="button"
        variant={nextVariant}
        onClick={onNext}
        disabled={nextDisabled}
        data-testid="wizard-next"
      >
        {nextLabel ?? t('wizard.nav.next')}
      </Button>
    );
  return (
    <div className="flex items-center justify-between pt-2">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={backDisabled}
          data-testid="wizard-back"
        >
          {t('wizard.nav.back')}
        </Button>
      ) : (
        <span />
      )}
      {next}
    </div>
  );
}
