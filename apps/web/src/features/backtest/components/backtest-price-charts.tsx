import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  BACKTEST_INTERVALS,
  type BacktestInterval,
  type BacktestResult,
  type CandleList,
} from '@app/contracts';

import { cn } from '@/shared/lib/cn';
import { BlockSkeleton } from '@/shared/components/page-skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import {
  SymbolCandleChart,
  type ChartModule,
  type ChartOverlays,
} from '@/features/symbol/components/symbol-candle-chart';
import { backtestCandlesQueryKey, fetchBacktestCandles } from '@/features/backtest/api/backtest';

// The candles endpoint serves at most 1000 klines per call (Binance's limit,
// mirrored in the API candles route). A run longer than that at the chosen
// interval shows only its first 1000 candles; every trade still appears in the
// table. The default interval is picked so the whole run fits this budget.
const KLINE_PAGE_CAP = 1000;
export const CHART_HEIGHT = 320;
/**
 * The pending placeholder's sm-and-up height. A source-text literal because
 * Tailwind's JIT cannot see a computed class name; exported so a test can pin
 * it against {@link CHART_HEIGHT} and catch a drift the compiler cannot.
 */
export const CHART_SM_HEIGHT_CLASS = 'sm:h-[320px]';

/** Milliseconds per bar for a backtest interval (units are m/h/d/w only). */
function intervalToMs(interval: BacktestInterval): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const unitMs =
    unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
  return n * unitMs;
}

/**
 * Default chart interval: the finest interval no finer than the simulated one
 * whose bar count over the run window fits a single 1000-kline fetch, so the
 * first view shows the whole run with every trade marker. The operator can pick
 * a finer interval to zoom in (loading the run's first 1000 of those bars).
 */
function fitChartInterval(
  fromMs: number,
  toMs: number,
  strategyInterval: BacktestInterval,
): BacktestInterval {
  const span = Math.max(0, toMs - fromMs);
  const floor = Math.max(0, BACKTEST_INTERVALS.indexOf(strategyInterval));
  for (let r = floor; r < BACKTEST_INTERVALS.length; r++) {
    const iv = BACKTEST_INTERVALS[r] as BacktestInterval;
    if (span / intervalToMs(iv) <= KLINE_PAGE_CAP) return iv;
  }
  return BACKTEST_INTERVALS[BACKTEST_INTERVALS.length - 1] as BacktestInterval;
}

export interface BacktestPriceChartsProps {
  readonly result: BacktestResult;
  readonly profileId: string;
  /** Test seam forwarded to the candle chart (defaults to the real loader). */
  readonly loadModule?: () => Promise<ChartModule>;
}

/**
 * Map a symbol's trades onto the chart's marker overlays — BUY below the bar,
 * SELL above, stop-loss as an in-bar dot. Markers outside the loaded candle
 * window are dropped so a truncated chart never floats a marker past its last
 * bar (those trades remain in the table).
 */
function buildOverlays(trades: BacktestResult['trades'], candles: CandleList): ChartOverlays {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return {};
  // Candle `.time` is the bar OPEN; a trade's `tsMs` is the bar CLOSE
  // (open + interval - 1). The upper bound is the last bar's open plus one bar
  // span (derived from the data, so it is correct for any interval — the symbol
  // feature's interval→ms map covers only a subset), which clears the close
  // stamp. With a single candle there is no derivable span, so keep every trade
  // from the first open on (they all snap to the one bar) rather than drop the
  // bar's own close-stamped trade.
  const second = candles[1];
  const lo = Date.parse(first.time);
  const hi = second
    ? Date.parse(last.time) + (Date.parse(second.time) - Date.parse(first.time))
    : Number.POSITIVE_INFINITY;

  const buyMarkers: { time: string; price: string }[] = [];
  const sellMarkers: { time: string; price: string }[] = [];
  const stopLossMarkers: { time: string; price: string }[] = [];
  for (const t of trades) {
    if (t.tsMs < lo || t.tsMs > hi) continue;
    const marker = { time: new Date(t.tsMs).toISOString(), price: t.price };
    if (t.side === 'BUY') buyMarkers.push(marker);
    else if (t.reason === 'grid-stop-loss') stopLossMarkers.push(marker);
    else sellMarkers.push(marker);
  }
  return { buyMarkers, sellMarkers, stopLossMarkers };
}

interface SymbolPriceChartProps {
  readonly result: BacktestResult;
  readonly profileId: string;
  readonly symbol: string;
  readonly loadModule?: () => Promise<ChartModule>;
}

