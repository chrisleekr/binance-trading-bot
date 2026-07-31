import type { BacktestResult, EnablementPolicy } from '@app/contracts';

import { GateScorecard } from '@/features/backtest/components/gate-scorecard';
import { InfoHint } from '@/shared/components/ui/info-hint';
import { formatMoneyAmount } from '@/shared/lib/format';
import { MetricCard } from './metric-card';
import { num, numN, pct, pctN, tone } from './results-format';

/**
 * What happened, beside whether it clears the live gate. On desktop the numbers
 * read left and the gate's pass/fail reads right; they stack on mobile. The four
 * decision-grade tiles read first, then the full metric set in full.
 */
export function ResultsMetricsSection({
  result,
  enablementPolicy,
}: {
  readonly result: BacktestResult;
  readonly enablementPolicy?: EnablementPolicy | undefined;
}): React.JSX.Element {
  const m = result.metrics;
  const profitFactorInfo =
    m.profitFactor !== null
      ? 'For every $1 the strategy lost, how many dollars did it make? Above 1 means it made money overall; below 1 means it lost.'
      : m.totalTrades > 0
        ? 'For every $1 the strategy lost, how many dollars did it make? Showing a dash because there were no losing trades yet, so it is effectively infinite.'
        : 'For every $1 the strategy lost, how many dollars did it make? Showing a dash because there are no closed trades to measure yet.';
  const noClosedTrades = m.totalTrades === 0;
  // PnL-style tiles tint by their OWN sign — the same rule the Past-runs PnL
  // column, the Fills table, and the regime/round-trip tables already use — so a
  // number never reads a different color in two places. The "did this beat
  // holding?" verdict is carried explicitly by the prefer-hold banner and the
  // (red on negative) Alpha tile, not by overloading the return's color. A
  // no-closed-trade run has no result to tint, so its tiles stay neutral.
  const signTone = (n: number | null | undefined): 'up' | 'down' | undefined =>
    noClosedTrades ? undefined : tone(n);

  return (
    <div className={enablementPolicy ? 'grid gap-4 lg:grid-cols-3' : ''}>
      <section
        aria-labelledby="bt-metrics-h"
        className={`border-border bg-bg-elevated overflow-hidden rounded-md border ${enablementPolicy ? 'lg:col-span-2' : ''}`}
      >
        <div className="border-border flex items-center gap-1 border-b px-3 py-2">
          <h2 id="bt-metrics-h" className="text-fg text-sm font-semibold">
            Results
          </h2>
          <InfoHint label="Results">
            The headline numbers from this test. Green is positive, red is negative; benchmarks are
            neutral context, not results.
          </InfoHint>
        </div>
        {/* The four decision-grade numbers, read first. */}
        <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
          <MetricCard
            prominent
            label="Total return"
            value={pct(m.totalReturnPct)}
            tone={signTone(m.totalReturnPct)}
            hint="Your actual result, after fees"
            info="Your balance change over the whole test, after fees. +10% means you would have ended with 10% more than you started. This is the bottom line."
          />
          <MetricCard
            prominent
            label="Alpha vs hold"
            value={pct(m.alphaVsHoldPct)}
            tone={signTone(m.alphaVsHoldPct)}
            hint="Return beyond holding. Negative = you lost to doing nothing"
            info="How much you beat, or lost to, simply buying the same coins and holding. Positive means the strategy added value; negative means doing nothing would have beaten it."
          />
          <MetricCard
            prominent
            label="Max drawdown"
            value={pct(m.maxDrawdownPct)}
            tone={m.maxDrawdownPct < 0 ? 'down' : undefined}
            info="The biggest drop from a high point to a later low during the test — the largest paper loss you would have had to sit through without panic-selling. Closer to 0% is calmer."
          />
          <MetricCard
            prominent
            label="Win rate"
            value={pct(m.winRate)}
            info="The share of closed trades that made money. High alone is not enough — a few big losers can still sink a high win rate."
          />
        </div>
        {/* The full metric set, shown in full — nothing folded away. */}
        <div className="border-border border-t">
          <p className="text-muted-fg border-border border-b px-3 py-2 text-xs">
            Color shows the sign: <span className="text-up">green</span> is a positive number,{' '}
            <span className="text-down">red</span> is negative. Benchmarks are neutral context.
          </p>
          <div className="bg-border grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-4">
            <MetricCard
              label="Buy & hold"
              value={pct(m.marketChangePct)}
              hint="Benchmark: if you'd just held the basket"
              info="A benchmark, not a result: what you would have made just buying the coins at the start and holding to the end."
            />
            <MetricCard
              label="Dollar-cost average"
              value={pct(m.dcaChangePct)}
              hint="Benchmark: if you'd bought a fixed slice every candle"
              info="A benchmark: what you would have made buying a fixed slice every candle instead of trading."
            />
            <MetricCard
              label="Alpha vs DCA"
              value={pct(m.alphaVsDcaPct)}
              tone={tone(m.alphaVsDcaPct)}
              hint="Return beyond steadily averaging in"
              info="How much you beat, or lost to, steadily buying a fixed amount every candle. Positive means the strategy beat that simple habit."
            />
            <MetricCard
              label="CAGR"
              value={pct(m.cagrPct)}
              tone={signTone(m.cagrPct)}
              hint="Annualized return"
              info="Your return stretched to a per-year pace, so tests of different lengths compare fairly. A 6-month +5% is a faster yearly pace than a 2-year +5%."
            />
            <MetricCard
              label="Final balance"
              value={formatMoneyAmount(m.finalBalance)}
              info="What your starting money grew or shrank to by the end of the test."
            />
            <MetricCard
              label="Sharpe (per-trade)"
              value={numN(m.sharpe)}
              hint="Per-trade, not annualized; n/a under ~10 trades"
              info="Reward for how bumpy the ride was: higher means steadier gains per trade. Measured per trade, not per year, and needs about 10+ trades to mean much."
            />
            <MetricCard
              label="Sortino (per-trade)"
              value={numN(m.sortino)}
              hint="Per-trade downside risk, not annualized; n/a with no losing trades"
              info="Like Sharpe, but it only counts downside swings, so it rewards avoiding losses. Blank when there were no losing trades to measure."
            />
            <MetricCard
              label="Calmar"
              value={num(m.calmar)}
              info="Return compared with the worst drop along the way. Higher means you earned more for the pain you would have endured."
            />
            <MetricCard
              label="SQN"
              value={numN(m.sqn)}
              info="System Quality Number — a rough grade of how consistent and repeatable the results look. Higher is steadier; needs enough trades to trust."
            />
            <MetricCard
              label="Profit factor"
              value={numN(m.profitFactor)}
              info={profitFactorInfo}
            />
            <MetricCard
              label="Closed trades"
              value={String(m.totalTrades)}
              info="How many full buy-then-sell round-trips finished during the test. More trades make the other numbers more trustworthy."
            />
            <MetricCard
              label="Best trade"
              value={pctN(m.bestTradePct)}
              tone={tone(m.bestTradePct)}
              info="The single most profitable closed trade, as a percent."
            />
            <MetricCard
              label="Worst trade"
              value={pctN(m.worstTradePct)}
              tone={tone(m.worstTradePct)}
              info="The single worst closed trade, as a percent — your deepest single-trade loss."
            />
          </div>
        </div>
      </section>
      {enablementPolicy ? (
        <GateScorecard
          metrics={m}
          outOfSample={result.outOfSample}
          dataWarnings={result.dataWarnings}
          policy={enablementPolicy}
        />
      ) : null}
    </div>
  );
}
