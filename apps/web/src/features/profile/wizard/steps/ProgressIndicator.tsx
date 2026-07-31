import type { ReactNode } from 'react';

import { t } from '@/shared/lib/i18n';

/** Step counter plus progress bar shown above the active wizard step. */
export function ProgressIndicator({
  current,
  total,
}: {
  current: number;
  total: number;
}): ReactNode {
  return (
    <div className="space-y-2" aria-label={t('wizard.progress.label')}>
      <p
        id="wizard-step-label"
        className="text-muted-fg text-xs tracking-wide"
        data-testid="wizard-step-label"
      >
        {t('wizard.progress.step', { current, total })}
      </p>
      <div
        role="progressbar"
        aria-labelledby="wizard-step-label"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current}
        className="bg-bg-elevated h-1.5 overflow-hidden rounded-md"
      >
        <div
          className="bg-accent h-full transition-all"
          style={{ width: `${Math.round((current / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
