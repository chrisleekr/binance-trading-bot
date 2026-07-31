// Scheduled-backup config + status panel for /settings/backup-restore.
//
// GET-on-mount then PUT-on-save, mirroring the account page's change-password
// pattern (manual useState, not a TanStack mutation) since this is an
// account-level singleton, not a list. The status block translates the derived
// timestamps into plain language for a solo operator who is not a DBA: "Last
// backup 5m ago", "Next backup in about 3h". Client guard rails mirror the
// server bounds so a fat-fingered value is caught before the round trip; the
// server 422 is the backstop and its message surfaces in the banner.

import { BackupConfigPut, type BackupConfigResponse } from '@app/contracts';
import { useEffect, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { errorMessage } from '@/shared/lib/api';
import { humaniseAge } from '@/shared/lib/format-time';
import { fetchBackupConfig, putBackupConfig } from '@/features/account/api/backup-config';

// Mirror the server bounds (`BackupConfigPut`) so the client catches an
// out-of-range value before the round trip. The server 422 remains the backstop.
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 8760;
const RETENTION_MIN = 1;
const RETENTION_MAX = 365;

/** Render a byte count as KB/MB so a multi-megabyte dump reads at a glance. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Last backup …" line: relative age of the most recent dump, or "never". */
function lastBackupLine(lastBackupAt: string | null, nowMs: number): string {
  if (lastBackupAt === null) return 'never';
  return `${humaniseAge(nowMs - Date.parse(lastBackupAt))} ago`;
}

/**
 * "Next backup …" line. Disabled means no schedule ("—"); enabled but no due
 * time yet means the first run hasn't been scheduled ("pending first backup");
 * a future due time renders as "in about Xm"; a past due time means the cron is
 * about to pick it up ("any moment now").
 */
function nextBackupLine(enabled: boolean, nextDueAt: string | null, nowMs: number): string {
  if (!enabled) return '—';
  if (nextDueAt === null) return 'pending first backup';
  const dueMs = Date.parse(nextDueAt);
  if (dueMs <= nowMs) return 'any moment now';
  return `in about ${humaniseAge(dueMs - nowMs)}`;
}

/**
 * View + edit the scheduled DB backup. A backup is a full copy of the trading
 * database written to the server's local backups folder; this panel turns the
 * schedule on or off, sets how often it runs, and how many copies to keep.
 */
export function BackupSettingsCard(): React.JSX.Element {
  const [status, setStatus] = useState<BackupConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState('24');
  const [retentionCount, setRetentionCount] = useState('7');

  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [saving, setSaving] = useState(false);

  // Pin a single "now" per render so the two relative-time lines agree. The
  // panel re-renders on every state change, which is frequent enough that a
  // dedicated tick timer would be noise.
  const nowMs = Date.now();

  const applyConfig = (config: BackupConfigResponse): void => {
    setStatus(config);
    setEnabled(config.enabled);
    setIntervalHours(String(config.intervalHours));
    setRetentionCount(String(config.retentionCount));
  };

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const config = await fetchBackupConfig();
        if (!cancelled) applyConfig(config);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const intervalNum = Number(intervalHours);
  const retentionNum = Number(retentionCount);
  const intervalValid =
    Number.isInteger(intervalNum) && intervalNum >= INTERVAL_MIN && intervalNum <= INTERVAL_MAX;
  const retentionValid =
    Number.isInteger(retentionNum) &&
    retentionNum >= RETENTION_MIN &&
    retentionNum <= RETENTION_MAX;

  const onSave = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBanner(null);
    if (!intervalValid || !retentionValid) return;
    const parsed = BackupConfigPut.safeParse({
      enabled,
      intervalHours: intervalNum,
      retentionCount: retentionNum,
    });
    if (!parsed.success) {
      setBanner({ kind: 'err', message: 'Check the run-every and keep values.' });
      return;
    }
    setSaving(true);
    try {
      const updated = await putBackupConfig(parsed.data);
      applyConfig(updated);
      setBanner({ kind: 'ok', message: 'Backup settings saved.' });
    } catch (err) {
      setBanner({ kind: 'err', message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  if (loadError !== null) {
    return (
      <Panel title="Automatic backups">
        <p className="text-danger text-sm">Could not load backup settings: {loadError}</p>
      </Panel>
    );
  }

  if (status === null) {
    return (
      <Panel title="Automatic backups">
        <p className="text-muted-fg text-sm">Loading…</p>
      </Panel>
    );
  }

  const saveDisabled = saving || !intervalValid || !retentionValid;

  return (
    <Panel
      title="Automatic backups"
      description="A backup is a full copy of your trading database saved to the server's local backups folder. Turn this on to have the bot make copies on a schedule."
    >
      <div className="space-y-4">
        {/* Status — plain-language read of where the schedule stands right now. */}
        <dl className="text-sm">
          <div className="flex justify-between gap-3 py-1">
            <dt className="text-muted-fg">Automatic backups</dt>
            <dd className="text-fg">{status.enabled ? 'On' : 'Off'}</dd>
          </div>
          <div className="flex justify-between gap-3 py-1">
            <dt className="text-muted-fg">Last backup</dt>
            <dd className="text-fg">{lastBackupLine(status.lastBackupAt, nowMs)}</dd>
          </div>
          <div className="flex justify-between gap-3 py-1">
            <dt className="text-muted-fg">Next backup</dt>
            <dd className="text-fg">{nextBackupLine(status.enabled, status.nextDueAt, nowMs)}</dd>
          </div>
        </dl>

        <form onSubmit={onSave} className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="backup-enabled">Make backups automatically</Label>
            <Switch
              id="backup-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Make backups automatically"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="backup-interval">Run every (hours)</Label>
            <Input
              id="backup-interval"
              type="number"
              inputMode="numeric"
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
              className="w-full"
            />
            {!intervalValid ? (
              <p className="text-danger text-sm">
                Enter a whole number of hours between {INTERVAL_MIN} and {INTERVAL_MAX}.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="backup-retention">Keep (most recent copies)</Label>
            <Input
              id="backup-retention"
              type="number"
              inputMode="numeric"
              min={RETENTION_MIN}
              max={RETENTION_MAX}
              value={retentionCount}
              onChange={(e) => setRetentionCount(e.target.value)}
              className="w-full"
            />
            {!retentionValid ? (
              <p className="text-danger text-sm">
                Enter a whole number between {RETENTION_MIN} and {RETENTION_MAX}. Older copies are
                deleted once you have this many.
              </p>
            ) : null}
          </div>

          <ActionBanner banner={banner} />
          <Button
            type="submit"
            variant="default"
            disabled={saveDisabled}
            className="w-full sm:w-56"
          >
            {saving ? 'Saving…' : 'Save backup settings'}
          </Button>
        </form>

        <div className="space-y-2">
          <h3 className="text-fg text-sm font-semibold">Recent backups</h3>
          {status.recentBackups.length === 0 ? (
            <p className="text-muted-fg text-sm">No backups yet.</p>
          ) : (
            // Only the 10 most recent; retention can keep far more on disk than
            // is useful to scan here. Sort by modified time so "most recent" holds
            // regardless of the order the API returns.
            <ul className="divide-border border-border divide-y border-t">
              {[...status.recentBackups]
                .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
                .slice(0, 10)
                .map((file) => (
                  <li
                    key={file.name}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="text-fg min-w-0 truncate font-mono text-xs">{file.name}</span>
                    <span className="text-muted-fg flex shrink-0 items-center gap-3 tabular-nums">
                      <span>{formatSize(file.sizeBytes)}</span>
                      <span>{humaniseAge(nowMs - Date.parse(file.modifiedAt))} ago</span>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
