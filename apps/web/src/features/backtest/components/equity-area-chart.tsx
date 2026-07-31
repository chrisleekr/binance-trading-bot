import { useEffect, useRef, useState } from 'react';

/** A point on a value-over-time series. */
export interface SeriesPoint {
  readonly tsMs: number;
  readonly value: number;
}

/**
 * Minimal structural subset of `lightweight-charts` this chart needs —
 * declared so a test can inject a stub via `loadModule` without the real
 * module's canvas. Mirrors the SymbolCandleChart seam.
 */
export interface AreaChartModule {
  readonly createChart: (
    container: HTMLElement,
    options?: unknown,
  ) => {
    addSeries: (kind: unknown, options?: unknown) => { setData: (data: unknown[]) => void };
    timeScale: () => { fitContent: () => void };
    remove: () => void;
  };
  readonly AreaSeries: unknown;
}

// Dark-theme layout so these curves match the candle chart instead of
// lightweight-charts' default white canvas. Mirrors SymbolCandleChart's
// CHART_COLORS (transparent so the card's own --bg-elevated shows through).
const CHART_LAYOUT = {
  layout: { textColor: '#9a9aa0', background: { color: 'transparent' } }, // --muted-fg
  grid: { vertLines: { color: '#2a2a2a' }, horzLines: { color: '#2a2a2a' } }, // --border
} as const;

const defaultLoad = (): Promise<AreaChartModule> =>
  import('lightweight-charts') as unknown as Promise<AreaChartModule>;

let activeLoader: () => Promise<AreaChartModule> = defaultLoad;

/**
 * Test seam. The backtest route renders these charts deep in the router tree,
 * so a test can't pipe `loadModule` through the JSX; this setter swaps the
 * default loader for a stub for the duration of the test, keeping happy-dom's
 * missing canvas (and lightweight-charts' color parsing) out of the run.
 * Mirrors `symbol-candle-chart`'s `__setChartLoader`.
 */
export const __setAreaChartLoader = (loader: () => Promise<AreaChartModule>): void => {
  activeLoader = loader;
};

/** Test seam. Restores the real dynamic-import loader. */
export const __resetAreaChartLoader = (): void => {
  activeLoader = defaultLoad;
};

export interface EquityAreaChartProps {
  readonly points: readonly SeriesPoint[];
  readonly height?: number;
  readonly lineColor?: string;
  readonly topColor?: string;
  readonly bottomColor?: string;
  /** Test seam: inject a stub lightweight-charts module. */
  readonly loadModule?: (() => Promise<AreaChartModule>) | undefined;
  readonly ariaLabel?: string | undefined;
}

/**
 * Area chart for an equity or drawdown series. Uses lightweight-charts (the
 * project's financial chart lib) rather than Recharts for these
 * non-financial-but-time-series curves — a deliberate choice to avoid a
 * second charting dependency, reusing the candle chart's dynamic-import seam
 * (the ~200kB bundle loads only when a result is viewed). Times are seconds
 * (UTCTimestamp); points sharing a second collapse to the last — a defensive
 * guard for lightweight-charts' ascending-unique contract, not an expected
 * path (backtest points are candle-spaced, >= 1 minute apart).
 */
export function EquityAreaChart({
  points,
  height = 220,
  lineColor = '#00e070', // --primary
  topColor = 'rgba(0,224,112,0.25)',
  bottomColor = 'rgba(0,224,112,0.02)',
  loadModule,
  ariaLabel,
}: EquityAreaChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = loadModule ?? activeLoader;

  useEffect(() => {
    let chart: { remove: () => void } | null = null;
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    void load()
      .then((mod) => {
        if (cancelled || !container) return;
        const c = mod.createChart(container, { height, autoSize: true, ...CHART_LAYOUT });
        chart = c;
        const series = c.addSeries(mod.AreaSeries, { lineColor, topColor, bottomColor });
        // Collapse to ascending-unique seconds (lightweight-charts rejects
        // duplicate/unordered times).
        const byTime = new Map<number, number>();
        for (const p of points) byTime.set(Math.floor(p.tsMs / 1000), p.value);
        const data = [...byTime.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time, value }));
        series.setData(data);
        c.timeScale().fitContent();
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'chart failed to load');
      });

    return () => {
      cancelled = true;
      if (chart) chart.remove();
    };
  }, [points, height, lineColor, topColor, bottomColor, load]);

  if (error) {
    return <p className="text-danger text-sm">{error}</p>;
  }
  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ height }}
      aria-label={ariaLabel}
      role="img"
    />
  );
}
