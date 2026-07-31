// SymbolTechnicalsPanel — the symbol-page Technicals technical-analysis
// panel, polled every 15s from the per-profile endpoint. Renders one
// section per operator-configured interval: three verdict gauges
// (Summary / Oscillators / Moving Averages) plus the oscillator and
// moving-average indicator tables, mirroring Technicals's own TA widget.
// The Summary verdict per interval is what the strategy buy gate ANDs
// across; the rest is operator context.
//
// Multi-interval display: when more than one interval is configured the
// panel shows a small tab strip so the operator can inspect each one. A
// single-interval profile collapses to the same compact one-section
// layout the panel had pre-multi-interval.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from '@tanstack/react-router';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { cn } from '@/shared/lib/cn';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { TechnicalsHealthPill as SharedTechnicalsHealthPill } from '@/features/technicals/components/technicals-health-pill';
import {
  fetchTechnicalsHealth,
  fetchTechnicalsRecommendations,
  technicalsHealthQueryKey,
  technicalsRecommendationsQueryKey,
} from '@/features/technicals/api/technicals';
import { friendlyErrorLabel } from '@/features/technicals/lib/friendly-error-label';
import { useNearExpiryTick } from '@/features/symbol/components/use-near-expiry-tick';
import { useRefreshAnnouncement } from '@/features/symbol/components/use-refresh-announcement';
import { humaniseAge } from '@/shared/lib/format-time';
import {
  evaluateBuyGateForInterval,
  evaluateForceSellForInterval,
  type BuyGateStatus,
  type ForceSellStatus,
} from '@/features/symbol/lib/technicals-gate-display';
import {
  RECOMMENDATION_LABEL,
  RECOMMENDATION_TONE,
  RECOMMENDATION_VARIANT,
} from '@/shared/lib/technicals-format';

import type {
  TechnicalsFetchStatus,
  TechnicalsIntervalConfig,
  TechnicalsMovingAverages,
  TechnicalsOscillators,
  TechnicalsRecommendation,
  TechnicalsSignal,
} from '@app/contracts';

/** 15s poll cadence — matches the worker's Technicals fetch interval. */
export const TV_POLL_MS = 15_000;

/** 30s poll cadence for the health endpoint; mirrors `TechnicalsHealthPill`. */
export const TV_HEALTH_POLL_MS = 30_000;

/**
 * Fallback freshness window when the recommendations endpoint has not yet
 * returned a response. Matches the built-in default the worker would apply for
 * a profile whose config omits the `technicals` block; once the first
 * poll lands the panel uses `recs.data.technicals.useOnlyWithinMin`
 * instead, so the staleness pill always reflects the operator's actual
 * gate threshold.
 */
export const DEFAULT_FRESHNESS_MIN = 2;

/**
 * Compact verdict code for the multi-interval overview strip. Trades the
 * full word for two-letter density so the operator can scan a row of
 * `{interval}: {code}` chips at a glance: SB (strong buy) / B / N / S /
 * SS (strong sell). Matches the tier ordering in `RECOMMENDATION_VARIANT`
 * (`@/shared/lib/technicals-format`); screen readers get the verbose
 * `RECOMMENDATION_LABEL` form from that module via `aria-label`.
 */
const SHORT_LABEL_FOR: Record<TechnicalsRecommendation, string> = {
  STRONG_BUY: 'SB',
  BUY: 'B',
  NEUTRAL: 'N',
  SELL: 'S',
  STRONG_SELL: 'SS',
};

// Each tuple is [field, label, gloss]. The gloss is a plain-language one-liner
// rendered inline beneath each indicator name so a non-finance operator learns
// what it means without hovering (mobile included).
const EMA_SMA_GLOSS =
  'Average price over recent bars; EMA weights recent bars more. Price above it = uptrend bias.';

