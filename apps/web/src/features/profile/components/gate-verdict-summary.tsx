import { useQuery } from '@tanstack/react-query';
import type { EdgeDecayVerdict, GateStatusResponse } from '@app/contracts';

import { useEdgeVerdict, useScorecardInputs } from '@/features/dashboard/lib/use-edge-verdict';
import { gateStatusQueryOptions } from '@/features/profile/api/gate-status';
import { Panel } from '@/shared/components/panel';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatFixed2 } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { mergeRollupBuckets } from '@/shared/lib/live-scorecard';

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

interface BacktestCheck {
  headline: string;
  detail: string | null;
  failedChecks: readonly string[];
}

/**
 * The server's gate detail as a sentence of its own. `describeGateOutcome` writes a lowercase clause with no full stop, so it is capitalised and closed here once rather than at every render site.
 *
 * @param text - The server's detail clause.
 * @returns The clause with its first letter capitalised and a full stop added only when it has none, or null when it is blank.
 */
const asSentence = (text: string): string | null => {
  const t = text.trim();
  if (t === '') return null;
  const capitalised = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

const headlineOnly = (headline: string): BacktestCheck => ({
  headline,
  detail: null,
  failedChecks: [],
});

/**
 * The backtest check as one plain sentence, plus the server's detail when it failed.
 *
 * @param data - The gate-status read; undefined while it loads and after it fails.
 * @param isError - True when the gate-status request failed, so an absent `data` means the read gave up rather than that it is still loading.
 * @returns The headline, the server's sentence only for a failure with no listed checks, and the failed checks one per line.
 */
export function describeBacktestCheck(
  data: GateStatusResponse | undefined,
  isError: boolean,
): BacktestCheck {
  // Checked first: a failed read has no data, which the loading branch below would otherwise show forever.
  if (isError) return headlineOnly("Backtest check: couldn't load the gate status.");
  if (!data) return headlineOnly('Backtest check: loading…');
  if (data.applicability === 'not-live') {
    return headlineOnly(
      'Backtest check: applies to live accounts only, and this one is on testnet.',
    );
  }
  if (data.applicability === 'gate-off') return headlineOnly('Backtest check: off.');
  if (data.ok) return headlineOnly('Backtest check: cleared.');
  const below = data.failedChecks.length;
  return {
    headline:
      below > 0
        ? `Backtest check: not cleared, ${plural(below, 'check')} below the bar.`
        : 'Backtest check: not cleared.',
    // A listed failure says it all line by line; the joined sentence is only for the other failure kinds, which have no checks to list.
    detail: below > 0 ? null : asSentence(data.detail),
    failedChecks: data.failedChecks,
  };
}

const EDGE_WORDS: Record<EdgeDecayVerdict, string> = {
  healthy: 'on track',
  warning: 'edge weakening',
  breached: 'edge below the baseline',
  'insufficient-data': 'too few trades to judge yet',
  'no-baseline': 'no baseline to compare with',
  'monitor-off': 'monitor off',
};

/**
 * The top-of-page answer to "where does this profile stand": whether its config cleared the backtest check, and what the live results are being compared with, in words. Both are advisory; nothing here pauses buys.
 *
 * @param props.profileId - The profile whose gate status and live-vs-backtest window are summarised.
 * @returns The summary panel.
 */
export function GateVerdictSummary({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const gate = useQuery(gateStatusQueryOptions(profileId));
  const { profile, archive, baseline, baselineId, pinnedAt } = useScorecardInputs(profileId);
  const edge = useEdgeVerdict(profileId);
  const check = describeBacktestCheck(gate.data, gate.isError);
  const bucket = mergeRollupBuckets(archive.data?.bySource ?? [], profile.data?.quoteAsset ?? '');
  const baselinePf = baseline.data?.result?.metrics?.profitFactor;

  let comparison: string | null;
  if (profile.isError) {
    comparison = "Live vs backtest: couldn't load this profile.";
  } else if (archive.isError) {
    comparison = "Live vs backtest: couldn't load this profile's live trades.";
  } else if (profile.isPending || archive.isPending) {
    // Both the pin and the trade count come from these reads; until they land, "no baseline pinned" or "from all time" would be stated as fact.
    comparison = null;
  } else if (baselineId === null) {
    comparison =
      'Live vs backtest: no baseline pinned. Pin a finished backtest on the Backtest screen to compare live results with it.';
  } else {
    const since =
      pinnedAt === null
        ? 'from all time'
        : `recorded since you pinned this baseline on ${formatInstant(pinnedAt, timeZone)}`;
    // A null profit factor means the backtest had no losing trade, which the scorecard prints as infinity.
    const pf =
      baselinePf === undefined
        ? ''
        : ` (profit factor ${baselinePf === null ? '∞' : formatFixed2(baselinePf)})`;
    comparison = `Live vs backtest: comparing ${plural(bucket.netTradeCount, 'trade')} ${since} with run ${baselineId.slice(0, 8)}${pf}.`;
  }

  return (
    <Panel title="Where this profile stands" testId="gate-verdict-summary">
      <div className="space-y-2 text-sm text-fg">
        <p data-testid="gate-verdict-check">{check.headline}</p>
        {check.detail ? <p className="text-xs text-muted-fg">{check.detail}</p> : null}
        {check.failedChecks.length > 0 ? (
          <ul
            className="list-disc space-y-1 pl-5 text-xs text-muted-fg"
            data-testid="gate-verdict-failed-checks"
          >
            {check.failedChecks.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {comparison === null ? (
          <LoadingRows rows={1} />
        ) : (
          <p data-testid="gate-verdict-edge">{comparison}</p>
        )}
        {edge && edge.verdict !== 'no-baseline' ? (
          <p className="text-xs text-muted-fg" data-testid="gate-verdict-edge-detail">
            Verdict: {EDGE_WORDS[edge.verdict]} ({edge.reason}). Monitoring only, the bot does not
            pause buys.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
