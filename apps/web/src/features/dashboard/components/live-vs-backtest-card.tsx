import { useEdgeVerdict, useScorecardInputs } from '@/features/dashboard/lib/use-edge-verdict';
import { useEquitySnapshots } from '@/features/dashboard/components/equity-pnl-card';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatMoneyAmount } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { maxDrawdownQuote, mergeRollupBuckets } from '@/shared/lib/live-scorecard';
import { expectancy, formatExpectancy, profitFactor, winPct } from '@/shared/lib/rollup-stats';

const fmtPf = (pf: number | null): string => (pf === null ? '∞' : pf.toFixed(2));
/** Win-rate gap in percentage points (additively meaningful, unlike a PF ratio). */
const fmtWinDelta = (d: number | null): string =>
  d === null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;

/**
 * The honest "is live still matching the backtest?" scorecard. Live win-rate / profit-factor / expectancy over the trades recorded since the baseline was pinned (all recorded trades when there is no pin time), max-drawdown from the equity curve, and — when a backtest run is pinned as the baseline — the win-rate and profit-factor of that backtest beside the live figures. Only those two are compared: they are scale-invariant, so they hold across the backtest's capital and the live account's. Absolute P&L and drawdown are shown for live only, never differenced against the backtest (different capital makes that meaningless).
 *
 * @param props.profileId - The profile whose live archive, equity curve and pinned baseline are compared.
 * @returns The scorecard section, a placeholder while the profile or its archive loads, or a plain error when the profile cannot be read.
 */
