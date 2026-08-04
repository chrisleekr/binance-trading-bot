import { useQuery } from '@tanstack/react-query';

import { useEdgeVerdict } from '@/features/dashboard/lib/use-edge-verdict';
import { fetchEquitySnapshots } from '@/features/dashboard/api/equity-snapshots';
import { fetchBacktestRun } from '@/features/backtest/api/backtest';
import { fetchProfileArchive } from '@/features/profile/api/archive';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatMoneyAmount, formatPercent } from '@/shared/lib/format';
import { maxDrawdownQuote, mergeRollupBuckets } from '@/shared/lib/live-scorecard';
import { expectancy, formatExpectancy, profitFactor, winPct } from '@/shared/lib/rollup-stats';

const fmtPf = (pf: number | null): string => (pf === null ? '∞' : pf.toFixed(2));
/** Win-rate gap in percentage points (additively meaningful, unlike a PF ratio). */
const fmtWinDelta = (d: number | null): string =>
  d === null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;

/**
 * The honest "is live still matching the backtest?" scorecard. Live win-rate /
 * profit-factor / expectancy / max-drawdown over all closed trades, and — when a
 * backtest run is pinned as the baseline — the win-rate and profit-factor of that
 * backtest beside the live figures. Only those two are compared: they are
 * scale-invariant, so they hold across the backtest's capital and the live
 * account's. Absolute P&L and drawdown are shown for live only, never differenced
 * against the backtest (different capital makes that meaningless).
 */
