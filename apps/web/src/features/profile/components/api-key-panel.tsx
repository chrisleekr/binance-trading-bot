// Binance API-key editor, decoupled from any route so it can render inside the
// terminal's edit drawer. Owns its own query + putApiKey mutation; the host
// only supplies the profileId and the drawer chrome.
//
// Shows the bound Binance key as label + last-4 only and replaces it in place.
// The plaintext key never leaves the form: on success the input is cleared, the
// cache is invalidated, and the redacted row reloads.
//
// Empty state (no key bound) drops the read view and shows the same form as the
// primary CTA so onboarding-after-create flows have a single click path.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Panel } from '@/shared/components/panel';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { errorMessage } from '@/shared/lib/api';
import { formatInstant } from '@/shared/lib/format-time';
import { t } from '@/shared/lib/i18n';
import { useTimezone } from '@/shared/context/timezone-context';
import { ApiKeyGuidance } from '@/features/profile/components/api-key-guidance';
import { apiKeyQueryKey, fetchApiKey, putApiKey } from '@/features/profile/api/api-keys';
import { useActiveAccountId } from '@/shared/lib/account-scope';

/**
 * Self-contained Binance API-key editor. Renders the load/error states, the
 * redacted display for a bound key, the empty-state CTA, and the replace/add
 * form with security guidance, all inside one titled Panel. The host supplies
 * only `profileId`.
 */
export function ApiKeyPanel(): React.JSX.Element {
  const timeZone = useTimezone();
  const queryClient = useQueryClient();
  const accountId = useActiveAccountId() ?? '';
  const queryKey = apiKeyQueryKey(accountId);

  const apiKey = useQuery({
    queryKey,
    queryFn: () => fetchApiKey(),
    enabled: accountId !== '',
  });

  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [secret, setSecret] = useState('');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const replace = useMutation({
    mutationFn: () =>
      putApiKey({
        key: keyValue,
        secret,
        ...(label.trim().length > 0 ? { label: label.trim() } : {}),
      }),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Key saved.' });
      setLabel('');
      setKeyValue('');
      setSecret('');
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (keyValue.length === 0 || secret.length < 4) return;
    setBanner(null);
    replace.mutate();
  };

  // The form is revealed only when the operator opts in: either by clicking
  // "Add API key" on the empty state, or "Replace" on an existing row. Auto-
  // showing the form on `data === null` made the empty-state CTA cosmetic —
  // the input fields were already visible, so clicking the button changed
  // nothing the operator could see.
  const showForm = editing;

  return (
    <Panel
      title={t('edit.api_key.title')}
      description="The Binance key this profile trades with. The secret is stored server-side and never shown again."
      testId="api-key-panel"
    >
      <div className="space-y-4">
        {apiKey.isLoading ? <p className="text-sm">Loading…</p> : null}

        {apiKey.error ? (
          <Alert variant="danger">
            <AlertTitle>Failed to load API key</AlertTitle>
            <AlertDescription>
              {apiKey.error instanceof Error ? apiKey.error.message : 'unknown'}
            </AlertDescription>
          </Alert>
        ) : null}

        {apiKey.isSuccess && apiKey.data && !editing ? (
          <div className="space-y-3">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-fg text-xs">Label</dt>
                <dd className="font-medium">{apiKey.data.label ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-fg text-xs">Secret</dt>
                <dd className="font-mono">••••••••{apiKey.data.last4}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-fg text-xs">Bound</dt>
                <dd>{formatInstant(apiKey.data.createdAt, timeZone)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-fg text-xs">Verification</dt>
                <dd className="text-right" data-testid="api-key-verification">
                  {apiKey.data.verificationStatus === 'ok' ? (
                    <span className="text-success font-medium">Verified ✓</span>
                  ) : apiKey.data.verificationStatus === 'failed' ? (
                    <span className="text-destructive font-medium">
                      Failed
                      {apiKey.data.verificationError ? `: ${apiKey.data.verificationError}` : ''}
                    </span>
                  ) : (
                    <span className="text-muted-fg">Verifying…</span>
                  )}
                </dd>
              </div>
            </dl>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(true)}
              className="w-full sm:w-56"
            >
              Replace
            </Button>
          </div>
        ) : null}

        {apiKey.isSuccess && apiKey.data === null && !editing ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-fg">No key bound to this profile yet.</p>
            <Button
              type="button"
              variant="primary"
              onClick={() => setEditing(true)}
              className="w-full sm:w-56"
            >
              Add API key
            </Button>
          </div>
        ) : null}

        {showForm ? (
          <form onSubmit={onSubmit} className="space-y-4">
            <ApiKeyGuidance />
            <div className="space-y-1">
              <Label htmlFor="api-key-label">Label (optional)</Label>
              <Input
                id="api-key-label"
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                maxLength={128}
                placeholder="e.g. read-trade"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-key-key">API key</Label>
              <Input
                id="api-key-key"
                value={keyValue}
                onChange={(e) => setKeyValue(e.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-key-secret">API secret</Label>
              <Input
                id="api-key-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.currentTarget.value)}
                autoComplete="new-password"
                spellCheck={false}
                minLength={4}
                required
              />
            </div>

            <ActionBanner banner={banner} />

            <FormActions>
              {/* Always allow exit from edit mode. Previously the Cancel button
                  was hidden when no key was bound — operators clicking "Add API
                  key" had no way back to the empty state without reloading. */}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setLabel('');
                  setKeyValue('');
                  setSecret('');
                  setBanner(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={replace.isPending || keyValue.length === 0 || secret.length < 4}
              >
                {replace.isPending ? 'Saving…' : 'Save'}
              </Button>
            </FormActions>
          </form>
        ) : null}

        {!showForm ? <ActionBanner banner={banner} /> : null}
      </div>
    </Panel>
  );
}
