import {
  expectancy,
  formatExpectancy,
  payoffRatio,
  profitFactor,
  type RollupStatsBucket,
  winPct,
} from '@/shared/lib/rollup-stats';

/**
 * Trades · win% · profit-factor · payoff · expectancy sub-line, shared by the
 * trade-archive by-exit-reason / by-source bands and the Home scoped strip's
 * by-source band. Win%, PF, payoff, and expectancy are all NET of fees. `∞` is
 * the unbounded profit factor (winners, no losers); see {@link profitFactor}.
 * Payoff is avg win ÷ avg loss (reward:risk); expectancy is the average net
 * profit per trade — negative means the edge loses money after costs.
 */
export function RollupStatsLine({ bucket }: { bucket: RollupStatsBucket }): React.JSX.Element {
  const pf = profitFactor(bucket);
  const payoff = payoffRatio(bucket);
  const exp = expectancy(bucket);
  return (
    <span className="text-muted-fg text-[11px] tabular-nums">
      {bucket.tradeCount} trade{bucket.tradeCount === 1 ? '' : 's'} · {winPct(bucket)}% win · PF{' '}
      {pf === null ? '∞' : pf}
      {payoff !== null ? ` · payoff ${payoff.toFixed(2)}` : ''}
      {exp !== null ? ` · exp ${formatExpectancy(exp)}/trade` : ''}
    </span>
  );
}