export function LiveVsBacktestCard({ profileId }: { profileId: string }): React.JSX.Element {
  const timeZone = useTimezone();
  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const archive = useQuery({
    queryKey: ['trade-archive', profileId, 'a', timeZone, 'scorecard'],
    queryFn: () => fetchProfileArchive(profileId, 'a', null, timeZone),
    refetchInterval: 60_000,
  });
  const equity = useQuery({
    queryKey: ['equity-snapshots', profileId],
    queryFn: () => fetchEquitySnapshots(profileId),
    refetchInterval: 60_000,
  });
  const baselineId = profile.data?.baselineBacktestRunId ?? null;
  const baseline = useQuery({
    queryKey: ['backtest', 'run', profileId, baselineId],
    queryFn: () => fetchBacktestRun(profileId, baselineId as string),
    enabled: baselineId !== null,
  });

  const bucket = mergeRollupBuckets(archive.data?.bySource ?? []);
  const quote = profile.data?.quoteAsset ?? equity.data?.quoteAsset ?? '';
  const liveWin = bucket.tradeCount > 0 ? winPct(bucket) : null;
  const livePf = bucket.tradeCount > 0 ? profitFactor(bucket) : null;
  const liveExp = expectancy(bucket);
  const liveDd = maxDrawdownQuote(equity.data?.points);

  const btMetrics = baseline.data?.result?.metrics;
  const btWin = btMetrics?.winRate ?? null;
  const btPf = btMetrics?.profitFactor ?? null;
  // Win rate is a percentage, so a percentage-point delta is meaningful. Profit
  // factor is a ratio — a *difference* of ratios is not (1.5→3.0 and 3.0→4.5
  // both read "+1.5" but mean very different things), so PF is shown side by
  // side without a delta.
  const winDelta = liveWin !== null && btWin !== null ? liveWin - btWin : null;

  // Edge-decay verdict — shared with the overview health strip via one hook, so
  // the badge here and the strip's headline always agree. Advisory only.
  const edge = useEdgeVerdict(profileId);

  return (
    <section
      aria-labelledby="live-scorecard-h"
      className="border-border bg-bg-elevated space-y-2 rounded-md border p-3"
      data-testid="live-vs-backtest-card"
    >
      <h2 id="live-scorecard-h" className="text-fg text-sm font-semibold">
        Live vs backtest
      </h2>

      {edge && (edge.verdict === 'warning' || edge.verdict === 'breached') ? (
        <p
          className="rounded border px-2 py-1 text-xs"
          style={{
            borderColor: edge.verdict === 'breached' ? 'var(--down)' : 'var(--warning)',
            color: edge.verdict === 'breached' ? 'var(--down)' : 'var(--warning)',
          }}
          data-testid="edge-decay-badge"
        >
          {edge.verdict === 'breached' ? 'Edge below baseline' : 'Edge weakening'} — {edge.reason}.
          {' Monitoring only — the bot does not pause buys.'}
        </p>
      ) : null}

      {bucket.tradeCount === 0 ? (
        <p className="text-muted-fg text-sm">
          No closed trades yet. Win rate, profit factor, and drawdown appear once the bot has
          completed a few round-trips.
        </p>
      ) : (
        <div className="bg-border grid grid-cols-2 gap-px sm:grid-cols-4">
          <Stat label="Win rate" value={liveWin === null ? '—' : formatPercent(liveWin)} />
          <Stat
            label="Profit factor"
            value={fmtPf(livePf)}
            hint="Gross win ÷ gross loss; >1 is profitable"
          />
          <Stat
            label="Expectancy"
            value={liveExp === null ? '—' : `${formatExpectancy(liveExp)} ${quote}`}
            hint="Avg net result per closed trade"
          />
          <Stat
            label="Max drawdown"
            value={`${formatMoneyAmount(String(liveDd))} ${quote}`}
            hint="Worst peak-to-trough give-back"
          />
        </div>
      )}

      {baselineId === null ? (
        <p className="text-muted-fg text-xs">
          Pin a finished backtest as this profile's baseline (from the Backtest screen) to check
          whether your live edge still matches it.
        </p>
      ) : baseline.data?.result ? (
        <div className="border-border space-y-1 border-t pt-2">
          <p className="text-muted-fg text-xs">
            vs pinned backtest — win rate and profit factor compare directly (scale-independent);
            absolute P&amp;L is not compared because the capital differs.
          </p>
          <div className="bg-border grid grid-cols-2 gap-px">
            <Stat
              label="Win rate (bt → live)"
              value={`${btWin === null ? '—' : formatPercent(btWin)} → ${liveWin === null ? '—' : formatPercent(liveWin)}`}
              delta={fmtWinDelta(winDelta)}
              deltaUp={winDelta !== null && winDelta >= 0}
            />
            <Stat label="Profit factor (bt → live)" value={`${fmtPf(btPf)} → ${fmtPf(livePf)}`} />
          </div>
        </div>
      ) : baseline.isError ? (
        // A failed read must not sit on a pulsing skeleton forever — surface it.
        <p className="text-muted-fg text-xs">Couldn't load the pinned backtest baseline.</p>
      ) : baseline.isLoading || baseline.isPaused ? (
        <div className="border-border space-y-1 border-t pt-2">
          {/* The note plus the two side-by-side comparison stats. */}
          <LoadingRows rows={2} />
        </div>
      ) : (
        // Pinned, fetched, but carrying no result: the run is still queued or
        // running, or it errored. Terminal for this render — a skeleton here
        // would claim data is arriving when nothing is in flight.
        <p className="text-muted-fg text-xs">
          The pinned backtest has no result yet — it is still running, or the run failed.
        </p>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  delta,
  deltaUp,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly delta?: string;
  readonly deltaUp?: boolean;
}): React.JSX.Element {
  return (
    <div className="bg-bg-elevated p-2">
      <div className="text-muted-fg text-xs">{label}</div>
      <div className="text-fg font-mono text-sm font-medium tabular-nums">
        {value}
        {delta !== undefined ? (
          <span className={`ml-1 text-xs ${deltaUp ? 'text-up' : 'text-down'}`}>({delta})</span>
        ) : null}
      </div>
      {hint ? <div className="text-muted-fg mt-0.5 text-[11px] leading-tight">{hint}</div> : null}
    </div>
  );
}
