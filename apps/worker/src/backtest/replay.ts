import { createHash } from 'node:crypto';
import {
  TechnicalsBundleConfigSchema,
  candleIntervalMs,
  marketOf,
  type BacktestParams,
  type BacktestProgressUpdate,
  type BacktestResult,
  type TechnicalsBundleConfig,
  type TechnicalsIntervalSignal,
} from '@app/contracts';
import { computeTechnicalsRating } from '@app/indicators/rating';
import type { AnyStrategy, Candle, CandleInterval, SymbolInfo } from '@app/strategy-core';
import {
  BACKTEST_ENGINE_REVISION,
  configFingerprint,
  resolveCandleWindow,
} from '@app/strategy-core';
import {
  OhlcvFillModel,
  arrayMarketDataSource,
  runBacktest,
  type EquityPoint,
  type MarketDataSource,
  type MarketTick,
  type SymbolCandles,
} from '@app/strategy-backtest';
import { feedIntervals } from '../market-data/feed-intervals.js';
import { ratingToSignal } from '../technicals/rating-to-signal.js';
import {
  TECHNICALS_SOURCE_CANDLE_LIMIT,
  prepareTechnicalsRatingWindow,
} from '../technicals/rating-window.js';
import {
  BUNDLE_PROVIDER_ENTRY_HINT,
  BUNDLE_PROVIDER_OVERRIDE,
  BUNDLE_PROVIDER_TECHNICALS,
} from '../tick/bundle-providers.js';
import { orderFeasibilityWarnings } from './order-feasibility-warnings.js';
import { LruSignalCache, type SignalCache } from './signal-cache.js';

/** Thrown to abort an in-flight replay when the run is cancelled out-of-band. */
export class BacktestCancelledError extends Error {
  constructor(runId: string) {
    super(`backtest run cancelled: ${runId}`);
    this.name = 'BacktestCancelledError';
  }
}

const MINUTE_INTERVAL = '1m' as const;
const DAILY_INTERVAL = '1d' as const;
// Trailing daily candles a decision sees: the longest regime moving-average period (200) plus confirmation bars, matching the rating-window discipline.
const REGIME_WINDOW_CAP = 250;

// Tick-count ceiling between cooperative event-loop yields. A tight replay loop over a long range otherwise starves the worker's heartbeat, throttled progress writes and BullMQ lock renewal. The time budget below yields far sooner when ticks are slow; this count bounds a fast run.
const YIELD_EVERY_TICKS = 256;
// Elapsed time is the real risk: one slow tick can take tens of milliseconds, so yielding on time keeps the gap well under the 60s heartbeat refresh whatever each tick costs.
const YIELD_INTERVAL_MS = 50;
// A throttled replay shrinks each work quantum, and so each proportional sleep, which bounds the latency a co-resident api or live process sees under ROLE=all.
const THROTTLED_YIELD_INTERVAL_MS = 20;

// Below this share of the expected candles a symbol's history is too sparse to trust. Just under 1 so a candle or two of edge rounding raises nothing.
const COVERAGE_WARN_THRESHOLD = 0.95;
// A run of this many missing candles is flagged even when overall coverage clears the threshold: one long hole hides a price discontinuity that the ratio cannot see.
const MAX_CONTIGUOUS_GAP_BARS = 12;

// What every replay leaves out. They go to `modelNotes` rather than `dataWarnings` because the live gate fails a run on any data warning and these apply to every run.
const REPLAY_LIMITATIONS: readonly string[] = [
  'the symbol universe is a fixed basket for the whole run; live discovery adding or removing symbols is not replayed',
  'worker pauses, loss pauses and restarts are not replayed; the strategy is assumed to run at every decision',
  'the run starts flat, and any position still open is marked at the final close without forced liquidation',
  'the price path inside a candle is unknown, so a fill inside one candle is an assumption about that path',
  'exchange filters are the values at run time, not the values in force during the replayed period',
];

/**
 * Sleep to hold the replay to a `cpuShare` fraction of one core.
 *
 * @param workMs - Time spent working since the last yield.
 * @param cpuShare - Fraction of one core the replay may use; 1 or above means no sleep.
 * @returns Milliseconds to sleep so work / (work + sleep) equals `cpuShare`.
 */
export const throttleSleepMs = (workMs: number, cpuShare: number): number =>
  cpuShare >= 1 ? 0 : workMs * (1 / cpuShare - 1);

