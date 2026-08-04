import { useCallback, useEffect, useRef, useState } from 'react';

import type { CandleList } from '@app/contracts';

/** Tone of a chart price line; maps to a colour + dotted/solid style below. */
export type ChartLineTone = 'entry' | 'buy' | 'sell' | 'stop';

/**
 * One horizontal price line the chart paints. `price` is a decimal-string
 * coerced to number at the rendering boundary; `label` is the axis tag; `tone`
 * selects the colour and dotted/solid style.
 */
export interface ChartPriceLine {
  readonly price: string;
  readonly label: string;
  readonly tone: ChartLineTone;
}

/**
 * Overlay anchors the chart paints. Every field is optional so a fresh symbol
 * (no buy yet) renders just the bars. `priceLines` are horizontal reference
 * levels (entry, sell arm, trailing, stop, next buy); the marker arrays pin
 * timed buy/sell/stop dots onto bars.
 */
export interface ChartOverlays {
  readonly priceLines?: readonly ChartPriceLine[];
  readonly buyMarkers?: readonly { time: string; price: string }[];
  readonly sellMarkers?: readonly { time: string; price: string }[];
  readonly stopLossMarkers?: readonly { time: string; price: string }[];
}

/** One OHLC bar — the shape lightweight-charts hands back on a crosshair move. */
export interface OhlcPoint {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** Crosshair-move payload: `seriesData` maps each series to its bar at the cursor. */
interface CrosshairMoveParam {
  readonly seriesData: ReadonlyMap<unknown, unknown>;
}

/**
 * Subset of a lightweight-charts series the chart drives imperatively.
 * `createPriceLine` returns an opaque handle that `removePriceLine` later
 * clears, so an overlay refresh removes individual lines instead of
 * rebuilding the whole series.
 */
export interface ChartSeries {
  setData: (data: unknown[]) => void;
  applyOptions: (options: unknown) => void;
  createPriceLine: (line: unknown) => unknown;
  removePriceLine: (line: unknown) => void;
}

/** Subset of the markers plugin: `setMarkers` swaps the full marker set. */
export interface ChartSeriesMarkers {
  setMarkers: (markers: unknown[]) => void;
}

/**
 * Subset of `lightweight-charts` the chart actually needs. Declared
 * structurally so the test can supply a stub via `loadModule` without
 * importing the real module's types (and without the canvas DOM the real
 * module requires).
 */
export interface ChartModule {
  readonly createChart: (
    container: HTMLElement,
    options?: unknown,
  ) => {
    addSeries: (kind: unknown, options?: unknown) => ChartSeries;
    subscribeCrosshairMove: (handler: (param: CrosshairMoveParam) => void) => void;
    remove: () => void;
  };
  readonly CandlestickSeries: unknown;
  readonly createSeriesMarkers: (series: unknown, markers?: unknown[]) => ChartSeriesMarkers;
}

const defaultLoadModule = (): Promise<ChartModule> =>
  import('lightweight-charts') as unknown as Promise<ChartModule>;

let activeLoader: () => Promise<ChartModule> = defaultLoadModule;

/**
 * Test seam. The route renders `SymbolCandleChart` deep inside the router
 * tree, so we can't pipe `loadModule` through the JSX from a test; this
 * setter swaps the default in for a stub for the duration of the test.
 */
export const __setChartLoader = (loader: () => Promise<ChartModule>): void => {
  activeLoader = loader;
};

/** Test seam. Restores the real dynamic-import loader. */
export const __resetChartLoader = (): void => {
  activeLoader = defaultLoadModule;
};

export interface SymbolCandleChartProps {
  readonly candles: CandleList;
  readonly overlays: ChartOverlays;
  readonly height?: number;
  /**
   * Authoritative tick size from Binance's PRICE_FILTER. When supplied the
   * chart pins Y-axis precision to it; absent, precision is derived from
   * the visible window (correct for any symbol active in the last 240 bars
   * but under-renders for low-volume pairs whose recent ticks don't
   * exercise the full PRICE_FILTER).
   */
  readonly filterTickSize?: string | null;
  /**
   * Module loader. Defaults to a dynamic `import('lightweight-charts')` so
   * the chart bundle stays out of the per-route critical path; tests inject
   * a synchronous stub so happy-dom's missing canvas can't blow up the run.
   */
  readonly loadModule?: () => Promise<ChartModule>;
}

// Chart paints onto a <canvas>, which can't resolve CSS var(); these literals
// mirror the app.css [data-theme='dark'] tokens exactly so the chart's colours
// stay aligned with the design system. Entry tracks --accent (the value-commit
// amber), stop tracks --warning (caution orange).
const CHART_COLORS = {
  up: '#00e070', // --up
  down: '#ff6257', // --down
  mutedFg: '#9a9aa0', // --muted-fg
  border: '#2a2a2a', // --border
  entry: '#ffcc00', // --accent — average-entry-price line
  stop: '#ff8c00', // --warning — stop-loss line/marker
} as const;

// Colour + dotted/solid style per line tone. Dotted for the dynamic ladder
// rungs (buy/sell), solid for the fixed reference levels (entry/stop).
const LINE_STYLE: Record<ChartLineTone, { readonly color: string; readonly dotted: boolean }> = {
  entry: { color: CHART_COLORS.entry, dotted: false },
  buy: { color: CHART_COLORS.up, dotted: true },
  sell: { color: CHART_COLORS.down, dotted: true },
  stop: { color: CHART_COLORS.stop, dotted: false },
};

const TIME_PRECISION_THRESHOLD = 1e10;

const isoToTime = (iso: string): number => {
  const ms = new Date(iso).getTime();
  return ms > TIME_PRECISION_THRESHOLD ? Math.floor(ms / 1000) : ms;
};

/**
 * Counts decimal places in a decimal-string close price. Used as a fallback
 * when the authoritative `filterTickSize` from exchangeInfo is unavailable
 * (the symbol hasn't been fetched yet, or Binance dropped its PRICE_FILTER).
 */
const countDecimals = (s: string | null | undefined): number => {
  if (!s) return 2;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
};

const derivePrecision = (candles: CandleList): { precision: number; minMove: number } => {
  let max = 2;
  for (const c of candles) {
    const d = countDecimals(c.close);
    if (d > max) max = d;
  }
  return { precision: max, minMove: 1 / 10 ** max };
};

/**
 * Resolves chart precision from `filterTickSize` (decimal-string from
 * Binance's PRICE_FILTER) when supplied; falls back to deriving from the
 * visible window. Precision is the digit count after the decimal point;
 * `minMove` is `Number(filterTickSize)` because lightweight-charts uses
 * that to render axis ticks at the right granularity.
 */
/**
 * Decimal places in a tickSize, ignoring trailing zeros — `0.01000000` is
 * really 2 decimals of precision, not 8. Counting padding would over-render
 * the Y-axis with meaningless trailing digits.
 */
const tickSizePrecision = (s: string): number => {
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  let end = s.length;
  while (end > dot + 1 && s[end - 1] === '0') end -= 1;
  return Math.max(0, end - dot - 1);
};

export const resolvePrecision = (
  filterTickSize: string | null | undefined,
  candles: CandleList,
): { precision: number; minMove: number } => {
  if (filterTickSize) {
    const minMove = Number(filterTickSize);
    if (Number.isFinite(minMove) && minMove > 0) {
      return { precision: tickSizePrecision(filterTickSize), minMove };
    }
  }
  return derivePrecision(candles);
};

/** Format a chart price for the OHLC legend: fixed precision, thousands grouped. */
export const formatChartPrice = (value: number, precision: number): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });

