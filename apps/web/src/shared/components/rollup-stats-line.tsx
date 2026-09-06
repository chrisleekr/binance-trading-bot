import {
  expectancy,
  formatExpectancy,
  formatProfitFactor,
  payoffRatio,
  profitFactor,
  type RollupStatsBucket,
  winPct,
} from '@/shared/lib/rollup-stats';

/**
 * Trades, win rate, profit factor, payoff, and expectancy shared by the archive bands and the Home rollups. `∞` is an unbounded profit factor, payoff is average win divided by average loss, and negative expectancy means the edge loses money after costs.
 *
 * Which of them render depends on the bucket's fee tier, and the split is not about confidence, it is about which statistics the missing fact can actually corrupt. Trade count is a count, and survives anything. The other four are all read off the fee-adjusted money — win rate included, because a cycle counts as a win by clearing its fees — and a charge that was paid but never recorded only ever makes them look better. So at `unknown`, where no cycle in the bucket could be valued at all, the count is the only figure left; the win rate goes with the other three rather than standing beside a sentence saying the fees behind it were never read.
 *
 * At the two valued tiers the bucket may still hold cycles that were left out, and then the covered count is stated on the same line. That is the only place a reader learns the ratios and the trade count have different denominators.
 *
 * An `estimated` bucket renders all five and says so in words rather than a tint: the reader has to be able to repeat the caveat back, and a colour is invisible to a screen reader and to anyone reading this on a phone in daylight.
 *
 * @param props - The rollup bucket whose statistics and fee tier are displayed; an absent tier reads as `unknown`.
 * @returns The statistics this bucket's evidence supports, marked when they rest on a reconstruction.
 */
export function RollupStatsLine({ bucket }: { bucket: RollupStatsBucket }): React.JSX.Element {
  // `?? 'unknown'` rather than a bare read: the tier is defaulted at the contract boundary, but a body that never went through it (an optimistic write, a fixture) leaves it undefined, and treating that silence as evidence is the direction this whole change exists to close.
  const feeBasis = bucket.feeBasis ?? 'unknown';
  const trades = (
    <>
      {bucket.tradeCount} trade{bucket.tradeCount === 1 ? '' : 's'}
    </>
  );
  if (feeBasis === 'unknown') {
    return (
      <span
        className="text-[11px] text-muted-fg tabular-nums"
        data-testid="rollup-stats-incomplete"
      >
        {trades} · fees not accounted
      </span>
    );
  }
  // The rows every ratio below is folded over. A bucket that valued all of its cycles states nothing extra; one that valued some of them says which, because the trade count beside the ratios is not their denominator.
  const covered = bucket.netTradeCount ?? bucket.tradeCount;
  const excluded = bucket.tradeCount - covered;
  const pf = profitFactor(bucket);
  const payoff = payoffRatio(bucket);
  const exp = expectancy(bucket);
  return (
    <span className="text-[11px] text-muted-fg tabular-nums">
      {trades} · {winPct(bucket)}% win · PF {pf === null ? '∞' : formatProfitFactor(pf)}
      {payoff !== null ? ` · payoff ${payoff.toFixed(2)}` : ''}
      {exp !== null ? ` · exp ${formatExpectancy(exp)}/trade` : ''}
      {feeBasis === 'estimated' ? ' · estimated' : ''}
      {excluded > 0 ? ` · ${covered} of ${bucket.tradeCount} cycles` : ''}
    </span>
  );
}
