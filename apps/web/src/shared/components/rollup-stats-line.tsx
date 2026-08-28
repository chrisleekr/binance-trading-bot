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
 * Which of the five render depends on the bucket's fee tier, and the split is not about confidence, it is about which statistics the missing fact can actually corrupt. Trade count is a count. Win rate is classified on the net subtotal, which is wrong by the same fee whichever way it moved, so the classification survives an unaccounted charge. The other three are ratios OF that fee-adjusted money, and an unaccounted charge only ever makes them look better — a fee that was paid and not recorded raises the profit factor, never lowers it. Withholding exactly those three is why the operator still gets the two figures that were always sound, where the whole line used to be replaced by a sentence.
 *
 * An `estimated` bucket renders all five and says so in words rather than a tint: the reader has to be able to repeat the caveat back, and a colour is invisible to a screen reader and to anyone reading this on a phone in daylight.
 *
 * @param props - The rollup bucket whose statistics and fee tier are displayed; an absent tier reads as `unknown`.
 * @returns The statistics this bucket's evidence supports, marked when they rest on a reconstruction.
 */
export function RollupStatsLine({ bucket }: { bucket: RollupStatsBucket }): React.JSX.Element {
  // `?? 'unknown'` rather than a bare read: the tier is defaulted at the contract boundary, but a body that never went through it (an optimistic write, a fixture) leaves it undefined, and treating that silence as evidence is the direction this whole change exists to close.
  const feeBasis = bucket.feeBasis ?? 'unknown';
  const counts = (
    <>
      {bucket.tradeCount} trade{bucket.tradeCount === 1 ? '' : 's'} · {winPct(bucket)}% win
    </>
  );
  if (feeBasis === 'unknown') {
    return (
      <span
        className="text-[11px] text-muted-fg tabular-nums"
        data-testid="rollup-stats-incomplete"
      >
        {counts} · fees not accounted
      </span>
    );
  }
  const pf = profitFactor(bucket);
  const payoff = payoffRatio(bucket);
  const exp = expectancy(bucket);
  return (
    <span className="text-[11px] text-muted-fg tabular-nums">
      {counts} · PF {pf === null ? '∞' : formatProfitFactor(pf)}
      {payoff !== null ? ` · payoff ${payoff.toFixed(2)}` : ''}
      {exp !== null ? ` · exp ${formatExpectancy(exp)}/trade` : ''}
      {feeBasis === 'estimated' ? ' · estimated' : ''}
    </span>
  );
}
