import { FlaskConical } from 'lucide-react';

import { t } from '@/shared/lib/i18n';

/**
 * Persistent banner shown on public "Live demo" deployments. Sits at the very
 * top of the shell so every screen carries the "this is a testnet sandbox that
 * resets" context. Rendered only when the onboarding-status query reports
 * demoMode (see AppShell / useDemoMode).
 */
export function DemoBanner() {
  return (
    <div
      data-testid="demo-banner"
      className="bg-accent text-accent-fg flex h-8 shrink-0 items-center justify-center gap-2 px-4 text-center text-xs font-semibold uppercase tracking-wider"
    >
      <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{t('demo.banner')}</span>
    </div>
  );
}
