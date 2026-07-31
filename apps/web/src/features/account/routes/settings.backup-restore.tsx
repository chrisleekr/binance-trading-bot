// /settings/backup-restore — operator-only DB dump download + restore upload.
//
// Restore is irreversible. The reminder banner stays visible so the operator
// does not forget the dump contains plaintext API keys (the v1.0 threat model
// assumes the operator IP-allowlists the keys at Binance).

import { createRoute } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { BackLink, Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { getApiBaseUrl } from '@/shared/lib/api';
import { BackupSettingsCard } from '@/features/account/components/backup-settings-card';
import { rootRoute } from '@/app/__root';

const downloadBackup = (): void => {
  // Browser-driven download. The API returns a streaming pg_dump custom-format
  // body; opening the URL directly lets the browser save it without buffering
  // the full archive into JS memory first.
  window.location.href = `${getApiBaseUrl()}/backup`;
};

const restoreBackup = async (file: File): Promise<unknown> => {
  const body = new FormData();
  body.set('archive', file);
  const response = await fetch(`${getApiBaseUrl()}/restore`, {
    method: 'POST',
    body,
    credentials: 'include',
  });
  if (!response.ok) {
    // Discard the upstream body. /restore can echo a pg_restore stderr stream
    // that contains schema names, dump file paths, and other operator-side
    // detail that an unprivileged onlooker should not see if the laptop is
    // shoulder-surfed. The status code is enough for the operator to retry.
    void (await response.text().catch(() => ''));
    throw new Error(`restore failed (HTTP ${response.status}). Check server logs.`);
  }
  return response.json();
};

function BackupRestorePage(): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onRestore = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBanner(null);
    if (!file) {
      setBanner({ kind: 'err', message: 'Choose an archive first.' });
      return;
    }
    if (confirmText !== 'RESTORE') {
      setBanner({ kind: 'err', message: 'Type RESTORE in the confirmation box first.' });
      return;
    }
    setSubmitting(true);
    try {
      await restoreBackup(file);
      setBanner({ kind: 'ok', message: 'Restore complete. Reload the app to pick up new state.' });
      setFile(null);
      setConfirmText('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setBanner({ kind: 'err', message: err instanceof Error ? err.message : 'restore failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Backup & restore" back={<BackLink to="/settings" />} />

      <Alert variant="warning">
        <AlertTitle>Plaintext API keys</AlertTitle>
        <AlertDescription>
          The backup file contains your Binance API keys in plaintext. Treat it the same way you
          treat the source-of-truth secret store.
        </AlertDescription>
      </Alert>

      <BackupSettingsCard />

      <Panel title="Download">
        <div className="space-y-3">
          <p className="text-muted-fg text-sm">
            Saves a single backup file with your entire setup — every profile, API key, strategy
            config, and trade history. Your browser downloads it directly.
          </p>
          <Button onClick={downloadBackup} variant="default" className="w-full sm:w-56">
            Download backup
          </Button>
        </div>
      </Panel>

      <Panel title="Restore">
        <div className="space-y-3">
          <p className="text-muted-fg text-sm">
            Replaces everything currently in the bot — all profiles, API keys, configs, and trade
            history — with the contents of the backup file you choose. This overwrites your current
            state and cannot be undone.
          </p>
          <form onSubmit={onRestore} className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".dump,.sql,application/octet-stream"
              aria-label="Backup archive file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-muted-fg rounded-xs file:rounded-xs file:text-fg border-border bg-surface-alt file:border-border file:bg-bg-elevated focus-visible:ring-accent flex h-11 w-full items-center border px-3 py-2 text-sm file:mr-3 file:border file:px-3 file:py-1.5 file:text-sm focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="space-y-1">
              <Label htmlFor="restore-confirm">
                Type <code>RESTORE</code> to confirm.
              </Label>
              <Input
                id="restore-confirm"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                autoComplete="off"
              />
            </div>
            <ActionBanner banner={banner} />
            <Button
              type="submit"
              variant="destructive"
              disabled={submitting || file === null || confirmText !== 'RESTORE'}
              className="w-full sm:w-56"
            >
              {submitting ? 'Restoring…' : 'Restore'}
            </Button>
          </form>
        </div>
      </Panel>
    </Page>
  );
}

/**
 * `/settings/backup-restore` — operator-only DB dump + restore.
 *
 * Mounted at `/account` because backups are exchange-account-wide, never
 * profile-scoped (a single dump round-trips every profile's config, state,
 * and audit history).
 */
export const backupRestoreRoute = createRoute({
  staticData: { title: 'Backup & restore' },
  getParentRoute: () => rootRoute,
  path: '/settings/backup-restore',
  component: BackupRestorePage,
});
