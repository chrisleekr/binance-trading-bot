import { Button } from '@/shared/components/ui/button';
import { t } from '@/shared/lib/i18n';

export interface RouteErrorCardProps {
  error: unknown;
  onRetry: () => void;
}

export function RouteErrorCard({ error, onRetry }: RouteErrorCardProps) {
  const message = error instanceof Error && error.message ? error.message : t('error.unknown');
  return (
    <section
      role="alert"
      aria-live="polite"
      data-testid="route-error-card"
      className="mx-auto max-w-md rounded-md border border-border bg-card p-4 text-card-fg"
    >
      <h2 className="text-lg font-semibold">{t('error.title')}</h2>
      <p className="mt-2 text-sm break-words text-muted-fg">{message}</p>
      <div className="mt-4">
        <Button type="button" onClick={onRetry}>
          {t('error.retry')}
        </Button>
      </div>
    </section>
  );
}