/**
 * Narrow a `seriesData` value to an {@link OhlcPoint}. Checks that all four
 * fields are numbers, not just present — a line series carries `value`, and
 * a malformed bar must not slip through to `formatChartPrice`.
 */
export const isOhlcPoint = (v: unknown): v is OhlcPoint => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['open'] === 'number' &&
    typeof r['high'] === 'number' &&
    typeof r['low'] === 'number' &&
    typeof r['close'] === 'number'
  );
};

/** The latest candle's OHLC, or null for an empty window. */
export const latestOhlc = (candles: CandleList): OhlcPoint | null => {
  const c = candles.at(-1);
  return c
    ? { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }
    : null;
};

/** Map a contract candle to the bar shape lightweight-charts' `setData` wants. */
const toChartBar = (
  c: CandleList[number],
): { time: number; open: number; high: number; low: number; close: number } => ({
  time: isoToTime(c.time),
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
});

/**
 * Per-symbol candle chart. The lightweight-charts module is dynamic-imported
 * inside `useEffect` so the chart bundle (≈200kB gz) loads only when an
 * operator opens this route, not as part of the per-route critical path.
 */
export function SymbolCandleChart({
  candles,
  overlays,
  height = 280,
  filterTickSize,
  loadModule,
}: SymbolCandleChartProps): React.JSX.Element {
  const effectiveLoader = loadModule ?? activeLoader;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OHLC legend: the hovered bar under the crosshair, falling back to the
  // latest candle when the cursor is off the chart — Binance-style.
  const [legend, setLegend] = useState<OhlcPoint | null>(null);
  // The crosshair fires per mouse-move; dedupe so we only re-render when the
  // hovered bar actually changes (the same bar object recurs within one bar).
  const legendRef = useRef<OhlcPoint | null>(null);
  const { precision, minMove } = resolvePrecision(filterTickSize, candles);

  // Imperative chart handles held across renders. The candle canvas is
  // expensive and changes rarely; overlays (price lines, markers) are cheap
  // and change many times a second during a fill cascade. Holding the series
  // in a ref lets the overlay effect mutate lines/markers in place rather
  // than tearing down and rebuilding the whole chart on every overlay refetch.
  const seriesRef = useRef<ChartSeries | null>(null);
  const priceLinesRef = useRef<unknown[]>([]);
  const markersRef = useRef<ChartSeriesMarkers | null>(null);
  // Latest overlays, read by the async create effect so it paints the first
  // overlay set the moment the series exists — the overlay effect may already
  // have run and skipped while the module was still loading.
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  // Candle window and axis precision read by the create effect from refs so it
  // depends on neither — a new window (every interval boundary) and a precision
  // change (exchangeInfo resolving) update the series in place, never rebuild.
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const priceFormatRef = useRef({ precision, minMove });
  priceFormatRef.current = { precision, minMove };
  // Crosshair fallback (latest bar) kept fresh in a ref: the chart no longer
  // rebuilds on a candle change, so the crosshair handler can't close over a
  // stale `latestOhlc`. `offChart` tracks whether the cursor is off the bars,
  // so the data effect only retargets the legend to the latest bar when the
  // operator isn't hovering one.
  const fallbackRef = useRef<OhlcPoint | null>(null);
  const offChartRef = useRef(true);

  // Repaint price lines + markers from an overlay set onto an existing series.
  // Clears the previously-created lines first so a changed overlay set never
  // leaks duplicate lines; setMarkers always runs (even empty) to drop stale
  // markers. Never touches the chart canvas.
  const applyOverlays = useCallback((series: ChartSeries, ov: ChartOverlays): void => {
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    for (const l of ov.priceLines ?? []) {
      const n = Number(l.price);
      if (!Number.isFinite(n)) continue;
      const style = LINE_STYLE[l.tone];
      priceLinesRef.current.push(
        series.createPriceLine({
          price: n,
          color: style.color,
          lineWidth: 1,
          lineStyle: style.dotted ? 1 : 0,
          axisLabelVisible: true,
          title: l.label,
        }),
      );
    }

    const markers: {
      time: number;
      position: 'belowBar' | 'aboveBar' | 'inBar';
      color: string;
      shape: 'arrowUp' | 'arrowDown' | 'circle';
      text: string;
    }[] = [];
    const pushMarker = (
      arr: readonly { time: string; price: string }[] | undefined,
      color: string,
      shape: 'arrowUp' | 'arrowDown' | 'circle',
      position: 'belowBar' | 'aboveBar' | 'inBar',
      text: string,
    ): void => {
      for (const m of arr ?? []) {
        markers.push({ time: isoToTime(m.time), position, color, shape, text });
      }
    };
    pushMarker(ov.buyMarkers, CHART_COLORS.up, 'arrowUp', 'belowBar', 'BUY');
    pushMarker(ov.sellMarkers, CHART_COLORS.down, 'arrowDown', 'aboveBar', 'SELL');
    pushMarker(ov.stopLossMarkers, CHART_COLORS.stop, 'circle', 'inBar', 'SL');
    // lightweight-charts requires markers in ascending time order; the three
    // overlay arrays are pushed by type, so the merged set must be re-sorted.
    markers.sort((a, b) => a.time - b.time);
    markersRef.current?.setMarkers(markers);
  }, []);

  // Effect A — create the chart + candle series ONCE. Candle data, precision,
  // and overlays are read from refs so this effect depends on none of them; the
  // effects below mutate the series in place. Only a height / loader change
  // (neither happens after mount) tears the canvas down and rebuilds. This is
  // what stops the per-interval flicker — a new candle window no longer
  // destroys the chart.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    effectiveLoader()
      .then((mod) => {
        if (cancelled || !container) return;
        const chart = mod.createChart(container, {
          height,
          autoSize: true,
          layout: { textColor: CHART_COLORS.mutedFg, background: { color: 'transparent' } },
          grid: {
            vertLines: { color: CHART_COLORS.border },
            horzLines: { color: CHART_COLORS.border },
          },
          // The canvas sits inside the page scroller, and lightweight-charts
          // defaults these to on: it then consumes vertical drags and wheel
          // ticks that were meant to scroll the page. On a phone the canvas is a
          // large target, so the page simply stops scrolling wherever a thumb
          // lands on it. Both mouseWheel flags have to go, not just the scale
          // one: the wheel handler only bails early when BOTH axes are opted
          // out, so a trackpad's incidental horizontal delta still reached
          // preventDefault. With both off no wheel listener is attached at all.
          // Drag-to-pan and pinch zoom stay on.
          handleScroll: { vertTouchDrag: false, mouseWheel: false },
          handleScale: { mouseWheel: false },
        });
        const fmt = priceFormatRef.current;
        const series = chart.addSeries(mod.CandlestickSeries, {
          upColor: CHART_COLORS.up,
          downColor: CHART_COLORS.down,
          borderVisible: false,
          wickUpColor: CHART_COLORS.up,
          wickDownColor: CHART_COLORS.down,
          priceFormat: { type: 'price', precision: fmt.precision, minMove: fmt.minMove },
        });
        series.setData(candlesRef.current.map(toChartBar));

        // The legend tracks the bar under the crosshair; off-chart it shows
        // the latest candle, so the readout is never blank.
        const fallback = latestOhlc(candlesRef.current);
        fallbackRef.current = fallback;
        legendRef.current = fallback;
        setLegend(fallback);
        chart.subscribeCrosshairMove((param) => {
          const point = param.seriesData.get(series);
          const onBar = isOhlcPoint(point);
          offChartRef.current = !onBar;
          const next = onBar ? point : fallbackRef.current;
          if (next === legendRef.current) return;
          legendRef.current = next;
          setLegend(next);
        });

        seriesRef.current = series;
        markersRef.current = mod.createSeriesMarkers(series, []);
        priceLinesRef.current = [];
        // Paint the current overlays now that the series exists.
        applyOverlays(series, overlaysRef.current);

        cleanup = () => {
          chart.remove();
          seriesRef.current = null;
          markersRef.current = null;
          priceLinesRef.current = [];
        };
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'chart failed to load');
      });

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [height, effectiveLoader, applyOverlays]);

  // Effect — candle data. Pushes the new window onto the existing series in
  // place (no canvas rebuild). Skips on first mount (Effect A paints the first
  // window). When the cursor is off-chart the legend follows the latest bar;
  // while hovering a bar it is left untouched.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(candles.map(toChartBar));
    const latest = latestOhlc(candles);
    fallbackRef.current = latest;
    if (offChartRef.current) {
      legendRef.current = latest;
      setLegend(latest);
    }
  }, [candles]);

  // Effect — axis precision. Repoints the price format in place when the
  // authoritative tickSize resolves (exchangeInfo loads after the first paint),
  // instead of rebuilding the chart. No-op until the series exists.
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
  }, [precision, minMove]);

  // Effect B — overlays only. Mutates the existing series' price lines and
  // markers; never rebuilds the chart. Skips when the series isn't ready yet
  // (Effect A paints the first overlay set on create).
  useEffect(() => {
    const series = seriesRef.current;
    if (series) applyOverlays(series, overlays);
  }, [overlays, applyOverlays]);

  return (
    <section
      aria-label="Candle chart"
      data-testid="symbol-candle-chart"
      className="border-border bg-bg-elevated relative rounded-md border"
    >
      {legend ? (
        <div
          aria-hidden
          data-testid="chart-ohlc-legend"
          className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap gap-x-3 font-mono text-xs tabular-nums"
        >
          {(
            [
              ['O', legend.open],
              ['H', legend.high],
              ['L', legend.low],
              ['C', legend.close],
            ] as const
          ).map(([label, value]) => (
            <span key={label}>
              <span className="text-muted-fg">{label}</span>{' '}
              <span className={legend.close >= legend.open ? 'text-success' : 'text-danger'}>
                {formatChartPrice(value, precision)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      <div
        ref={containerRef}
        data-testid="symbol-candle-chart-canvas"
        // Shorter on mobile so the chart doesn't crowd the 375x667 viewport;
        // the passed height applies from sm up. autoSize tracks the container.
        style={{ '--chart-h': `${height}px` } as React.CSSProperties}
        className="h-[300px] w-full sm:h-[var(--chart-h)]"
      />
      {error ? (
        <p role="alert" className="text-danger px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
