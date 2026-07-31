import { recommendTradeOrHold, type BacktestResult } from '@app/contracts';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { blockReasonLabel, dominantLog, pct } from './results-format';

/**
 * The run's up-front verdict banners: patchy-history warning, the zero-trade
 * (never entered / still holding) banner, and the "holding beat this strategy"
 * banner. Rendered above the comparison strip and metrics so the operator reads
 * the headline caveat before the numbers.
 */
export function ResultsBannersSection({
  result,
}: {
  readonly result: BacktestResult;
}): React.JSX.Element {
  const m = result.metrics;
  const holdVerdict = recommendTradeOrHold(m);
  // A run with no closed round-trips has no result to read: its return and alpha
  // are cash (or an unrealized open position), not strategy performance. Key the
  // banner, the neutral tint, and the hold verdict all on totalTrades so the
  // three agree. noFills then distinguishes a run that never entered (0 fills)
  // from one still holding an open position, so the copy is accurate for both.
  const noClosedTrades = m.totalTrades === 0;
  const noFills = result.trades.length === 0;
  const topBlock = noFills ? dominantLog(result.decisionBreakdown.logs) : null;

  return (
    <>
      {result.dataWarnings.length > 0 && (
        <Alert variant="warning" data-testid="backtest-data-warnings">
          <AlertTitle>Patchy price history</AlertTitle>
          <AlertDescription>
            <p>
              Some symbols are missing candles for parts of this window, so these results may be
              unreliable:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {result.dataWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {noClosedTrades && (
        <Alert variant="warning" data-testid="zero-trade-banner">
          <AlertTitle>
            {noFills
              ? 'This run made 0 trades — the strategy never entered the market'
              : 'This run closed 0 trades — the strategy is still holding an open position'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {noFills
                ? `Nothing was bought or sold over this window, so the ${pct(m.totalReturnPct)} return (and any alpha) reflects cash sitting out the market, not strategy performance.`
                : `The strategy entered but never completed a round-trip, so the ${pct(m.totalReturnPct)} return is an unrealized open position, not a closed result.`}
            </p>
            {topBlock ? (
              <p className="mt-1">
                Most entries were blocked because {blockReasonLabel(topBlock.message)} (
                {topBlock.count.toLocaleString()} times). See the &ldquo;Why it traded (or
                didn&rsquo;t)&rdquo; section below for the full breakdown.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      {m.totalTrades > 0 && holdVerdict.recommend === 'hold' && (
        <Alert variant="warning" data-testid="prefer-hold-banner">
          <AlertTitle>Holding the basket beat this strategy</AlertTitle>
          <AlertDescription>{holdVerdict.reason}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