/** Oscillator field → display label + gloss, in Technicals's table order. */
const OSCILLATOR_LABELS: readonly (readonly [keyof TechnicalsOscillators, string, string])[] = [
  [
    'rsi',
    'RSI (14)',
    'Relative Strength Index: 0–100 momentum gauge; above ~70 overbought, below ~30 oversold.',
  ],
  ['stochK', 'Stoch %K', 'Stochastic oscillator: where price sits in its recent range, 0–100.'],
  ['stochD', 'Stoch %D', 'Stochastic oscillator: where price sits in its recent range, 0–100.'],
  [
    'cci20',
    'CCI (20)',
    'Commodity Channel Index: how far price has strayed from its recent average.',
  ],
  [
    'adx',
    'ADX (14)',
    'Average Directional Index: how strong the trend is, regardless of direction.',
  ],
  [
    'adxPlusDi',
    '+DI',
    'Directional indicators: +DI up-pressure, −DI down-pressure; the larger points the way.',
  ],
  [
    'adxMinusDi',
    '−DI',
    'Directional indicators: +DI up-pressure, −DI down-pressure; the larger points the way.',
  ],
  ['ao', 'Awesome Osc', 'Awesome Oscillator: compares recent vs longer-term momentum.'],
  ['mom', 'Momentum (10)', 'Momentum: how fast price moved over the last 10 bars.'],
  [
    'macdMacd',
    'MACD',
    'Moving Average Convergence Divergence: trend-and-momentum gauge; crossing its signal line hints at a turn.',
  ],
  [
    'macdSignal',
    'MACD signal',
    'The MACD signal line; a MACD crossing it hints at a momentum turn.',
  ],
  ['stochRsiK', 'Stoch RSI', 'Stochastic RSI: a more sensitive RSI for spotting turns sooner.'],
  ['wr', 'Williams %R', 'Williams %R: overbought/oversold gauge, −100 to 0; near 0 = overbought.'],
  [
    'bbPower',
    'Bull Bear Power',
    'Bull Bear Power: whether buyers or sellers are winning right now.',
  ],
  [
    'uo',
    'Ultimate Osc',
    'Ultimate Oscillator: momentum blended across three timeframes to cut false signals.',
  ],
];

/** Moving-average field → display label + gloss, in Technicals's table order. */
const MOVING_AVERAGE_LABELS: readonly (readonly [
  keyof TechnicalsMovingAverages,
  string,
  string,
])[] = [
  ['ema5', 'EMA 5', EMA_SMA_GLOSS],
  ['ema10', 'EMA 10', EMA_SMA_GLOSS],
  ['ema20', 'EMA 20', EMA_SMA_GLOSS],
  ['ema30', 'EMA 30', EMA_SMA_GLOSS],
  ['ema50', 'EMA 50', EMA_SMA_GLOSS],
  ['ema100', 'EMA 100', EMA_SMA_GLOSS],
  ['ema200', 'EMA 200', EMA_SMA_GLOSS],
  ['sma5', 'SMA 5', EMA_SMA_GLOSS],
  ['sma10', 'SMA 10', EMA_SMA_GLOSS],
  ['sma20', 'SMA 20', EMA_SMA_GLOSS],
  ['sma30', 'SMA 30', EMA_SMA_GLOSS],
  ['sma50', 'SMA 50', EMA_SMA_GLOSS],
  ['sma100', 'SMA 100', EMA_SMA_GLOSS],
  ['sma200', 'SMA 200', EMA_SMA_GLOSS],
  [
    'vwma',
    'VWMA (20)',
    'Volume-Weighted Moving Average: average price weighted by how much traded at each level.',
  ],
  [
    'hullMa9',
    'Hull MA (9)',
    'Hull Moving Average: a fast-reacting, smoothed average that lags less.',
  ],
  [
    'ichimokuBLine',
    'Ichimoku Base',
    'Ichimoku Base Line: midpoint of the recent high–low range; a slower trend reference.',
  ],
];

interface SymbolTechnicalsPanelProps {
  readonly profileId: string;
  readonly symbol: string;
  /** Test seam — defaults to Date.now. */
  readonly clock?: () => number;
}

/** Compact display of an indicator reading; a null cell renders an em dash. */
const formatIndicator = (value: number | null): string =>
  value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Find the compute-job health row for `interval`, or undefined when the
 * health endpoint has not reported it. Used by both the empty-body
 * diagnostic and the tab strip so a Technicals outage shows the same
 * friendly reason on both surfaces.
 */
export const findHealthForInterval = (
  intervals: readonly TechnicalsFetchStatus[] | undefined,
  interval: string,
): TechnicalsFetchStatus | undefined => intervals?.find((i) => i.interval === interval);

