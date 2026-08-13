import type { BacktestResult } from '@app/contracts';

import { useMemo } from 'react';

import {
  summarizeDecisionBreakdown,
  type ReasonAttributionMap,
} from '@/features/backtest/lib/decision-breakdown';
import { InfoHint } from '@/shared/components/ui/info-hint';
import { formatMoneyAmount } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { BacktestFills } from './backtest-fills';
import { BacktestRoundTrips } from './backtest-round-trips';
import { DecisionSummaryView } from './decision-summary-view';
import {
  formatTags,
  numN,
  oosPctLabel,
  pct,
  regimeLabel,
  tone,
  toneClass,
  type ConfigShape,
} from './results-format';

/**
 * The deep tables — regime, out-of-sample, decision breakdown, fills, per-symbol
 * — all rendered in full so every detail is on the page, not behind a disclosure.
 */
export function ResultsTablesSection({
  result,
  timeZone,
  config,
  reasonAttribution,
}: {
  readonly result: BacktestResult;
  readonly timeZone: string;
  readonly config: ConfigShape;
  readonly reasonAttribution: ReasonAttributionMap;
}): React.JSX.Element {
  const decisionSummary = useMemo(
    () => summarizeDecisionBreakdown(result.decisionBreakdown, reasonAttribution),
    [result.decisionBreakdown, reasonAttribution],
  );

  return (
    <div className="space-y-6">
      {result.regimeBreakdown.length > 0 && (
        <section
          aria-labelledby="bt-regime-h"
          className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
        >
          <div className="flex items-center gap-1">
            <h2 id="bt-regime-h" className="text-sm font-semibold text-fg">
              Performance by market regime
            </h2>
            <InfoHint label="Performance by market regime">
              How the strategy did separately in rising, sideways, and falling markets. If it only
              wins while the market rises, it may just be riding the market, not adding an edge.
            </InfoHint>
          </div>
          <p className="text-xs text-muted-fg">
            How the strategy did while the market ({result.params.symbols[0]} vs its 50-day average)
            was trending up, chopping sideways, or trending down. &ldquo;Alpha vs hold&rdquo; is the
            return beyond simply holding through that regime — if the only positive alpha is in the
            uptrend row, the strategy is just holding in a rising market, not finding an edge.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums" data-testid="backtest-regime-table">
              <thead className="text-left text-xs text-muted-fg">
                <tr>
                  <th className="py-1 pr-3">Regime</th>
                  <th className="py-1 pr-3">Return</th>
                  <th className="py-1 pr-3">Buy &amp; hold</th>
                  <th className="py-1 pr-3">Alpha vs hold</th>
                  <th className="py-1 pr-3">Trades</th>
                  <th className="py-1 pr-3">Win rate</th>
                  <th className="py-1 pr-3">Profit factor</th>
                </tr>
              </thead>
              <tbody>
                {result.regimeBreakdown.map((r) => (
                  <tr key={r.regime} className="border-t border-border">
                    <td className="py-1 pr-3">{regimeLabel(r.regime)}</td>
                    <td className={`py-1 pr-3 font-mono ${toneClass(tone(r.returnPct))}`}>
                      {pct(r.returnPct)}
                    </td>
                    <td className="py-1 pr-3 font-mono">{pct(r.holdReturnPct)}</td>
                    <td className={`py-1 pr-3 font-mono ${toneClass(tone(r.alphaVsHoldPct))}`}>
                      {pct(r.alphaVsHoldPct)}
                    </td>
                    <td className="py-1 pr-3 font-mono">{r.trades}</td>
                    <td className="py-1 pr-3 font-mono">{r.trades > 0 ? pct(r.winRate) : '—'}</td>
                    <td className="py-1 pr-3 font-mono">{numN(r.profitFactor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section
        aria-labelledby="bt-oos-h"
        className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
        data-testid="backtest-oos"
      >
        <div className="flex items-center gap-1">
          <h2 id="bt-oos-h" className="text-sm font-semibold text-fg">
            Out-of-sample check
            {result.outOfSample ? ` · recent ${oosPctLabel(result.outOfSample.fraction)}` : ''}
          </h2>
          <InfoHint label="Out-of-sample check">
            The same numbers over only the most recent slice you did not tune against. A real edge
            still shows here; an over-fitted one falls apart.
          </InfoHint>
        </div>
        <p className="text-xs text-muted-fg">
          The same metrics over only the most-recent slice of the window — the part you did not tune
          against. A real edge holds up here; a curve-fit one looks strong over the full run but
          weak out-of-sample.
        </p>
        {result.outOfSample ? (
          <>
            <p className="text-xs text-muted-fg">
              Holdout window: {formatInstant(result.outOfSample.fromMs, timeZone)} →{' '}
              {formatInstant(result.outOfSample.toMs, timeZone)}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums" data-testid="backtest-oos-table">
                <thead className="text-left text-xs text-muted-fg">
                  <tr>
                    <th className="py-1 pr-3">Return</th>
                    <th className="py-1 pr-3">Buy &amp; hold</th>
                    <th className="py-1 pr-3">Alpha vs hold</th>
                    <th className="py-1 pr-3">Trades</th>
                    <th className="py-1 pr-3">Win rate</th>
                    <th className="py-1 pr-3">Profit factor</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border">
                    <td
                      className={`py-1 pr-3 font-mono ${toneClass(tone(result.outOfSample.returnPct))}`}
                    >
                      {pct(result.outOfSample.returnPct)}
                    </td>
                    <td className="py-1 pr-3 font-mono">{pct(result.outOfSample.holdReturnPct)}</td>
                    <td
                      className={`py-1 pr-3 font-mono ${toneClass(tone(result.outOfSample.alphaVsHoldPct))}`}
                    >
                      {pct(result.outOfSample.alphaVsHoldPct)}
                    </td>
                    <td className="py-1 pr-3 font-mono">{result.outOfSample.trades}</td>
                    <td className="py-1 pr-3 font-mono">
                      {result.outOfSample.trades > 0 ? pct(result.outOfSample.winRate) : '—'}
                    </td>
                    <td className="py-1 pr-3 font-mono">{numN(result.outOfSample.profitFactor)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-fg">
            This run is too short to carve a holdout — widen the backtest window to get an
            out-of-sample read.
          </p>
        )}
      </section>

      {(result.decisionBreakdown.metrics.length > 0 ||
        result.decisionBreakdown.logs.length > 0) && (
        <section
          aria-labelledby="bt-why-h"
          className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
        >
          <div className="flex items-center gap-1">
            <h2 id="bt-why-h" className="text-sm font-semibold text-fg">
              Why it traded (or didn&apos;t)
            </h2>
            <InfoHint label="Why it traded or didn't">
              A breakdown of what stopped potential trades — which gate or setting blocked them.
              Most useful when the strategy barely traded.
            </InfoHint>
          </div>
          {decisionSummary ? (
            <DecisionSummaryView
              summary={decisionSummary}
              config={config}
              attribution={reasonAttribution}
            />
          ) : (
            <p className="text-xs text-muted-fg">
              Per-tick decision counts the strategy emitted across the run — buys placed, buys
              skipped, and gate vetoes by reason. A near-zero trade count with many vetoes means the
              entry gate, not the sell/grid settings, is the dominant lever.
            </p>
          )}
          {/* The raw per-tick counters, collapsed by default — verification
              detail beneath the plain-language summary, not primary reading. */}
          <details className="group space-y-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-fg hover:text-fg">
              Show raw per-tick counts
            </summary>
            {result.decisionBreakdown.metrics.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-left text-xs text-muted-fg">
                    <tr>
                      <th className="py-1 pr-3">Outcome</th>
                      <th className="py-1 pr-3">Detail</th>
                      <th className="py-1 pr-3">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.decisionBreakdown.metrics.map((m, i) => (
                      <tr key={`why-m-${m.name}-${i}`} className="border-t border-border">
                        <td className="py-1 pr-3">{m.name}</td>
                        <td className="py-1 pr-3 text-muted-fg">{formatTags(m.tags)}</td>
                        <td className="py-1 pr-3 font-mono">{m.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.decisionBreakdown.logs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-left text-xs text-muted-fg">
                    <tr>
                      <th className="py-1 pr-3">Event</th>
                      <th className="py-1 pr-3">Reason</th>
                      <th className="py-1 pr-3">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.decisionBreakdown.logs.map((l, i) => (
                      <tr key={`why-l-${l.message}-${i}`} className="border-t border-border">
                        <td className="py-1 pr-3">{l.message}</td>
                        <td className="py-1 pr-3">{l.reason ?? '—'}</td>
                        <td className="py-1 pr-3 font-mono">{l.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </section>
      )}

      <BacktestRoundTrips roundTrips={result.roundTrips} timeZone={timeZone} />

      <BacktestFills trades={result.trades} timeZone={timeZone} />

      {result.perSymbol.length > 1 && (
        <section
          aria-labelledby="bt-persymbol-h"
          className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
        >
          <h2 id="bt-persymbol-h" className="text-sm font-semibold text-fg">
            Per symbol
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-muted-fg">
                <tr>
                  <th className="py-1 pr-3">Symbol</th>
                  <th className="py-1 pr-3">Trades</th>
                  <th className="py-1 pr-3">PnL (quote)</th>
                </tr>
              </thead>
              <tbody>
                {result.perSymbol.map((s) => (
                  <tr key={s.symbol} className="border-t border-border">
                    <td className="py-1 pr-3">{s.symbol}</td>
                    <td className="py-1 pr-3 font-mono">{s.tradeCount}</td>
                    <td className="py-1 pr-3 font-mono">{formatMoneyAmount(s.pnlQuote)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