export function LiveVsBacktestCard({ profileId }: { profileId: string }): React.JSX.Element {
  const timeZone = useTimezone();
  const { profile, archive, baseline, baselineId, pinnedAt } = useScorecardInputs(profileId);
  const equity = useEquitySnapshots(profileId);

  const quote = profile.data?.quoteAsset ?? equity.data?.quoteAsset ?? '';
  // Counted in the same currency the figures are labelled with, one line below. The rollup spans every quote the profile settled in over the window.
  const bucket = mergeRollupBuckets(archive.data?.bySource ?? [], quote);
  // The fee-valued count, not the window's. Win rate and profit factor are both read off the fee-adjusted money, so they exist only over the cycles whose commission is known; gating them on the window's count printed a two-cycle "100%" from a forty-cycle window and then differenced it against the backtest's rate.
  const liveWin = bucket.netTradeCount > 0 ? winPct(bucket) : null;
  const livePf = bucket.netTradeCount > 0 ? profitFactor(bucket) : null;
  // How many of the window's cycles the four live figures were actually taken over. Stated on the card whenever it is short of the whole, because `feeBasis` no longer says so: `unknown` now means NOTHING could be valued, so a window that valued two of forty reads `estimated` and looks complete.
  const liveExcluded = bucket.tradeCount - bucket.netTradeCount;
  const liveExp = expectancy(bucket);
  const liveDd = maxDrawdownQuote(equity.data?.points);
  // `unknown` only. This card compares live results against a backtest, so a total with a charge missing would move the comparison in a known direction on evidence that is not there. An `estimated` total still supports the comparison and is marked below the figures; the edge-decay verdict is held to the stronger bar separately, inside `useEdgeVerdict`.
  const feesIncomplete = bucket.tradeCount > 0 && bucket.feeBasis === 'unknown';
  const feesEstimated = bucket.tradeCount > 0 && bucket.feeBasis === 'estimated';

  const btMetrics = baseline.data?.result?.metrics;
  // The backtest reports win rate already as a percent (0..100, unrounded), unlike the 0..1 ratios elsewhere; rounded here to match the live side's whole percent.
  const btWin = btMetrics?.winRate ?? null;
  const btPf = btMetrics?.profitFactor ?? null;
  // Win rate is a percentage, so a percentage-point delta is meaningful. Profit
  // factor is a ratio — a *difference* of ratios is not (1.5→3.0 and 3.0→4.5
  // both read "+1.5" but mean very different things), so PF is shown side by
  // side without a delta.
  // Differenced against the rounded backtest rate the tile shows, so two rates that read equal get `+0%`, not a red `-0%` from the hidden fraction.
  const winDelta = liveWin !== null && btWin !== null ? liveWin - Math.round(btWin) : null;

  // Edge-decay verdict — shared with the overview health strip via one hook, so
  // the badge here and the strip's headline always agree. Advisory only.
  const edge = useEdgeVerdict(profileId);

  return (
    <section
      aria-labelledby="live-scorecard-h"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
      data-testid="live-vs-backtest-card"
    >
      <h2 id="live-scorecard-h" className="text-sm font-semibold text-fg">
        Live vs backtest
      </h2>

      {profile.isError ? (
        <p className="text-sm text-muted-fg" data-testid="live-scorecard-profile-error">
          Couldn't load this profile.
        </p>
      ) : archive.isError ? (
        <p className="text-sm text-muted-fg" data-testid="live-scorecard-archive-error">
          Couldn't load this profile's live trades.
        </p>
      ) : profile.isPending || archive.isPending ? (
        // The window and the trade count both come from these two reads; rendering before they land would state "all time" and "no closed trades" as fact.
        <LoadingRows rows={3} />
      ) : (
        <>
          {/* The window in words: without it, an operator who changed config cannot tell whether the figures below include the old config's trades. */}
          <p className="text-xs text-muted-fg" data-testid="live-scorecard-window">
            {pinnedAt !== null
              ? `Live trades recorded since ${formatInstant(pinnedAt, timeZone)}, when you pinned this baseline.`
              : baselineId !== null
                ? 'Live trades from all time, because this baseline was pinned before pin times were recorded. Pin it again to compare only the trades from now on.'
                : 'Live trades from all time.'}
          </p>

          {edge && (edge.verdict === 'warning' || edge.verdict === 'breached') ? (
            <p
              className="rounded border px-2 py-1 text-xs"
              style={{
                borderColor: edge.verdict === 'breached' ? 'var(--down)' : 'var(--warning)',
                color: edge.verdict === 'breached' ? 'var(--down)' : 'var(--warning)',
              }}
              data-testid="edge-decay-badge"
            >
              {edge.verdict === 'breached' ? 'Edge below baseline' : 'Edge weakening'} —{' '}
              {edge.reason}.{' Monitoring only — the bot does not pause buys.'}
            </p>
          ) : null}

          {feesIncomplete ? (
            <p className="text-sm text-muted-fg" data-testid="live-scorecard-fees-incomplete">
              Live Net statistics are unavailable because a commission is unaccounted for. No
              edge-decay verdict is issued from a total that is missing a charge.
            </p>
          ) : bucket.tradeCount === 0 ? (
            <p className="text-sm text-muted-fg">
              No closed trades yet. Win rate, profit factor, and drawdown appear once the bot has
              completed a few round-trips.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              <Stat label="Win rate" value={liveWin === null ? '—' : `${liveWin}%`} />
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
                // Read from the whole equity curve, not the pinned window the line above names, so the hint says so.
                hint="Worst peak-to-trough give-back, all time"
              />
            </div>
          )}

          {/* In words, not a tint: the caveat has to be something the operator can repeat back, and a colour cannot survive being read aloud or screenshotted. Win rate and expectancy are net of the same reconstructed commission, so the note covers the grid rather than one figure. */}
          {feesEstimated ? (
            <p className="text-[11px] text-muted-fg" data-testid="live-scorecard-fees-estimated">
              A commission here was reconstructed from Binance's rate table rather than the charge
              it reported, so these figures are estimates.
            </p>
          ) : null}

          {feesIncomplete || liveExcluded <= 0 ? null : (
            <p className="text-[11px] text-muted-fg" data-testid="live-scorecard-coverage">
              Win rate, profit factor and expectancy cover {bucket.netTradeCount} of{' '}
              {bucket.tradeCount} cycles — the rest have no commission recorded, so they cannot be
              scored either way.
            </p>
          )}

          {feesIncomplete ? null : baselineId === null ? (
            <p className="text-xs text-muted-fg">
              Pin a finished backtest as this profile's baseline (from the Backtest screen) to check
              whether your live edge still matches it.
            </p>
          ) : baseline.data?.result ? (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-xs text-muted-fg">
                vs pinned backtest — win rate and profit factor compare directly
                (scale-independent); absolute P&amp;L is not compared because the capital differs.
              </p>
              <div className="grid grid-cols-2 gap-px bg-border">
                <Stat
                  label="Win rate (bt → live)"
                  value={`${btWin === null ? '—' : `${Math.round(btWin)}%`} → ${liveWin === null ? '—' : `${liveWin}%`}`}
                  delta={fmtWinDelta(winDelta)}
                  deltaUp={winDelta !== null && winDelta >= 0}
                />
                <Stat
                  label="Profit factor (bt → live)"
                  value={`${fmtPf(btPf)} → ${fmtPf(livePf)}`}
                />
              </div>
            </div>
          ) : baseline.isError ? (
            // A failed read must not sit on a pulsing skeleton forever — surface it.
            <p className="text-xs text-muted-fg">Couldn't load the pinned backtest baseline.</p>
          ) : baseline.isLoading || baseline.isPaused ? (
            <div className="space-y-1 border-t border-border pt-2">
              {/* The note plus the two side-by-side comparison stats. */}
              <LoadingRows rows={2} />
            </div>
          ) : (
            // Pinned, fetched, but carrying no result: the run is still queued or
            // running, or it errored. Terminal for this render — a skeleton here
            // would claim data is arriving when nothing is in flight.
            <p className="text-xs text-muted-fg">
              The pinned backtest has no result yet — it is still running, or the run failed.
            </p>
          )}
        </>
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
      <div className="text-xs text-muted-fg">{label}</div>
      <div className="font-mono text-sm font-medium text-fg tabular-nums">
        {value}
        {delta !== undefined ? (
          <span className={`ml-1 text-xs ${deltaUp ? 'text-up' : 'text-down'}`}>({delta})</span>
        ) : null}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] leading-tight text-muted-fg">{hint}</div> : null}
    </div>
  );
}
