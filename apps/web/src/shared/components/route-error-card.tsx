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
      className="border-border bg-card text-card-fg mx-auto max-w-md rounded-md border p-4"
    >
      <h2 className="text-lg font-semibold">{t('error.title')}</h2>
      <p className="text-muted-fg mt-2 break-words text-sm">{message}</p>
      <div className="mt-4">
        <Button type="button" onClick={onRetry}>
          {t('error.retry')}
        </Button>
      </div>
    </section>
  );
}