/**
 * Build a stable absolute-time tooltip for a relative-time readout. Renders
 * the UTC anchor plus the operator's configured zone (passed in), so the
 * tooltip reads consistently across deployments regardless of browser locale.
 */
const absoluteTime = (ms: number, timeZone: string): string => formatInstant(ms, timeZone);

/**
 * Render the per-interval buy-gate status as a compact "Buy: …" line. When
 * the gate currently passes AND the matched signal is within ~60s of the
 * `useOnlyWithinMin` threshold the suffix names the remaining window
 * ("PASSES (BUY · expires 30s)") so the operator sees the gate is about
 * to flip without having to compare timestamps manually.
 */
function buyGateText(
  status: BuyGateStatus,
  expiresInSecs: number | null,
): { readonly text: string; readonly tone: string } {
  switch (status.kind) {
    case 'inactive':
      return { text: 'Buy gate: not in this row', tone: 'text-muted-fg' };
    case 'pending':
      return { text: 'Buy gate: waiting for signal', tone: 'text-muted-fg' };
    case 'pass': {
      const tail =
        expiresInSecs !== null && expiresInSecs <= 60
          ? ` · expires ${Math.max(0, expiresInSecs)}s`
          : '';
      return {
        text: `Buy gate: PASSES (${RECOMMENDATION_LABEL[status.recommendation]}${tail})`,
        tone: 'text-success',
      };
    }
    case 'block':
      if (status.reason === 'stale')
        return { text: 'Buy gate: BLOCKED (signal stale)', tone: 'text-warning' };
      if (status.reason === 'sell') {
        return {
          text: `Buy gate: BLOCKED (${RECOMMENDATION_LABEL[status.recommendation as TechnicalsRecommendation]})`,
          tone: 'text-warning',
        };
      }
      return {
        text: `Buy gate: BLOCKED (${status.recommendation == null ? 'no signal' : RECOMMENDATION_LABEL[status.recommendation]} not allowed)`,
        tone: 'text-warning',
      };
  }
}

/** Render the per-interval force-sell status as a compact "Force-sell: …" line. */
function forceSellText(status: ForceSellStatus): { readonly text: string; readonly tone: string } {
  switch (status.kind) {
    case 'inactive':
      return { text: 'Force-sell: not in this row', tone: 'text-muted-fg' };
    case 'pending':
      return {
        text: `Force-sell: paused (${status.reason === 'stale' ? 'signal stale' : 'no signal'})`,
        tone: 'text-muted-fg',
      };
    case 'idle':
      return { text: 'Force-sell: not armed', tone: 'text-muted-fg' };
    case 'armed':
      return {
        text: `Force-sell: ARMED (${RECOMMENDATION_LABEL[status.recommendation]})`,
        tone: 'text-warning',
      };
  }
}

/** One verdict gauge: a label and a colour-coded recommendation badge. */
function Gauge({
  label,
  verdict,
  testId,
}: {
  readonly label: string;
  readonly verdict: TechnicalsRecommendation | null;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="border-border flex flex-col items-center gap-1 rounded-md border p-3">
      <span className="text-muted-fg text-xs">{label}</span>
      {verdict == null ? (
        <span className="text-muted-fg text-xs" data-testid={testId}>
          —
        </span>
      ) : (
        <Badge variant={RECOMMENDATION_VARIANT[verdict]} data-testid={testId}>
          {RECOMMENDATION_LABEL[verdict]}
        </Badge>
      )}
    </div>
  );
}

/**
 * Disclosure wrapper for the 32-row indicator grid. Defaults collapsed so
 * the panel fits more cleanly on mobile (375×667) and only operators
 * who want to see the raw oscillator / moving-average readings expand
 * it. State is local-only, no persistence — the panel reload starts
 * collapsed every time, matching the "scan, expand if needed" pattern.
 */