function SymbolPriceChart({
  result,
  profileId,
  symbol,
  loadModule,
}: SymbolPriceChartProps): React.JSX.Element {
  const { fromMs, toMs, strategyInterval } = result.params;
  // Default to the interval that fits the whole run; the operator overrides it
  // with the picker to zoom in/out. Keyed remount (see BacktestPriceCharts)
  // reseeds this when a different run loads.
  const [interval, setInterval] = useState<BacktestInterval>(() =>
    fitChartInterval(fromMs, toMs, strategyInterval),
  );
  const candles = useQuery({
    queryKey: backtestCandlesQueryKey(profileId, symbol, interval, fromMs, toMs),
    queryFn: () => fetchBacktestCandles(profileId, symbol, interval, fromMs, toMs),
    staleTime: Infinity, // historical klines never change
  });

  const data = candles.data ?? [];
  const symbolTrades = useMemo(
    () => result.trades.filter((t) => t.symbol === symbol),
    [result.trades, symbol],
  );
  const overlays = useMemo(() => buildOverlays(symbolTrades, data), [symbolTrades, data]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Candle interval">
        <span className="mr-1 text-xs text-muted-fg">Interval</span>
        {BACKTEST_INTERVALS.map((iv) => (
          <button
            key={iv}
            type="button"
            onClick={() => setInterval(iv)}
            aria-pressed={iv === interval}
            className={cn(
              'rounded-xs border px-2 py-1 text-xs tabular-nums',
              iv === interval
                ? 'border-primary bg-surface-alt text-fg'
                : 'border-border text-muted-fg hover:text-fg',
            )}
          >
            {iv}
          </button>
        ))}
      </div>
      {candles.isPending ? (
        // Mirrors SymbolCandleChart's own responsive height: it renders
        // `h-[300px] w-full sm:h-[var(--chart-h)]`, so CHART_HEIGHT applies
        // only from sm up and the mobile box is 300px.
        //
        // Literal, not an interpolation of CHART_HEIGHT: Tailwind's JIT scans
        // source text, so a computed class name compiles to nothing and the
        // placeholder would silently have no height at all. CHART_SM_HEIGHT_CLASS
        // is asserted against CHART_HEIGHT in the tests so the two cannot drift.
        <BlockSkeleton className={`h-[300px] w-full rounded-md ${CHART_SM_HEIGHT_CLASS}`} />
      ) : candles.isError ? (
        <p className="text-sm text-danger">Could not load candles for {symbol}.</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-fg">No candles for this range.</p>
      ) : (
        <>
          <SymbolCandleChart
            candles={data}
            overlays={overlays}
            height={CHART_HEIGHT}
            {...(loadModule ? { loadModule } : {})}
          />
          {data.length >= KLINE_PAGE_CAP && (
            <p className="text-xs text-muted-fg">
              Showing the first {KLINE_PAGE_CAP} {interval} candles from the run start. Pick a
              coarser interval to see the whole run; every trade is also in the fills table.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Per-symbol price candlestick chart for a finished run, with the run's trades
 * overlaid as buy/sell/stop-loss markers. One chart for a single-symbol run; a
 * tab per symbol otherwise.
 */
export function BacktestPriceCharts({
  result,
  profileId,
  loadModule,
}: BacktestPriceChartsProps): React.JSX.Element | null {
  const symbols = result.params.symbols;
  const firstSymbol = symbols[0];
  if (!firstSymbol) return null;
  // Reseed the per-chart interval state when a different run loads (same symbol,
  // new window): the picker default is derived from the run window.
  const runKey = `${result.params.fromMs}-${result.params.toMs}`;

  return (
    <section
      aria-labelledby="bt-price-h"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
    >
      <h2 id="bt-price-h" className="text-sm font-semibold text-fg">
        Price &amp; trades
      </h2>
      {symbols.length === 1 ? (
        <SymbolPriceChart
          key={`${firstSymbol}-${runKey}`}
          result={result}
          profileId={profileId}
          symbol={firstSymbol}
          {...(loadModule ? { loadModule } : {})}
        />
      ) : (
        <Tabs defaultValue={firstSymbol}>
          <TabsList className="flex-wrap">
            {symbols.map((s) => (
              <TabsTrigger key={s} value={s}>
                {s}
              </TabsTrigger>
            ))}
          </TabsList>
          {symbols.map((s) => (
            <TabsContent key={s} value={s}>
              <SymbolPriceChart
                key={`${s}-${runKey}`}
                result={result}
                profileId={profileId}
                symbol={s}
                {...(loadModule ? { loadModule } : {})}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </section>
  );
}