export interface CooperativeYieldOptions {
  /** Fraction of one core the replay may use, in (0, 1]. Default 1 = full speed. */
  readonly cpuShare?: number;
  /** Override the wall-clock yield budget; defaults by throttle state. */
  readonly intervalMs?: number;
  /** Tick-count fallback ceiling between yields. */
  readonly everyN?: number;
}

/**
 * Build the per-tick pacer behind {@link cooperativeDataSource}: it returns immediately until the wall-clock budget or the tick ceiling is reached, then cedes the event loop (sleeping first when throttled), so a long replay cannot starve the worker's other jobs.
 *
 * @param options - The CPU share and yield cadence; each falls back to its default.
 * @returns A function to await once per tick, which resolves at once or after a yield.
 */
function cooperativeYielder(options: CooperativeYieldOptions): () => Promise<void> {
  const cpuShare = options.cpuShare ?? 1;
  const everyN = options.everyN ?? YIELD_EVERY_TICKS;
  const intervalMs =
    options.intervalMs ?? (cpuShare < 1 ? THROTTLED_YIELD_INTERVAL_MS : YIELD_INTERVAL_MS);
  let sinceYield = 0;
  let lastYieldMs = Date.now();
  return async () => {
    const now = Date.now();
    if (++sinceYield < everyN && now - lastYieldMs < intervalMs) return;
    const sleepMs = throttleSleepMs(now - lastYieldMs, cpuShare);
    await (sleepMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, sleepMs))
      : new Promise<void>((resolve) => setImmediate(resolve)));
    sinceYield = 0;
    // Re-read after the sleep so the next quantum measures work, not rest.
    lastYieldMs = Date.now();
  };
}

/**
 * Wrap a stream so the replay cedes the event loop on a wall-clock budget, or every `everyN` ticks as a fallback. Pure scheduling: a yield never drops or reorders a tick, so the report is unchanged. `Date.now()` is read at this worker seam, not inside the pure engine.
 *
 * @param inner - The stream to pace.
 * @param options - The CPU share and the yield cadence.
 * @returns The same stream, ceding the event loop between ticks.
 */
export function cooperativeDataSource(
  inner: MarketDataSource,
  options: CooperativeYieldOptions = {},
): MarketDataSource {
  return {
    stream(req) {
      const upstream = inner.stream(req);
      const pace = cooperativeYielder(options);
      async function* gen(): AsyncGenerator<MarketTick> {
        for await (const tick of upstream) {
          await pace();
          yield tick;
        }
      }
      return gen();
    },
  };
}

/**
 * The trailing closed window as of a decision, advanced through a forward-only cursor so each call is O(1) amortised.
 *
 * @param candles - The ascending series for one symbol and interval.
 * @param asOfMs - The decision instant; it must not move backwards for one `cursorKey`.
 * @param cursor - Per-run map holding how far each series has been consumed.
 * @param cursorKey - The entry in `cursor` that belongs to this series.
 * @param cap - The most candles to return, newest kept.
 * @returns Only candles closed at or before `asOfMs`.
 */
export function closedWindowAsOf(
  candles: readonly Candle[],
  asOfMs: number,
  cursor: Map<string, number>,
  cursorKey: string,
  cap: number,
): Candle[] {
  let count = cursor.get(cursorKey) ?? 0;
  while (count < candles.length && (candles[count]?.closeTimeMs ?? Infinity) <= asOfMs) count++;
  cursor.set(cursorKey, count);
  return candles.slice(Math.max(0, count - cap), count);
}

/**
 * Per-symbol warnings when candle coverage inside `[fromMs, toMs)` falls short. Candles loaded before the range are not counted.
 *
 * @param symbols - The basket.
 * @param candlesByKey - Loaded candles keyed `symbol|interval`, ascending.
 * @param interval - The interval whose coverage is measured.
 * @param fromMs - Inclusive range start.
 * @param toMs - Exclusive range end.
 * @param intervalMs - Length of one `interval` candle.
 * @returns One message per symbol whose coverage is too low or that holds a long contiguous hole.
 */