function CollapsibleIndicators({
  oscillators,
  movingAverages,
}: {
  readonly oscillators: TechnicalsOscillators;
  readonly movingAverages: TechnicalsMovingAverages;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="symbol-tv-indicators-toggle"
        className="text-muted-fg hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        {open ? '▼' : '▶'} {open ? 'Hide' : 'Show'} indicators (32)
      </button>
      {open ? (
        <div className="space-y-2">
          <p className="text-muted-fg text-xs">
            These are the raw technical readings the Summary verdict above is built from — each name
            has a plain-language note beneath it.
          </p>
          <IndicatorGroup heading="Oscillators" labels={OSCILLATOR_LABELS} values={oscillators} />
          <IndicatorGroup
            heading="Moving averages"
            labels={MOVING_AVERAGE_LABELS}
            values={movingAverages}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A labelled grid of indicator readings under a group heading. */
function IndicatorGroup<K extends string>({
  heading,
  labels,
  values,
}: {
  readonly heading: string;
  readonly labels: readonly (readonly [K, string, string])[];
  readonly values: Readonly<Record<K, number | null>>;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <h3 className="text-muted-fg text-xs">{heading}</h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {labels.map(([key, label, gloss]) => (
          <div key={key} className="flex items-baseline justify-between gap-2 text-xs">
            <div className="min-w-0">
              <dt className="text-muted-fg truncate">{label}</dt>
              <p className="text-muted-fg/70 mt-0.5 text-xs">{gloss}</p>
            </div>
            <dd className="font-mono tabular-nums" data-testid={`tv-indicator-${key}`}>
              {formatIndicator(values[key])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Renders the per-interval body of the panel: staleness pill, three verdict
 * gauges, and the indicator tables when present. Extracted so the multi-
 * interval tab strip can switch between bodies without duplicating layout.
 */
function IntervalSection({
  signal,
  symbol,
  intervalConfig,
  intervalHealth,
  useOnlyWithinMin,
  ifExpires,
  clock,
  timeZone,
}: {
  readonly signal: TechnicalsSignal | null;
  readonly symbol: string;
  readonly intervalConfig: TechnicalsIntervalConfig | null;
  /** Latest compute-job health row for this interval; surfaces the outage
   *  reason inline when the panel has no signal yet. */
  readonly intervalHealth: TechnicalsFetchStatus | undefined;
  readonly useOnlyWithinMin: number;
  readonly ifExpires: 'do-not-buy' | 'allow-anyway';
  readonly clock: () => number;
  readonly timeZone: string;
}): React.JSX.Element {
  const nowMs = clock();
  const staleThresholdMs = useOnlyWithinMin * 60_000;
  const isStale = signal !== null && nowMs - signal.receivedAtMs > staleThresholdMs;

  if (signal === null) {
    // Surface the compute-job health diagnostic so the operator can tell
    // "waiting for the first fetch" from "compute is failing". The pill
    // already shows global health, but an operator looking at a specific
    // symbol panel should not have to look up. When the worker has
    // previously seen a fresh signal for this interval we also name the
    // outage duration so the operator knows whether to keep waiting or
    // to investigate.
    const errorLabel = intervalHealth?.error ? friendlyErrorLabel(intervalHealth.error) : null;
    const lastFreshAtMs = intervalHealth?.lastFreshAtMs ?? null;
    const lastFreshAgo =
      lastFreshAtMs !== null ? humaniseAge(nowMs - lastFreshAtMs, { suffix: ' ago' }) : null;
    return (
      <div className="text-muted-fg space-y-1 text-xs" data-testid="symbol-tv-empty">
        <p>No signal yet for {symbol} at this interval.</p>
        {errorLabel ? (
          <p data-testid="symbol-tv-empty-health">
            Compute reports: <span className="text-warning font-mono">{errorLabel}</span>
            {lastFreshAgo ? <> (last fresh {lastFreshAgo})</> : <> (no successful fetch yet)</>}.
            The panel will refresh once the next scheduled refresh succeeds.
          </p>
        ) : lastFreshAgo ? (
          <p data-testid="symbol-tv-empty-fresh">
            Compute is healthy (last fresh {lastFreshAgo}); waiting for this symbol's row at the
            next scheduled refresh.
          </p>
        ) : (
          <p>The panel re-reads the cache every 15s; the worker computes a new signal every 60s.</p>
        )}
      </div>
    );
  }

  const buyStatus = intervalConfig
    ? evaluateBuyGateForInterval(intervalConfig, signal, useOnlyWithinMin, ifExpires, nowMs)
    : null;
  const sellStatus = intervalConfig
    ? evaluateForceSellForInterval(intervalConfig, signal, useOnlyWithinMin, nowMs)
    : null;
  // Seconds until the matched signal crosses the freshness threshold. Used
  // only on the PASS branch so the operator sees an `expires Ns` countdown
  // when the gate is about to flip. Null when there is no signal to expire
  // against (the PASS branch will not fire then anyway).
  const expiresInSecs =
    signal !== null ? Math.floor((signal.receivedAtMs + staleThresholdMs - nowMs) / 1_000) : null;
  const buy = buyStatus ? buyGateText(buyStatus, expiresInSecs) : null;
  const sell = sellStatus ? forceSellText(sellStatus) : null;

  // Force-sell ignores stale signals unconditionally; the buy
  // side respects `ifExpires`. The pill text spells both out so the
  // operator never wonders whether one branch is still firing on stale
  // data.
  const buySidePill = ifExpires === 'do-not-buy' ? 'buy vetoed' : 'buy still allowed';

  return (
    <div className="space-y-3">
      <div className="text-xs" data-testid="symbol-technicals-staleness">
        <span
          className={isStale ? 'text-warning' : 'text-muted-fg'}
          title={absoluteTime(signal.receivedAtMs, timeZone)}
        >
          {humaniseAge(nowMs - signal.receivedAtMs, { suffix: ' ago' })}
        </span>
        {isStale ? (
          <span className="text-muted-fg">
            {' '}
            · stale (&gt; {useOnlyWithinMin} min; {buySidePill}; force-sell also paused)
          </span>
        ) : null}
      </div>
      <p className="text-muted-fg text-xs">
        Technical read-outs from recent candles — green leans bullish, red bearish. The buy gate
        uses these to block new buys until the verdicts you selected in this profile&apos;s config
        agree; it filters entries, it never forces a buy.
      </p>
      {buy || sell ? (
        <div className="space-y-0.5 text-xs" data-testid="symbol-technicals-gate-status">
          {buy ? <p className={buy.tone}>{buy.text}</p> : null}
          {sell ? <p className={sell.tone}>{sell.text}</p> : null}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        <Gauge label="Summary" verdict={signal.recommendation} testId="symbol-tv-recommendation" />
        <Gauge
          label="Oscillators"
          verdict={signal.oscRecommendation}
          testId="symbol-tv-osc-recommendation"
        />
        <Gauge
          label="Moving avg"
          verdict={signal.maRecommendation}
          testId="symbol-tv-ma-recommendation"
        />
      </div>
      {signal.indicators ? (
        <CollapsibleIndicators
          oscillators={signal.indicators.oscillators}
          movingAverages={signal.indicators.movingAverages}
        />
      ) : null}
    </div>
  );
}

/**
 * Polls the per-profile recommendations endpoint, finds the entry for
 * `symbol`, and renders one section per operator-configured interval. The
 * multi-interval tab strip is shown only when more than one interval is
 * configured; a single-interval profile renders the same compact section
 * the panel had pre-multi-interval.
 */
export function SymbolTechnicalsPanel({
  profileId,
  symbol,
  clock = Date.now,
}: SymbolTechnicalsPanelProps): React.JSX.Element {
  const timeZone = useTimezone();
  const accountId = useActiveAccountId() ?? '';
  const recs = useQuery({
    queryKey: technicalsRecommendationsQueryKey(profileId),
    queryFn: () => fetchTechnicalsRecommendations(profileId),
    refetchInterval: TV_POLL_MS,
    staleTime: TV_POLL_MS,
  });
  // Shared dashboard health query. The co-located TechnicalsHealthPill polls
  // the same key at TV_HEALTH_POLL_MS so the network round-trip is deduped
  // by TanStack Query; the explicit refetchInterval here keeps the inline
  // outage diagnostic alive even if a future refactor extracts the pill
  // out of the panel header.
  const health = useQuery({
    queryKey: technicalsHealthQueryKey(),
    queryFn: fetchTechnicalsHealth,
    refetchInterval: TV_HEALTH_POLL_MS,
    staleTime: TV_HEALTH_POLL_MS,
  });

  const item = recs.data?.items.find((i) => i.symbol === symbol);
  // When the response carries no entry for `symbol` — or carries an entry
  // with an empty `signals[]` array (which can happen if a future producer
  // diverges from the 1:1 invariant) — synthesise null-signal rows from
  // the operator's configured intervals so the panel renders the per-
  // interval empty body, including any compute-job health diagnostic, rather
  // than the "no intervals configured" state. The no-intervals state is
  // reserved for genuinely empty config (`technicals.intervals.length === 0`).
  const intervalRows = useMemo(() => {
    if (item?.signals && item.signals.length > 0) return item.signals;
    return (recs.data?.technicals.intervals ?? []).map((cfg) => ({
      interval: cfg.interval,
      signal: null,
    }));
  }, [item, recs.data]);
  const useOnlyWithinMin = recs.data?.technicals.useOnlyWithinMin ?? DEFAULT_FRESHNESS_MIN;
  const ifExpires = recs.data?.technicals.ifExpires ?? 'do-not-buy';
  // Drive a 1s re-render while any signal is within 60s of expiry so the
  // per-tab countdowns and the Buy-gate expiry suffix decrement smoothly
  // between polls. Reads the same `item` the body renders — no second find.
  useNearExpiryTick(item, useOnlyWithinMin, clock);
  // Pair each panel-rendered signal with its config row so the gate-
  // status helpers can read the operator's allow/trigger toggles. The
  // bundle producer preserves order so the i-th row pairs with the i-th
  // signal; a defensive map lookup keeps the panel robust to a future
  // producer that reorders.
  const configByInterval = useMemo(() => {
    const m = new Map<string, TechnicalsIntervalConfig>();
    for (const row of recs.data?.technicals.intervals ?? []) m.set(row.interval, row);
    return m;
  }, [recs.data]);

  // The active tab is operator-controlled; default to the first configured
  // interval. A clamped `safeActiveIdx` covers the render-frame race
  // between the operator editing the intervals list (state may briefly
  // index past the array) and the post-commit `useEffect` resetting it —
  // without the clamp both `aria-selected` and the active-row highlight
  // would point at a tab that doesn't exist.
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    if (activeIdx >= intervalRows.length && intervalRows.length > 0) setActiveIdx(0);
  }, [intervalRows.length, activeIdx]);
  const safeActiveIdx = activeIdx < intervalRows.length ? activeIdx : 0;
  const active = intervalRows[safeActiveIdx];

  const { announcement, refresh, refreshing } = useRefreshAnnouncement(
    profileId,
    recs,
    health,
    clock,
  );

  const gateActive = recs.data?.gateActive ?? true;

  return (
    <section className="space-y-3" data-testid="symbol-tv-panel">
      {/* Screen-reader-only live region for the manual refresh outcome. Only
       * speaks when the operator clicked the refresh button (background
       * polls suppress the announcement) so the SR is not chatty. */}
      <span
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="symbol-tv-refresh-announce"
      >
        {announcement}
      </span>
      {gateActive ? null : (
        <Alert variant="warning" data-testid="symbol-tv-gate-bypassed">
          <strong>Technicals gate bypassed.</strong> The profile's{' '}
          <Link
            to="/accounts/$accountId/profiles/$profileId/config"
            params={{ accountId, profileId }}
            className="underline-offset-2 hover:underline"
          >
            Force Buy Override → Apply Technicals gate
          </Link>{' '}
          is off — buys ignore Technicals entirely. Signals below are informational only.
        </Alert>
      )}
      {/* `flex-wrap` lets the pill+links drop to a new row on a narrow rail
       * (the symbol detail right column is ~277px wide at 375×667 — the
       * "technicals outage … · never fresh" string overflows, and without
       * wrapping the pill ran into the heading and the external link
       * dropped under it). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-fg text-sm font-semibold">
          {/* Deep-link the heading to the profile config so an operator can
           * jump from a panel verdict to the Technicals gate settings in
           * one click, instead of going back → profile → config. Same
           * `text-accent` hover treatment as the no-intervals empty-state
           * link below — heading colour stays neutral so the section still
           * reads as a header, not a CTA. */}
          <Link
            to="/accounts/$accountId/profiles/$profileId/config"
            params={{ accountId, profileId }}
            className="hover:underline"
            data-testid="symbol-tv-heading-link"
          >
            Technicals
          </Link>
        </h2>
        <div className="flex items-center gap-3">
          <SharedTechnicalsHealthPill clock={clock} testId="symbol-tv-technicals-health" />
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh Technicals signal and compute-job health"
            title="Refresh now (otherwise the panel re-polls every 15s)"
            className="text-muted-fg hover:text-foreground inline-flex items-center text-xs disabled:opacity-50"
            data-testid="symbol-tv-refresh"
          >
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} aria-hidden />
          </button>
          <a
            href={`https://www.tradingview.com/symbols/${symbol}/technicals/?exchange=BINANCE`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-fg hover:text-foreground inline-flex items-center gap-1 text-xs"
            data-testid="symbol-tv-external-link"
            title="Open TradingView's published Technical Ratings for this symbol so you can cross-check against the ratings we compute locally from Binance klines. Note: long moving averages (EMA/SMA 100 and 200) are computed over a recent-candle window, so their raw values can differ slightly from TradingView's full-history values — the buy/sell signal still matches in trending conditions."
          >
            Compare on TradingView
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </div>

      {recs.isLoading ? (
        <p className="text-muted-fg text-xs" data-testid="symbol-tv-loading">
          Loading Technicals…
        </p>
      ) : intervalRows.length === 0 && recs.error ? (
        // A failed poll keeps the last good response in `recs.data` (TanStack
        // v5 holds data and error together after a background refetch fails);
        // only fall to the error state when there is no signal to show.
        <Alert variant="danger">
          <AlertTitle>Technicals unavailable</AlertTitle>
          <AlertDescription>
            {recs.error instanceof Error ? recs.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : intervalRows.length === 0 ? (
        <div className="text-muted-fg space-y-1 text-xs" data-testid="symbol-tv-empty">
          <p>No Technicals intervals configured.</p>
          <p>
            Add an interval in the{' '}
            <Link
              to="/accounts/$accountId/profiles/$profileId/config"
              params={{ accountId, profileId }}
              className="text-accent underline-offset-2 hover:underline"
              data-testid="symbol-tv-empty-config-link"
            >
              profile's strategy config
            </Link>{' '}
            to enable the Technicals gate.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {intervalRows.length > 1 ? (
            <div
              className="flex flex-wrap gap-1"
              role="tablist"
              aria-label="Technicals intervals"
              data-testid="symbol-tv-interval-tabs"
            >
              {intervalRows.map((row, i) => {
                const verdict = row.signal?.recommendation ?? null;
                // When no signal exists for this interval show why
                // ("no signal" by default, or the friendly health error if
                // the compute job is reporting one) instead of a bare em-dash.
                let verdictLabel: string;
                const healthRow = findHealthForInterval(health.data?.intervals, row.interval);
                if (verdict != null) {
                  verdictLabel = SHORT_LABEL_FOR[verdict];
                } else {
                  verdictLabel = healthRow?.error
                    ? friendlyErrorLabel(healthRow.error)
                    : 'no signal';
                }
                const ariaVerdict = verdict != null ? RECOMMENDATION_LABEL[verdict] : verdictLabel;
                const verdictClass =
                  verdict == null
                    ? 'text-muted-fg'
                    : i === safeActiveIdx
                      ? 'text-white/90'
                      : RECOMMENDATION_TONE[verdict];
                return (
                  <button
                    key={row.interval}
                    type="button"
                    role="tab"
                    aria-selected={i === safeActiveIdx}
                    aria-label={`${row.interval}: ${ariaVerdict}`}
                    data-testid={`symbol-tv-interval-tab-${row.interval}`}
                    onClick={() => setActiveIdx(i)}
                    className={cn(
                      'rounded-xs border px-2 py-0.5 text-xs font-medium transition-colors',
                      i === safeActiveIdx
                        ? 'bg-accent border-transparent text-white'
                        : 'text-muted-fg hover:bg-accent/10 border-border',
                    )}
                  >
                    <span>{row.interval}</span>
                    <span
                      className={cn('ml-1 font-normal', verdictClass)}
                      data-testid={`symbol-tv-interval-tab-verdict-${row.interval}`}
                    >
                      {' '}
                      {verdictLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <IntervalSection
            signal={active?.signal ?? null}
            symbol={symbol}
            intervalConfig={active ? (configByInterval.get(active.interval) ?? null) : null}
            intervalHealth={
              active ? findHealthForInterval(health.data?.intervals, active.interval) : undefined
            }
            useOnlyWithinMin={useOnlyWithinMin}
            ifExpires={ifExpires}
            clock={clock}
            timeZone={timeZone}
          />
        </div>
      )}
    </section>
  );
}
