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
        className="text-xs tracking-wide text-muted-fg"
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
        className="h-1.5 overflow-hidden rounded-md bg-bg-elevated"
      >
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.round((current / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