export function dataCoverageWarnings(
  symbols: readonly string[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  interval: CandleInterval,
  fromMs: number,
  toMs: number,
  intervalMs: number,
): string[] {
  const expected = Math.floor((toMs - fromMs) / intervalMs);
  if (expected <= 0) return [];
  const warnings: string[] = [];
  for (const symbol of symbols) {
    const inWindow = (candlesByKey.get(`${symbol}|${interval}`) ?? []).filter(
      (c) => c.openTimeMs >= fromMs && c.openTimeMs < toMs,
    );
    if (inWindow.length / expected < COVERAGE_WARN_THRESHOLD) {
      const pct = Math.round((inWindow.length / expected) * 100);
      warnings.push(
        `${symbol}: only ${pct}% of the expected ${interval} candles are present ` +
          `(${inWindow.length}/${expected}). Possible delisting, trading halt, or thin liquidity. ` +
          `Treat this symbol's results with caution.`,
      );
      continue;
    }
    // floor, not round, so an unaligned bound straddling a bar cannot manufacture a phantom missing bar.
    const first = inWindow[0];
    if (first) {
      let maxGap = Math.floor((first.openTimeMs - fromMs) / intervalMs);
      let prevOpen = first.openTimeMs;
      for (const c of inWindow) {
        const missing = Math.floor((c.openTimeMs - prevOpen) / intervalMs) - 1;
        if (missing > maxGap) maxGap = missing;
        prevOpen = c.openTimeMs;
      }
      const tailMissing = Math.floor((toMs - prevOpen) / intervalMs) - 1;
      if (tailMissing > maxGap) maxGap = tailMissing;
      if (maxGap >= MAX_CONTIGUOUS_GAP_BARS) {
        warnings.push(
          `${symbol}: a contiguous gap of ${maxGap} ${interval} candles is missing inside ` +
            `the window, a likely halt or delisting with a price discontinuity across it. Treat ` +
            `this symbol's results with caution.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Build the series the engine replays: one row per detail candle, so marks and resting orders advance on the detail clock while decisions wait for their boundary.
 *
 * @param symbols - The basket, in canonical order.
 * @param candlesByKey - Loaded candles keyed `symbol|interval`.
 * @param detailInterval - The interval streamed for fills and marks.
 * @returns One series per symbol.
 */
export function buildTickSeries(
  symbols: readonly string[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  detailInterval: CandleInterval,
): SymbolCandles[] {
  return symbols.map((symbol) => ({
    symbol,
    interval: detailInterval,
    candles: candlesByKey.get(`${symbol}|${detailInterval}`) ?? [],
  }));
}

/**
 * Build the per-tick `{technicals, override}` bundle from loaded candle windows.
 *
 * @param strategy - The strategy whose declared bundle providers select what is built.
 * @param tvConfig - The Technicals config, or null when the run has none.
 * @param candlesByKey - Loaded candles keyed `symbol|interval`, ascending.
 * @param symbol - The symbol being decided.
 * @param asOfMs - The decision instant; nothing closing after it is read.
 * @param signalCache - Memoises each derived signal by its window; pass one per run. Omitted, every read re-derives.
 * @param windowCursor - Per-run forward-only index keyed like `candlesByKey`; omitted, each call scans from the start.
 * @param discoveryMode - When true and the strategy declares the entry-hint provider, every tick carries an armed entry hint, the same seam live discovery injects, so entries exit through the discovery regime.
 * @returns The bundle for this tick.
 */
export function buildBundle(
  strategy: AnyStrategy,
  tvConfig: TechnicalsBundleConfig | null,
  candlesByKey: ReadonlyMap<string, Candle[]>,
  symbol: string,
  asOfMs: number,
  signalCache?: SignalCache,
  windowCursor?: Map<string, number>,
  discoveryMode = false,
): Record<string, unknown> {
  const providers = strategy.capabilities.bundleProviders;
  const bundle: Record<string, unknown> = {};
  if (providers.includes(BUNDLE_PROVIDER_TECHNICALS) && tvConfig) {
    const signals: TechnicalsIntervalSignal[] = tvConfig.intervals.map((row) => {
      const interval = row.interval;
      const all = candlesByKey.get(`${symbol}|${interval}`) ?? [];
      const cursorKey = `${symbol}|${interval}`;
      let count = windowCursor?.get(cursorKey) ?? 0;
      while (count < all.length && (all[count]?.closeTimeMs ?? Infinity) <= asOfMs) count++;
      windowCursor?.set(cursorKey, count);
      const startIdx = Math.max(0, count - TECHNICALS_SOURCE_CANDLE_LIMIT);
      // A window too short to rate yields a null signal, matching the live path.
      try {
        // A signal does not change until a new candle of its interval closes, so a faster decision clock reuses it and only the freshness stamp tracks the tick. Both first and last close key it so a short cold-start window cannot collide with a full window ending at the same close.
        const latestClose = count > 0 ? (all[count - 1]?.closeTimeMs ?? asOfMs) : asOfMs;
        const firstClose = count > 0 ? (all[startIdx]?.closeTimeMs ?? asOfMs) : asOfMs;
        const key = `${symbol}|${interval}|${firstClose}|${latestClose}`;
        const cached = signalCache?.get(key);
        if (cached !== undefined) {
          return { interval, signal: { ...cached, receivedAtMs: asOfMs } };
        }
        const window = prepareTechnicalsRatingWindow(all.slice(startIdx, count));
        const signal = ratingToSignal(symbol, window, computeTechnicalsRating(window), asOfMs);
        signalCache?.set(key, signal);
        return { interval, signal };
      } catch {
        return { interval, signal: null };
      }
    });
    bundle['technicals'] = { config: tvConfig, signals };
  }
  if (providers.includes(BUNDLE_PROVIDER_OVERRIDE)) bundle['override'] = null;
  // Only `enterOnAdd`: the anti-chase guards default off and are entry timing, not the exit regime this models. No reaping is modelled, so the hint stays armed all window.
  if (discoveryMode && providers.includes(BUNDLE_PROVIDER_ENTRY_HINT)) {
    bundle['entryHint'] = { enterOnAdd: true };
  }
  return bundle;
}

/**
 * Length of a fixed-duration candle interval.
 *
 * @param interval - The interval name.
 * @returns Its length in milliseconds.
 * @throws When the interval has no fixed duration, such as `1M`.
 */
export function replayIntervalMs(interval: string): number {
  const ms = candleIntervalMs(interval);
  if (ms === null) throw new Error(`backtest does not support candle interval: ${interval}`);
  return ms;
}

/**
 * The interval the strategy decides on, read from its resolved config the way live reads it, so the strategy's `candlesByInterval[candleInterval]` reads are populated.
 *
 * @param config - The parsed strategy config.
 * @returns The configured interval, or null for a strategy that declares none.
 * @throws When the configured interval has no fixed duration, so a run cannot fail mid-backfill.
 */
export function readConfigInterval(config: unknown): CandleInterval | null {
  if (typeof config !== 'object' || config === null) return null;
  const value = (config as { candleInterval?: unknown }).candleInterval;
  if (typeof value !== 'string') return null;
  replayIntervalMs(value);
  return value as CandleInterval;
}

function readTechnicalsConfig(config: unknown): TechnicalsBundleConfig | null {
  if (typeof config !== 'object' || config === null || !('technicals' in config)) return null;
  const parsed = TechnicalsBundleConfigSchema.safeParse(
    (config as { technicals: unknown }).technicals,
  );
  return parsed.success ? parsed.data : null;
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** The three replay clocks and the native windows a decision reads. */
export interface ReplayIntervals {
  readonly technicals: TechnicalsBundleConfig | null;
  readonly strategyInterval: CandleInterval;
  readonly decisionInterval: CandleInterval;
  readonly detailInterval: CandleInterval;
  /** Strategy, 1m, 1d and every configured Technicals interval. */
  readonly nativeIntervals: readonly CandleInterval[];
}

/**
 * Resolve which candle series a run needs. A stored run predating the decision field falls back to one decision per strategy candle.
 *
 * @param config - The parsed strategy config.
 * @param params - The run's parameters.
 * @returns The clocks and native intervals.
 */
export function replayIntervals(config: unknown, params: BacktestParams): ReplayIntervals {
  const technicals = readTechnicalsConfig(config);
  const strategyInterval =
    readConfigInterval(config) ?? (params.strategyInterval as CandleInterval);
  return {
    technicals,
    strategyInterval,
    decisionInterval: (params.decisionInterval ?? strategyInterval) as CandleInterval,
    detailInterval: params.detailInterval as CandleInterval,
    nativeIntervals: unique([
      ...(feedIntervals(strategyInterval) as readonly CandleInterval[]),
      ...(technicals?.intervals.map((row) => row.interval as CandleInterval) ?? []),
    ]),
  };
}

/**
 * The one quote asset a basket is valued in.
 *
 * @param symbolInfos - The basket's exchange metadata.
 * @returns The shared quote asset.
 * @throws When the basket mixes quotes, since one equity curve cannot value both.
 */
export function sharedQuoteAsset(symbolInfos: readonly SymbolInfo[]): string {
  const quoteAsset = symbolInfos[0]?.quoteAsset ?? '';
  if (!symbolInfos.every((i) => i.quoteAsset === quoteAsset)) {
    throw new Error('backtest symbols must share one quote asset');
  }
  return quoteAsset;
}

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

/**
 * Hash every input the replay reads, so two runs with the same fingerprint saw identical candles and exchange filters. A candle closing at or after `toMs` is never served to a decision, and its stored form can still change, so it stays out of the hash.
 *
 * @param candlesByKey - Every candle series keyed `symbol|interval`; keys are sorted so map insertion order cannot change the hash.
 * @param symbolInfos - Exchange metadata whose filters shape order validity.
 * @param toMs - Exclusive end of the replay window; candles closing at or after it are skipped.
 * @returns A hex SHA-256 digest of the in-window candles and the symbol filters.
 */
function dataFingerprintOf(
  candlesByKey: ReadonlyMap<string, readonly Candle[]>,
  symbolInfos: readonly SymbolInfo[],
  toMs: number,
): string {
  const hash = createHash('sha256');
  for (const key of [...candlesByKey.keys()].sort()) {
    hash.update(`${key}\n`);
    for (const c of candlesByKey.get(key) ?? []) {
      if (c.closeTimeMs >= toMs) continue;
      hash.update(
        `${c.openTimeMs},${c.closeTimeMs},${c.open},${c.high},${c.low},${c.close},${c.volume}\n`,
      );
    }
  }
  hash.update(canonicalJson(symbolInfos.map((i) => [i.symbol, i.filters])));
  return hash.digest('hex');
}

/**
 * Describe gaps in the detail series that are small enough for the replay to proceed over. A symbol below the coverage threshold is reported as a data warning elsewhere, so it is not repeated here.
 *
 * @param symbols - The symbols the run replays.
 * @param candlesByKey - Every candle series keyed `symbol|interval`.
 * @param interval - The detail interval whose bars should tile the window.
 * @param fromMs - Inclusive window start.
 * @param toMs - Exclusive window end.
 * @param intervalMs - Length of one detail bar, which sets how many bars the window should hold.
 * @returns One note per symbol that is missing bars yet still has coverage at or above the threshold, empty when none.
 */
function missingDetailNotes(
  symbols: readonly string[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  interval: CandleInterval,
  fromMs: number,
  toMs: number,
  intervalMs: number,
): string[] {
  const expected = Math.floor((toMs - fromMs) / intervalMs);
  return symbols.flatMap((symbol) => {
    const present = (candlesByKey.get(`${symbol}|${interval}`) ?? []).filter(
      (c) => c.openTimeMs >= fromMs && c.openTimeMs < toMs,
    ).length;
    const missing = expected - present;
    if (missing <= 0 || present / expected < COVERAGE_WARN_THRESHOLD) return [];
    return [
      `${symbol}: ${missing} of ${expected} ${interval} candles are missing; none was invented, so that symbol has no new mark, fill or decision at those times`,
    ];
  });
}

export interface ReplayPreparedInput {
  readonly strategy: AnyStrategy;
  /** Config already parsed by the strategy's schema. */
  readonly config: unknown;
  readonly params: BacktestParams;
  /** Exchange metadata in canonical symbol order. */
  readonly symbolInfos: readonly SymbolInfo[];
  /** Every native and detail series keyed `symbol|interval`, ascending and closed. */
  readonly candlesByKey: ReadonlyMap<string, Candle[]>;
  /** The deployed build, or `unknown`. */
  readonly buildId: string;
  /** Fraction of one core the replay may use. */
  readonly cpuShare?: number;
  readonly onProgress?: (update: BacktestProgressUpdate) => void;
  /** Checked on every frame; returning true aborts with {@link BacktestCancelledError}. */
  readonly shouldCancel?: () => boolean;
  /** Sees every valuation before the stored curve is downsampled. */
  readonly onEquityMark?: (point: EquityPoint) => void;
}

/**
 * Replay a strategy over candles that are already in memory and map the report to the wire result. The worker and the study script both come through here, so a study measures the replay the operator runs.
 *
 * @param input - The resolved strategy and config, the loaded candles and the replay observers.
 * @returns The wire result and the fingerprint of the config it executed.
 */
export async function replayPrepared(
  input: ReplayPreparedInput,
): Promise<{ result: BacktestResult; configFingerprint: string }> {
  const { strategy, config, params, symbolInfos, candlesByKey, buildId } = input;
  const quoteAsset = sharedQuoteAsset(symbolInfos);
  const symbols = symbolInfos.map((i) => i.symbol);
  const { technicals, strategyInterval, decisionInterval, detailInterval, nativeIntervals } =
    replayIntervals(config, params);
  const detailMs = replayIntervalMs(detailInterval);
  const { fromMs, toMs } = params;

  const tickSeries = buildTickSeries(symbols, candlesByKey, detailInterval);
  if (
    !tickSeries.some((s) => s.candles.some((c) => c.openTimeMs >= fromMs && c.closeTimeMs < toMs))
  ) {
    throw new Error(
      `backtest has no ${detailInterval} candles inside the requested range, so there is nothing to replay. Pick a range the symbols traded in.`,
    );
  }

  const dataWarnings = dataCoverageWarnings(
    symbols,
    candlesByKey,
    detailInterval,
    fromMs,
    toMs,
    detailMs,
  );
  // Backfill is per-interval best-effort, so a gap in the strategy series is not covered by the detail check.
  if (strategyInterval !== detailInterval) {
    dataWarnings.push(
      ...dataCoverageWarnings(
        symbols,
        candlesByKey,
        strategyInterval,
        fromMs,
        toMs,
        replayIntervalMs(strategyInterval),
      ),
    );
  }
  // Modelling caveats go to `modelNotes`, not `dataWarnings`: they say where the replay departs from live, and the live gate fails a run on any data warning.
  const modelNotes = [
    ...missingDetailNotes(symbols, candlesByKey, detailInterval, fromMs, toMs, detailMs),
    ...REPLAY_LIMITATIONS,
  ];
  if (detailInterval === strategyInterval) {
    modelNotes.push(
      `detail interval equals strategy interval (${strategyInterval}); intra-candle fill ordering is assumed favorably, so grid round-trips inside one bar may be slightly optimistic. Set a finer detail interval to remove the ambiguity`,
    );
  }
  if (
    strategy.capabilities.exitsWithinCandle === true &&
    replayIntervalMs(decisionInterval) > replayIntervalMs(MINUTE_INTERVAL)
  ) {
    modelNotes.push(
      `this strategy exits within a candle (live sells on 1-minute prices), but this run decides every ${decisionInterval}, so that exit reacts later than live. Set the decision interval to 1m to replay it minute by minute`,
    );
  }
  // Data warnings, not model notes, so the live gate keeps refusing a run whose fills are free: the form seeds both knobs, but an MCP or API caller can omit them.
  if (params.spreadBps == null) {
    dataWarnings.push(
      'no spread haircut modeled (spreadBps unset); fills cross the bid/ask for free, so results are mildly optimistic vs a run with a spread. Set spreadBps to model it',
    );
  }
  if (params.volumeCapPct == null) {
    dataWarnings.push(
      'no volume-participation cap (volumeCapPct unset); a single order can clear a thin bar whole at one price, which live liquidity would not allow. Set volumeCapPct to model participation limits',
    );
  }
  // Only bars inside the range: the long indicator horizon would inflate the highest close the minimum-quantity check prices against.
  const strategyBarsInRange = new Map(
    symbols.map((symbol) => [
      `${symbol}|${strategyInterval}`,
      (candlesByKey.get(`${symbol}|${strategyInterval}`) ?? []).filter(
        (c) => c.openTimeMs >= fromMs && c.openTimeMs < toMs,
      ),
    ]),
  );
  dataWarnings.push(
    ...orderFeasibilityWarnings(
      strategy,
      config,
      symbolInfos,
      strategyBarsInRange,
      strategyInterval,
      params.initialQuoteBalance,
    ),
  );

  const dataFingerprint = dataFingerprintOf(candlesByKey, symbolInfos, toMs);
  const contextFingerprint = createHash('sha256')
    .update(
      canonicalJson({
        market: marketOf(params),
        seed: 0,
        strategyName: strategy.name,
        strategyVersion: strategy.version,
        buildId,
        engineRevision: BACKTEST_ENGINE_REVISION,
        dataFingerprint,
      }),
    )
    .digest('hex');

  const totalFrames = Math.floor((toMs - fromMs) / detailMs);
  let lastPct = -1;
  const signalCache = new LruSignalCache();
  const bundleCursor = new Map<string, number>();
  const windowCursor = new Map<string, number>();
  const windowCap = resolveCandleWindow(strategy.requiredWindow?.(config));

  const report = await runBacktest({
    strategy,
    config,
    dataSource: cooperativeDataSource(
      arrayMarketDataSource(tickSeries),
      input.cpuShare !== undefined ? { cpuShare: input.cpuShare } : {},
    ),
    fillModel: new OhlcvFillModel({
      makerBps: params.fees.makerBps,
      takerBps: params.fees.takerBps,
      slippageBps: params.slippageBps,
      spreadBps: params.spreadBps ?? 0,
      volumeCapPct: params.volumeCapPct ?? null,
    }),
    request: {
      symbols,
      intervals: unique([detailInterval, ...nativeIntervals]),
      fromMs,
      toMs,
    },
    initialBalances: { [quoteAsset]: params.initialQuoteBalance },
    quoteAsset,
    symbolInfos,
    decisionClock: { intervalMs: replayIntervalMs(decisionInterval), strategyInterval },
    // Cede the loop before the CPU-bound metric pass so a long run's heartbeat survives the gap after the last tick's yield.
    onBeforeMetrics: () => new Promise<void>((resolve) => setImmediate(resolve)),
    buildBundle: ({ symbol, asOfMs }) =>
      buildBundle(
        strategy,
        technicals,
        candlesByKey,
        symbol,
        asOfMs,
        signalCache,
        bundleCursor,
        params.discoveryMode,
      ),
    auxiliaryWindows: ({ symbol, asOfMs }) =>
      Object.fromEntries(
        nativeIntervals.map((interval) => {
          const key = `${symbol}|${interval}`;
          const cap =
            interval === DAILY_INTERVAL ? Math.max(windowCap, REGIME_WINDOW_CAP) : windowCap;
          return [
            interval,
            closedWindowAsOf(candlesByKey.get(key) ?? [], asOfMs, windowCursor, key, cap),
          ];
        }),
      ),
    onProgress: (processed) => {
      // Checked first so an abandoned run stops promptly; the engine calls this synchronously, so the throw rejects the run.
      if (input.shouldCancel?.()) throw new BacktestCancelledError('in-flight');
      const pct = Math.min(99, Math.floor((processed / totalFrames) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        input.onProgress?.({ pct, phase: 'replay', processed, total: totalFrames });
      }
    },
    ...(input.onEquityMark ? { onEquityMark: input.onEquityMark } : {}),
  });

  input.onProgress?.({ pct: 99, phase: 'finalize' });

  const result = {
    params,
    metrics: report.metrics,
    equityCurve: [...report.equityCurve],
    drawdownSeries: [...report.drawdownSeries],
    trades: report.trades.map((t) => ({ ...t })),
    roundTrips: report.roundTrips.map((r) => ({ ...r })),
    perSymbol: [...report.perSymbol],
    decisionBreakdown: {
      metrics: report.decisionBreakdown.metrics.map((m) => ({ ...m, tags: { ...m.tags } })),
      logs: [...report.decisionBreakdown.logs],
    },
    dataWarnings,
    modelNotes,
    regimeBreakdown: report.regimeBreakdown.map((r) => ({ ...r })),
    outOfSample: report.outOfSample ? { ...report.outOfSample } : null,
    // The results UI attributes each entry-blocker to the exact setting that armed it, which the override alone cannot name for a base-config gate.
    resolvedConfig: config as Record<string, unknown>,
    simulation: {
      engineRevision: BACKTEST_ENGINE_REVISION,
      buildId,
      strategyName: strategy.name,
      strategyVersion: strategy.version,
      decisionInterval,
      dataFingerprint,
      contextFingerprint,
    },
  } as BacktestResult;
  return { result, configFingerprint: configFingerprint(config) };
}
