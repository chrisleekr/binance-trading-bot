import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { t } from '@/shared/lib/i18n';

/**
 * Pre-paste safety guidance for a Binance API key. Two operator actions the
 * bot's security model depends on (keys are stored unencrypted — see
 * docs/architecture/auth.md): scope the key's permissions and IP-allowlist it.
 * Shared by the create wizard (step 4) and the standalone replace form so the
 * guidance cannot drift between the two surfaces.
 */
export function ApiKeyGuidance(): React.JSX.Element {
  return (
    <Alert variant="warning" data-testid="api-key-guidance">
      <AlertTitle>{t('apiKey.guidance.title')}</AlertTitle>
      <AlertDescription>
        <ul className="ml-4 list-disc space-y-1">
          <li>{t('apiKey.guidance.permissions')}</li>
          <li>{t('apiKey.guidance.ipAllowlist')}</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
