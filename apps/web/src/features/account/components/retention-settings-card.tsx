// Log-retention settings panel for /settings.
//
// These three numbers used to be environment variables, and `action_logs`
// additionally carried a TimescaleDB retention policy on its own schedule — so
// the table was swept on one horizon while the UI reported another. There is now
// one row, read by the prune crons on every run, edited here.
//
// Lowering a horizon deletes rows on the next sweep and cannot be undone, so a
// reduction asks for confirmation before it is sent.

import { useEffect, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { errorMessage } from '@/shared/lib/api';
import {
  fetchRetentionConfig,
  patchRetentionConfig,
} from '@/features/account/api/retention-config';

import type { RetentionConfigResponse } from '@app/contracts';

// Mirror the server bounds (`RetentionConfigPatch`) so an out-of-range value is
// caught before the round trip. The server 422 remains the backstop.
const DAYS_MIN = 1;
const DAYS_MAX = 365;
const MAXLEN_MIN = 1_000;
const MAXLEN_MAX = 5_000_000;
const CAP_MIN = 1_000;
const CAP_MAX = 10_000_000;

const isWhole = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/**
 * View + edit how long logs are kept. Three separate horizons because they
 * answer different questions and cost different amounts: the action log is the
 * bot's own reasoning (highest volume), the audit log is what the operator
 * changed (tiny, worth keeping far longer), and the trace buffer is a fixed-size
 * in-memory window with no retention at all.
 */
export function RetentionSettingsCard(): React.JSX.Element {
  const [config, setConfig] = useState<RetentionConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actionDays, setActionDays] = useState('1');
  const [actionRows, setActionRows] = useState('200000');
  const [auditDays, setAuditDays] = useState('90');
  const [maxlen, setMaxlen] = useState('100000');

  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (next: RetentionConfigResponse): void => {
    setConfig(next);
    setActionDays(String(next.actionLogDays));
    setActionRows(String(next.actionLogMaxRows));
    setAuditDays(String(next.auditLogDays));
    setMaxlen(String(next.auditStreamMaxlen));
  };

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const loaded = await fetchRetentionConfig();
        if (!cancelled) apply(loaded);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const actionNum = Number(actionDays);
  const rowsNum = Number(actionRows);
  const auditNum = Number(auditDays);
  const maxlenNum = Number(maxlen);
  const actionValid = isWhole(actionNum, DAYS_MIN, DAYS_MAX);
  const rowsValid = isWhole(rowsNum, CAP_MIN, CAP_MAX);
  const auditValid = isWhole(auditNum, DAYS_MIN, DAYS_MAX);
  const maxlenValid = isWhole(maxlenNum, MAXLEN_MIN, MAXLEN_MAX);

  const onSave = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBanner(null);
    if (config === null || !actionValid || !rowsValid || !auditValid || !maxlenValid) return;
    // A reduction is destructive on the next sweep. Confirm the specific loss
    // rather than warning generically, so the operator can see which horizon
    // shrank and by how much.
    const cuts = [
      actionNum < config.actionLogDays
        ? `action logs ${config.actionLogDays}d → ${actionNum}d`
        : null,
      auditNum < config.auditLogDays ? `audit logs ${config.auditLogDays}d → ${auditNum}d` : null,
      rowsNum < config.actionLogMaxRows
        ? `action-log rows per profile ${config.actionLogMaxRows.toLocaleString()} → ${rowsNum.toLocaleString()}`
        : null,
    ].filter((c): c is string => c !== null);
    if (
      cuts.length > 0 &&
      !window.confirm(
        `Shortening retention deletes everything older on the next sweep, permanently:\n\n${cuts.join('\n')}\n\nContinue?`,
      )
    ) {
      return;
    }

    setSaving(true);
    try {
      apply(
        await patchRetentionConfig({
          actionLogDays: actionNum,
          actionLogMaxRows: rowsNum,
          auditLogDays: auditNum,
          auditStreamMaxlen: maxlenNum,
        }),
      );
      setBanner({ kind: 'ok', message: 'Retention settings saved.' });
    } catch (err) {
      setBanner({ kind: 'err', message: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  if (loadError !== null) {
    return (
      <Panel title="Log retention">
        <p className="text-sm text-danger">Could not load retention settings: {loadError}</p>
      </Panel>
    );
  }

  if (config === null) {
    return (
      <Panel title="Log retention">
        <LoadingRows rows={8} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Log retention"
      description="How long the bot keeps its own records. These apply on the next nightly sweep — there is no restart needed."
      testId="retention-settings"
    >
      <form onSubmit={onSave} className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="retention-action-days">Keep action logs (days)</Label>
          <Input
            id="retention-action-days"
            type="number"
            inputMode="numeric"
            min={DAYS_MIN}
            max={DAYS_MAX}
            value={actionDays}
            onChange={(e) => setActionDays(e.target.value)}
            className="w-full"
          />
          <p className="text-xs text-muted-fg">
            What the bot did and why — the Logs tab on each profile. The highest-volume record,
            especially while capture is armed.
          </p>
          {!actionValid ? (
            <p className="text-sm text-danger">
              Enter a whole number of days between {DAYS_MIN} and {DAYS_MAX}.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="retention-action-rows">Keep action logs (rows per profile)</Label>
          <Input
            id="retention-action-rows"
            type="number"
            inputMode="numeric"
            min={CAP_MIN}
            max={CAP_MAX}
            value={actionRows}
            onChange={(e) => setActionRows(e.target.value)}
            className="w-full"
          />
          <p className="text-xs text-muted-fg">
            A second limit on the same log, applied by the same nightly sweep. The day limit above
            decides how far back it reaches; this one stops a single busy profile filling the table
            before that day is up. It counts each profile separately, so a chatty profile cannot
            push a quiet one&rsquo;s history out.
          </p>
          {!rowsValid ? (
            <p className="text-sm text-danger">
              Enter a whole number between {CAP_MIN.toLocaleString()} and {CAP_MAX.toLocaleString()}
              .
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="retention-audit-days">Keep audit logs (days)</Label>
          <Input
            id="retention-audit-days"
            type="number"
            inputMode="numeric"
            min={DAYS_MIN}
            max={DAYS_MAX}
            value={auditDays}
            onChange={(e) => setAuditDays(e.target.value)}
            className="w-full"
          />
          <p className="text-xs text-muted-fg">
            What you changed — every setting edit, manual order and kill-switch flip. A few rows a
            day, so keeping this far longer than the action log costs almost nothing.
          </p>
          {!auditValid ? (
            <p className="text-sm text-danger">
              Enter a whole number of days between {DAYS_MIN} and {DAYS_MAX}.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="retention-maxlen">Trace buffer (entries per profile)</Label>
          <Input
            id="retention-maxlen"
            type="number"
            inputMode="numeric"
            min={MAXLEN_MIN}
            max={MAXLEN_MAX}
            value={maxlen}
            onChange={(e) => setMaxlen(e.target.value)}
            className="w-full"
          />
          <p className="text-xs text-muted-fg">
            The raw per-tick trace, held in memory only. The limit applies to each profile's stream
            separately, and every symbol of a profile shares that profile's budget. Bigger reaches
            further back and survives a longer drainer outage; the cost is Redis memory, sized by
            the audit payload your strategy emits, so measure it with{' '}
            <code>MEMORY USAGE audit:&lt;account&gt;:&lt;profile&gt;:stream</code> before raising it
            far. It is not a retention setting: entries are dropped by count, not by age.
          </p>
          {!maxlenValid ? (
            <p className="text-sm text-danger">
              Enter a whole number between {MAXLEN_MIN.toLocaleString()} and{' '}
              {MAXLEN_MAX.toLocaleString()}.
            </p>
          ) : null}
        </div>

        <ActionBanner banner={banner} />
        <Button
          type="submit"
          variant="default"
          disabled={saving || !actionValid || !rowsValid || !auditValid || !maxlenValid}
          className="w-full sm:w-56"
          data-testid="retention-save"
        >
          {saving ? 'Saving…' : 'Save retention settings'}
        </Button>
      </form>
    </Panel>
  );
}
