import type { Logger } from 'pino';
import {
  TechnicalsBundleConfigSchema,
  type BacktestParams,
  type BacktestProgressUpdate,
  type BacktestResult,
  type TechnicalsBundleConfig,
  type TechnicalsIntervalSignal,
  type TechnicalsSignal,
} from '@app/contracts';
import { intervalToMs, repo, type Database } from '@app/db';
import type { BinanceRestClient } from '@app/binance';
import { computeTechnicalsRating } from '@app/indicators/rating';
import type {
  AccountSnapshot,
  AnyStrategy,
  Candle,
  CandleInterval,
  StrategyRegistry,
  SymbolInfo,
} from '@app/strategy-core';
import { configFingerprint, mergeConfig } from '@app/strategy-core';
import { reserveAdjustedBalance } from 'lib/reserve.js';
import { orderFeasibilityWarnings } from './order-feasibility-warnings.js';
import {
  arrayMarketDataSource,
  runBacktest,
  OhlcvFillModel,
  type MarketDataSource,
  type MarketTick,
  type SymbolCandles,
} from '@app/strategy-backtest';
import { backfillCandles } from './candle-backfill.js';
import type { CandleCache } from './candle-cache.js';
import type { SignalCache } from './signal-cache.js';
import { ratingToSignal } from 'technicals/rating-to-signal.js';
import {
  prepareTechnicalsRatingWindow,
  TECHNICALS_SOURCE_CANDLE_LIMIT,
} from 'technicals/rating-window.js';
import {
  BUNDLE_PROVIDER_ENTRY_HINT,
  BUNDLE_PROVIDER_OVERRIDE,
  BUNDLE_PROVIDER_TECHNICALS,
} from 'tick/bundle-providers.js';

/** Thrown to abort an in-flight replay when the run is cancelled out-of-band. */
export class BacktestCancelledError extends Error {
  constructor(runId: string) {
    super(`backtest run cancelled: ${runId}`);
    this.name = 'BacktestCancelledError';
  }
}

// Candles loaded before the requested window so the first traded candle's
// indicators are already warm. 200 covers the longest indicator period (EMA200).
const WARMUP_CANDLES = 200;

// The daily regime candle is always materialised and fed into the strategy's
// market snapshot, mirroring the live worker (subscriptions-manager subscribes
// the daily candle for every symbol). Without it a daily-regime gate — TT's
// unified `regime` block, which reads `market.candlesByInterval['1d']` — is
// inert in backtest while firing live. Strategy-agnostic: the runner reads no
// strategy config, it just always provides the daily window.
const REGIME_DAILY_INTERVAL = '1d' as const;
// Trailing daily candles fed to the regime window — covers the longest regime
// MA period (200) plus confirmation bars, matching the rating-window discipline.
const REGIME_WINDOW_CAP = 250;
// Extra history loaded for the daily regime interval. The strategy-interval
// warmup (200 * intervalMs) is far too short for a daily MA on a sub-daily
// backtest (200 * 1h ≈ 8 days), which would leave a daily-regime gate
// 'unavailable' for almost the whole run. Load ~220 days so a 200-day MA is
// already warm at the window start.
const REGIME_DAILY_WARMUP_MS = 220 * 86_400_000;

// Tick-count ceiling between cooperative event-loop yields during replay. The
// engine drives a tight `for await` over the data source; a sub-second per-tick
// cost over a long range otherwise pins the event loop for minutes, starving the
// worker's heartbeat (the process reads as "down" though it is busy), the
// throttled progress writes (run stuck at 0%), and BullMQ lock renewal (false
// stall + re-delivery) — and on a combined live+study process, live ticks cannot
// interleave. A time budget (below) yields far sooner when ticks are slow; this
// count is the fallback so a fast run still yields at a bounded cadence.
const YIELD_EVERY_TICKS = 256;

// Wall-clock budget between yields. The real risk is elapsed time, not tick
// count: one slow tick can be tens of ms, so yielding on time keeps the gap
// well under the 60s heartbeat refresh regardless of per-tick cost, while a fast
// run coalesces many cheap ticks into one yield (the count ceiling still caps it).
const YIELD_INTERVAL_MS = 50;

// When throttled (cpuShare < 1) the yield budget shrinks so each work quantum,
// and therefore each proportional sleep, is smaller — bounding the latency spike
// a co-resident api/live process sees between yields under ROLE=all.
const THROTTLED_YIELD_INTERVAL_MS = 20;

/**
 * Sleep to hold the replay to a `cpuShare` fraction of one core: after `workMs`
 * of work, sleep long enough that work / (work + sleep) == cpuShare. share >= 1
 * means full speed (no sleep, the caller uses a bare macrotask yield instead).
 * Pure arithmetic, exported for a focused unit test.
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
 * Wrap a {@link MarketDataSource} so the replay cedes the event loop whenever
 * the yield budget of wall-clock has elapsed since the last yield, OR every
 * `everyN` ticks as a fallback. At full speed (`cpuShare` >= 1) the yield is a
 * bare macrotask ({@link setImmediate}); under a throttle (`cpuShare` < 1) it
 * sleeps proportionally (see {@link throttleSleepMs}) so a CPU-bound study
 * replay leaves headroom for a co-resident api/live process in ROLE=all. Pure
 * scheduling: the same ticks stream in the same order (a yield never drops or
 * reorders a tick), so the engine's report and the golden replay are unchanged.
 * `Date.now()` is read at this worker seam, not inside the pure engine. Exported
 * for a focused unit test of the yield cadence.
 */
export function cooperativeDataSource(
  inner: MarketDataSource,
  options: CooperativeYieldOptions = {},
): MarketDataSource {
  const cpuShare = options.cpuShare ?? 1;
  const everyN = options.everyN ?? YIELD_EVERY_TICKS;
  const intervalMs =
    options.intervalMs ?? (cpuShare < 1 ? THROTTLED_YIELD_INTERVAL_MS : YIELD_INTERVAL_MS);
  return {
    stream(req) {
      const upstream = inner.stream(req);
      async function* gen(): AsyncGenerator<MarketTick> {
        let sinceYield = 0;
        let lastYieldMs = Date.now();
        for await (const tick of upstream) {
          const now = Date.now();
          if (++sinceYield >= everyN || now - lastYieldMs >= intervalMs) {
            const sleepMs = throttleSleepMs(now - lastYieldMs, cpuShare);
            await (sleepMs > 0
              ? new Promise<void>((resolve) => setTimeout(resolve, sleepMs))
              : new Promise<void>((resolve) => setImmediate(resolve)));
            sinceYield = 0;
            // Re-read after the sleep so the next quantum measures work, not rest.
            lastYieldMs = Date.now();
          }
          yield tick;
        }
      }
      return gen();
    },
  };
}

/**
 * Daily regime window as of `asOfMs`, advanced through a forward-only per-symbol
 * cursor. Returns ONLY candles closed at or before `asOfMs` (no lookahead),
 * capped to the trailing {@link REGIME_WINDOW_CAP}. `asOfMs` is monotonic within a
 * run, so the cursor makes this O(1) amortised. Exported so the no-lookahead and
 * cap guarantees are unit-testable without driving the whole engine.
 */
export function regimeWindowAsOf(
  daily: readonly Candle[],
  asOfMs: number,
  cursor: Map<string, number>,
  cursorKey: string,
): Candle[] {
  let count = cursor.get(cursorKey) ?? 0;
  while (count < daily.length && (daily[count]?.closeTimeMs ?? Infinity) <= asOfMs) count++;
  cursor.set(cursorKey, count);
  return daily.slice(Math.max(0, count - REGIME_WINDOW_CAP), count);
}

/**
 * Count the ticks that actually trade: the engine consumes the first `warmup`
 * candles per symbol without firing a tick, so a run's tradeable length is the
 * candle total minus warm-up, floored at 0 per symbol. Progress is reported
 * against this, and a result of 0 means the range is too short to trade at all.
 */
export const tradeableTickCount = (tickSeries: readonly SymbolCandles[], warmup: number): number =>
  tickSeries.reduce((n, s) => n + Math.max(0, s.candles.length - warmup), 0);

export interface BacktestRunnerDeps {
  readonly db: Database;
  /** Governor-wired, keyless klines fetch for candle backfill. */
  readonly getKlines: BinanceRestClient['getKlines'];
  readonly getSymbolInfo: (symbol: string) => Promise<SymbolInfo>;
  readonly strategies: StrategyRegistry;
  readonly clock: { nowMs(): number };
  readonly logger: Logger;
  /**
   * Fraction of one core the replay may use, in (0, 1]. Under ROLE=all the study
   * consumer shares the event loop with api + live trading, so a full-speed
   * CPU-bound replay would starve them; a share < 1 makes the runner sleep
   * proportionally at its yield points. Default 1 (full speed) when omitted, so
   * a dedicated `study`/`worker` process keeps current behaviour.
   */
  readonly cpuShare?: number;
  /**
   * Shared, bounded signal cache. The technicals signal (minus its read-time
   * timestamp) is config-independent, so passing one cache across separate
   * backtest runs over the same window derives each (symbol, interval, window)
   * signal once for the process instead of once per run. Omitted (e.g. in tests,
   * or a one-off run) falls back to a per-run `Map`, preserving single-run
   * memoisation.
   */
  readonly signalCache?: SignalCache;
  /**
   * Shared, bounded candle-window cache. The source candles for a (symbol,
   * interval, range) are config-independent, so passing one cache across
   * separate backtest runs over the same window loads and materialises it once
   * for the process instead of re-reading Postgres and rebuilding the `Candle[]`
   * per run. Omitted (tests, one-off runs) loads per run as before.
   */
  readonly candleCache?: CandleCache;
}

export interface RunProfileBacktestArgs {
  readonly params: BacktestParams;
  readonly strategyName: string;
  /** The profile's base strategy config (jsonb); merged with the run override. */
  readonly profileConfig: unknown;
  /**
   * Per-symbol base-asset reserve (decimal-string) keyed by symbol, from
   * `profile_symbols`. Mirrors the live per-tick reserve overlay so backtest
   * sell-sizing trades only the surplus above the reserve — without this, a
   * backtest on a reserved symbol over-sells relative to live. Absent symbols
   * (or a null value) leave that symbol's account untouched.
   */
  readonly reserveBySymbol?: ReadonlyMap<string, string | null>;
  /** Throttled progress callback: percent plus phase/count detail. */
  readonly onProgress?: (update: BacktestProgressUpdate) => void;
  /**
   * Cooperative-cancellation probe. The worker polls the run status and flips
   * the backing flag; checked cheaply on each progress callback. When it returns
   * true the replay throws {@link BacktestCancelledError} and rejects, so an
   * abandoned run stops instead of computing a result no longer needed.
   */
  readonly shouldCancel?: () => boolean;
}

const rowToCandle = (r: {
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}): Candle => ({
  openTimeMs: r.openTime.getTime(),
  closeTimeMs: r.closeTime.getTime(),
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  isClosed: true,
});

/**
 * Orchestrate one profile backtest: ensure the candle store covers the
 * range, replay the strategy through the engine over a shared account, and
 * map the engine report to the wire {@link BacktestResult}.
 *
 * Config: the profile's base config merged with the run's override and parsed
 * by the strategy. v1.0 applies one config across all symbols (the engine's
 * model); per-symbol config for a multi-symbol portfolio is a follow-up.
 */
export async function runProfileBacktest(
  deps: BacktestRunnerDeps,
  args: RunProfileBacktestArgs,
): Promise<{ result: BacktestResult; configFingerprint: string }> {
  const { params } = args;
  const strategy = deps.strategies.get(args.strategyName);
  if (!strategy) throw new Error(`unknown strategy: ${args.strategyName}`);

  // Parse the stored profile config to its full default-filled shape BEFORE
  // merging the run's override, then parse the merged result. Parsing the base
  // first matters for numeric overrides: mergeConfig only coerces a numeric
  // override to a decimal-string when the matching base key already holds a
  // string, so a brand-new decimal-string field (absent in a config serialised
  // before that field shipped) would otherwise reach the schema as a raw number
  // and fail the run. A stored config that no longer satisfies the schema
  // fails at the first parse and surfaces as a clean `backtest_runs.error`.
  const baseConfig = strategy.configSchema.parse(args.profileConfig);
  const config = strategy.configSchema.parse(
    mergeConfig(baseConfig, params.strategyConfigOverride ?? {}),
  );

  const symbolInfos = await Promise.all(params.symbols.map((s) => deps.getSymbolInfo(s)));
  // Equity is denominated in one quote asset; a basket mixing quotes (e.g.
  // BTCUSDT + ETHBTC) cannot be valued on a single curve, so reject it cleanly.
  const quoteAsset = symbolInfos[0]?.quoteAsset ?? '';
  if (!symbolInfos.every((i) => i.quoteAsset === quoteAsset)) {
    throw new Error('backtest symbols must share one quote asset');
  }

  // Intervals to materialise: the strategy (tick) interval, the finer detail
  // interval the OHLCV model crosses orders against (timeframe-detail), and
  // every technicals interval the config references (for the bundle signals).
  // `detailInterval` is schema-guaranteed finer than or equal to the strategy
  // interval; when equal, the detail series is the coarse series itself.
  const tvConfig = readTechnicalsConfig(config);
  const tvIntervals = tvConfig ? tvConfig.intervals.map((i) => i.interval as CandleInterval) : [];
  const tvIntervalSet = new Set<CandleInterval>(tvIntervals);
  // The strategy decides on the interval its OWN config declares (`candleInterval`),
  // and the strategy reads `market.candlesByInterval[config.candleInterval]`. Live
  // derives its feed the same way (`feedIntervals(candleInterval)` /
  // tick-context.ts), so streaming the config's interval is what makes a backtest
  // mirror live. `params.strategyInterval` is advisory only: a value that disagrees
  // with the config would stream one interval while the strategy reads another,
  // feeding it an empty window with no error. Fall back to the param only for a
  // strategy that declares no `candleInterval`.
  const strategyInterval =
    readConfigInterval(config) ?? (params.strategyInterval as CandleInterval);
  const detailInterval = params.detailInterval as CandleInterval;
  const allIntervals = unique([
    strategyInterval,
    detailInterval,
    REGIME_DAILY_INTERVAL,
    ...tvIntervals,
  ]);

  const warmupMs = WARMUP_CANDLES * intervalToMs(strategyInterval);
  const loadFromMs = params.fromMs - warmupMs;

  // Raw consumers keep the historical replay horizon. Technicals keeps the
  // longer source needed to match the live 999-clock-bar normalization.
  const candlesByKey = new Map<string, Candle[]>();
  const technicalsCandlesByKey = new Map<string, Candle[]>();
  for (const symbol of params.symbols) {
    // Backfill phase: loading price history. Emitted per symbol so the live UI
    // shows which market is loading rather than a bar wedged near 0.
    args.onProgress?.({ pct: 0, phase: 'backfill', symbol });
    for (const interval of allIntervals) {
      // The daily regime interval loads from a daily-appropriate horizon so a
      // long regime MA is warm at the window start; every other interval uses
      // the strategy-interval warmup.
      const rawFromMs =
        interval === REGIME_DAILY_INTERVAL
          ? Math.min(loadFromMs, params.fromMs - REGIME_DAILY_WARMUP_MS)
          : loadFromMs;
      const intervalFromMs = tvIntervalSet.has(interval)
        ? Math.min(
            rawFromMs,
            params.fromMs - TECHNICALS_SOURCE_CANDLE_LIMIT * intervalToMs(interval),
          )
        : rawFromMs;
      // Range embedded in the key so a different window (range/symbols) can't
      // collide; separate runs over the same window share the key and load once.
      // A hit skips backfill safely: the cached array is the already-backfilled,
      // already-materialised window from the first run, so re-running the
      // Postgres gap-fill would be redundant, not load-bearing.
      const cacheKey = `${symbol}|${interval}|${intervalFromMs}|${params.toMs}`;
      let candles = deps.candleCache?.get(cacheKey);
      if (!candles) {
        await backfillCandles(
          {
            getKlines: deps.getKlines,
            findGaps: (s, i, f, t) => repo.candles.findGaps(deps.db, s, i, f, t),
            insertCandles: (rows) => repo.candles.insertNew(deps.db, rows),
            clock: deps.clock,
            logger: deps.logger,
          },
          { symbol, interval, fromMs: intervalFromMs, toMs: params.toMs },
        );
        const rows = await repo.candles.getRange(
          deps.db,
          symbol,
          interval,
          new Date(intervalFromMs),
          new Date(params.toMs),
        );
        candles = rows.map(rowToCandle);
        // Pin a window only when backfill reached the last closed bar. Binance
        // returns the next available candle across genuine holes and an empty
        // page only at true end-of-data, so a window that stops short of the
        // last closed bar means backfill bailed early (a transient empty page
        // mid-gap). Caching that would pin the sparse fetch for the whole
        // process-lifetime candle cache, denying every later run a refetch.
        // The replay itself still uses `candles` below — only cross-run reuse
        // is gated, so the golden result is unchanged.
        const tailComplete = windowReachesLastClosedBar(
          candles,
          intervalFromMs,
          params.toMs,
          deps.clock.nowMs(),
          intervalToMs(interval),
        );
        if (tailComplete) {
          deps.candleCache?.set(cacheKey, candles);
        } else {
          deps.logger?.warn(
            { symbol, interval },
            'backtest: candle window stops before the last closed bar; not caching so a later run can refetch the tail',
          );
        }
      }
      const key = `${symbol}|${interval}`;
      if (tvIntervalSet.has(interval)) technicalsCandlesByKey.set(key, candles);
      candlesByKey.set(
        key,
        intervalFromMs === rawFromMs
          ? candles
          : candles.filter((candle) => candle.openTimeMs >= rawFromMs),
      );
    }
  }

  const tickSeries = buildTickSeries(
    params.symbols,
    candlesByKey,
    strategyInterval,
    detailInterval,
  );

  // Data-quality check: a symbol whose strategy-interval candles do not span the
  // requested range (delisting, halt, thin history) backtests on a partial
  // window, and a basket silently survivor-biases toward the symbols that traded
  // the whole time. Surface the shortfall rather than reporting clean metrics.
  const dataWarnings = dataCoverageWarnings(
    params.symbols,
    candlesByKey,
    strategyInterval,
    params.fromMs,
    params.toMs,
    intervalToMs(strategyInterval),
  );
  // Intra-candle fidelity caveat: with no finer detail bars than the strategy
  // interval, a resting BUY (low < limit) and SELL (high > limit) can both fill
  // within one candle regardless of the true tick order, so a grid can book a
  // buy-low → sell-high round-trip the sequence may not have allowed — mildly
  // optimistic. Surface it rather than silently pricing it in; a finer
  // detailInterval removes the ambiguity.
  if (detailInterval === strategyInterval) {
    dataWarnings.push(
      `detail interval equals strategy interval (${strategyInterval}); intra-candle fill ordering is assumed favorably, so grid round-trips inside one bar may be slightly optimistic — set a finer detail interval to remove the ambiguity`,
    );
  }
  // Frictionless-fill caveat: an unset spread/volume-cap makes fills more
  // optimistic than live. `null` collapses to "not modeled" in the fill model
  // (spreadFactor 1, no participation cap), so a run cloned or re-run from a
  // base serialised before these knobs existed prices no bid/ask cost and lets
  // one order clear a thin bar whole — surface it rather than reporting the
  // rosier number as clean. New form runs seed both, so this fires only on
  // legacy runs.
  if (params.spreadBps == null) {
    dataWarnings.push(
      'no spread haircut modeled (spreadBps unset); fills cross the bid/ask for free, so results are mildly optimistic vs a run with a spread — set spreadBps to model it',
    );
  }
  if (params.volumeCapPct == null) {
    dataWarnings.push(
      'no volume-participation cap (volumeCapPct unset); a single order can clear a thin bar whole at one price, which live liquidity would not allow — set volumeCapPct to model participation limits',
    );
  }
  // A config whose orders size below the symbol's exchange minimum, or whose grid
  // the starting balance cannot fully fund, never places most of its buys, so the
  // run's metrics are meaningless. A manual run is already rejected at create; a
  // run enqueued outside that gate keeps running but must carry the warning.
  dataWarnings.push(
    ...orderFeasibilityWarnings(
      strategy,
      config,
      symbolInfos,
      candlesByKey,
      strategyInterval,
      params.initialQuoteBalance,
    ),
  );

  // Progress is reported against tradeable ticks, not the raw candle count: the
  // first WARMUP_CANDLES per symbol fire no tick, so a coarse strategy interval
  // over a short range is warm-up dominated and dividing by the raw count pins
  // the percentage near 0 — the run looks wedged though it is running (#334).
  const totalTicks = tradeableTickCount(tickSeries, WARMUP_CANDLES);
  // Zero tradeable ticks means warm-up consumed every candle. Surface it loudly
  // rather than completing with a silent empty result that reads as a hang.
  if (totalTicks === 0) {
    throw new Error(
      'backtest range too short for the warm-up window: every candle is consumed warming up ' +
        'indicators, leaving nothing to trade. Widen the date range or use a finer strategyInterval.',
    );
  }
  let lastPct = -1;

  // Warm-up phase: the engine consumes the first WARMUP_CANDLES per symbol with
  // no tradeable tick, so the replay onProgress stays silent until trading
  // begins. Announce the phase up front so the UI shows "warming up" instead of
  // a bar stuck at 0% for the whole warm-up window (#334). No count is sent: the
  // "candle X of Y" view only applies once replay starts.
  args.onProgress?.({ pct: 0, phase: 'warmup' });

  // Signal cache keyed by (symbol, interval, window): a technicals interval
  // coarser than the strategy tick derives its signal once per candle instead of
  // once per tick. A shared cache (deps.signalCache) further reuses the signal
  // across separate runs over the same window, since it does not depend on the
  // config; without one, a per-run Map keeps the single-run memoisation.
  const signalCache: SignalCache = deps.signalCache ?? new Map<string, TechnicalsSignal>();
  // Forward-only window cursor per (symbol, interval): asOfMs advances
  // monotonically within a run, so the per-tick window is a slice off a moving
  // index instead of an O(total-history) re-filter. Per-run (reset each call).
  const windowCursor = new Map<string, number>();
  // Forward-only cursor for the daily regime window fed via auxiliaryWindows,
  // keyed by symbol (the interval is fixed). Same monotonic-asOf slice as the
  // bundle's signal cursor, so per-tick cost is O(1) amortised, no lookahead.
  const regimeCursor = new Map<string, number>();

  // Reserve overlay: mirror the live worker's per-tick `applyReserveToBase` so a
  // backtest on a symbol with an operator reserve sells only the surplus above
  // it. Applied to the account the strategy sees each tick, per the ticked
  // symbol's base reserve. Undefined (identity) when no symbol carries a reserve.
  const baseAssetBySymbol = new Map(symbolInfos.map((i) => [i.symbol, i.baseAsset]));
  const reserveBySymbol = args.reserveBySymbol;
  const hasAnyReserve = reserveBySymbol
    ? [...reserveBySymbol.values()].some((r) => r !== null && r !== '')
    : false;
  const adjustAccount = hasAnyReserve
    ? (account: AccountSnapshot, symbol: string): AccountSnapshot => {
        const reserve = reserveBySymbol?.get(symbol) ?? null;
        const baseAsset = baseAssetBySymbol.get(symbol);
        const bal = baseAsset ? account.balances[baseAsset] : undefined;
        if (reserve === null || reserve === '' || !baseAsset || !bal) return account;
        const adjusted = reserveAdjustedBalance(bal.free, bal.locked, reserve);
        return {
          ...account,
          balances: { ...account.balances, [baseAsset]: { ...bal, ...adjusted } },
        };
      }
    : undefined;

  const report = await runBacktest({
    strategy: strategy as AnyStrategy,
    config,
    dataSource: cooperativeDataSource(arrayMarketDataSource(tickSeries), {
      ...(deps.cpuShare !== undefined ? { cpuShare: deps.cpuShare } : {}),
    }),
    fillModel: new OhlcvFillModel({
      makerBps: params.fees.makerBps,
      takerBps: params.fees.takerBps,
      slippageBps: params.slippageBps,
      // `?? 0`, not a bare pass-through: spreadBps is optional in the contract and
      // the model option is `spreadBps?: number`, so under exactOptionalPropertyTypes
      // an explicit `undefined` is not assignable. Absent means no spread = 0.
      spreadBps: params.spreadBps ?? 0,
      volumeCapPct: params.volumeCapPct ?? null,
    }),
    request: {
      symbols: params.symbols,
      intervals: allIntervals,
      fromMs: params.fromMs,
      toMs: params.toMs,
    },
    initialBalances: { [quoteAsset]: params.initialQuoteBalance },
    quoteAsset,
    symbolInfos,
    ...(adjustAccount ? { adjustAccount } : {}),
    // Cede the loop before the engine's CPU-bound metric pass so a long run's
    // heartbeat / lock renewal survives the gap after the last tick's yield.
    onBeforeMetrics: () => new Promise<void>((resolve) => setImmediate(resolve)),
    startupCandleCount: WARMUP_CANDLES,
    buildBundle: ({ symbol, window }) =>
      buildBundle(
        strategy,
        tvConfig,
        technicalsCandlesByKey,
        symbol,
        lastClose(window),
        signalCache,
        windowCursor,
        params.discoveryMode,
      ),
    auxiliaryWindows: ({ symbol, asOfMs }) => {
      // When the strategy already trades daily the engine streams '1d' itself —
      // nothing to add (and the engine would override an aux '1d' anyway).
      if (strategyInterval === REGIME_DAILY_INTERVAL) return {};
      const daily = candlesByKey.get(`${symbol}|${REGIME_DAILY_INTERVAL}`) ?? [];
      return { [REGIME_DAILY_INTERVAL]: regimeWindowAsOf(daily, asOfMs, regimeCursor, symbol) };
    },
    onProgress: (processed) => {
      // Cancellation is checked first so an abandoned run stops promptly.
      // runBacktest invokes this synchronously inside the replay loop, so a
      // throw here aborts the loop and rejects the run.
      if (args.shouldCancel?.()) throw new BacktestCancelledError('in-flight');
      const pct = Math.min(99, Math.floor((processed / totalTicks) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        args.onProgress?.({ pct, phase: 'replay', processed, total: totalTicks });
      }
    },
  });

  // Finalize phase: the engine returned; metrics are computed and the result is
  // assembled below. complete() will set progress to 100.
  args.onProgress?.({ pct: 99, phase: 'finalize' });

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
    regimeBreakdown: report.regimeBreakdown.map((r) => ({ ...r })),
    outOfSample: report.outOfSample ? { ...report.outOfSample } : null,
    // The effective merged config this run executed, so the results UI attributes
    // each entry-blocker to the exact setting that armed it (the override alone
    // carries only changed keys; a base-config gate would otherwise go unnamed).
    resolvedConfig: config as Record<string, unknown>,
  } as BacktestResult;
  // Stamp the run with the effective merged config it executed, so the
  // live-enablement gate can confirm a backtest tested the live config.
  return { result, configFingerprint: configFingerprint(config) };
}

// Coverage threshold below which a symbol's candle history is flagged as too
// sparse to trust. Set just under 1 so routine boundary rounding (a candle or
// two at the window edges) does not raise a false warning, while a real gap
// (delisting, multi-day halt) trips it.
const COVERAGE_WARN_THRESHOLD = 0.95;

// A contiguous run of this many missing strategy-interval candles is flagged
// even when overall coverage clears the aggregate threshold: a single multi-bar
// hole (a halt/delisting with a price discontinuity across it) is the dangerous
// shape the position-blind ratio hides in a long window.
const MAX_CONTIGUOUS_GAP_BARS = 12;

/**
 * Per-symbol warnings when strategy-interval candle coverage in [fromMs, toMs)
 * falls below {@link COVERAGE_WARN_THRESHOLD} of the bars the range should hold.
 * Counts only candles opening inside the window (warm-up history loaded before
 * `fromMs` is excluded). Exported for unit testing without driving the engine.
 */
export function dataCoverageWarnings(
  symbols: readonly string[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  strategyInterval: CandleInterval,
  fromMs: number,
  toMs: number,
  intervalMs: number,
): string[] {
  const expected = Math.floor((toMs - fromMs) / intervalMs);
  if (expected <= 0) return [];
  const warnings: string[] = [];
  for (const symbol of symbols) {
    // candlesByKey values are ascending, so the filtered slice stays ordered.
    const inWindow = (candlesByKey.get(`${symbol}|${strategyInterval}`) ?? []).filter(
      (c) => c.openTimeMs >= fromMs && c.openTimeMs < toMs,
    );
    if (inWindow.length / expected < COVERAGE_WARN_THRESHOLD) {
      const pct = Math.round((inWindow.length / expected) * 100);
      warnings.push(
        `${symbol}: only ${pct}% of the expected ${strategyInterval} candles are present ` +
          `(${inWindow.length}/${expected}). Possible delisting, trading halt, or thin liquidity — ` +
          `treat this symbol's results with caution.`,
      );
      continue;
    }
    // The aggregate ratio is position-blind: a single contiguous block can be
    // under the threshold in a long window yet still distort results. Flag the
    // largest run of consecutive missing bars — head, interior, and tail. floor
    // (not round) so an unaligned fromMs/toMs straddling a bar cannot manufacture
    // a phantom missing bar; interior opens are interval-aligned so it is exact.
    const first = inWindow[0];
    if (first) {
      let maxGap = Math.floor((first.openTimeMs - fromMs) / intervalMs); // head gap
      let prevOpen = first.openTimeMs;
      for (const c of inWindow) {
        const missing = Math.floor((c.openTimeMs - prevOpen) / intervalMs) - 1;
        if (missing > maxGap) maxGap = missing;
        prevOpen = c.openTimeMs;
      }
      const tailMissing = Math.floor((toMs - prevOpen) / intervalMs) - 1; // tail gap
      if (tailMissing > maxGap) maxGap = tailMissing;
      if (maxGap >= MAX_CONTIGUOUS_GAP_BARS) {
        warnings.push(
          `${symbol}: a contiguous gap of ${maxGap} ${strategyInterval} candles is missing inside ` +
            `the window — a likely halt or delisting with a price discontinuity across it. Treat ` +
            `this symbol's results with caution.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * True when a loaded window's newest candle reaches the last bar that should be
 * closed by `min(toMs, lastClosedBar)`. A false result means backfill stopped
 * before the window end (e.g. a transient empty page mid-gap), so the window
 * must not be pinned in the cross-run candle cache. Bounded to closed bars:
 * the currently-forming bar is never stored, so a healthy near-now window whose
 * only "gap" is its open tail is not mistaken for a shortfall. Interior holes
 * are tolerated — after a normal backfill they are genuine absence (delisting,
 * halt) that a refetch cannot fill, and refusing to cache them would re-run
 * backfill on every run. Exported for unit testing without driving the engine.
 */
export function windowReachesLastClosedBar(
  candles: readonly Candle[],
  intervalFromMs: number,
  toMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  // Open time of the most recent fully-closed bar: a bar opening at T closes at
  // T + intervalMs, so it is closed once nowMs >= T + intervalMs.
  const lastClosedOpenMs = Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
  // Last grid slot the window must reach. toMs is treated as exclusive
  // (consistent with dataCoverageWarnings' `openTimeMs < toMs` filter): one slot
  // below toMs when toMs is interval-aligned, else the last slot <= toMs.
  // `getRange` is inclusive on toMs, so the store may legitimately hold one bar
  // beyond this — harmless, because the gate below is a `>=` lower bound (never
  // tighten it to `==`). Clamp to the last closed bar: the forming bar is never
  // stored, so a healthy near-now window must not be required to reach it.
  const lastInWindowOpenMs = Math.ceil(toMs / intervalMs) * intervalMs - intervalMs;
  const expectedLastOpenMs = Math.min(lastInWindowOpenMs, lastClosedOpenMs);
  const firstExpectedOpenMs = Math.ceil(intervalFromMs / intervalMs) * intervalMs;
  // Window holds no expected closed bar (sub-interval range, or now before the
  // window): nothing to require, cache freely.
  if (expectedLastOpenMs < firstExpectedOpenMs) return true;
  const last = candles.length > 0 ? candles[candles.length - 1] : undefined;
  return last !== undefined && last.openTimeMs >= expectedLastOpenMs;
}

/**
 * Build the per-symbol tick series the engine replays: each symbol's coarse
 * (strategy-interval) candles, with the finer detail series attached as
 * `detailCandles` for timeframe-detail fills. The detail series is attached
 * only when `detailInterval` is STRICTLY FINER than `strategyInterval`. Equal
 * adds nothing the coarse candle does not; coarser must NOT be attached — a
 * detail bar longer than the strategy candle would group into that candle's
 * bucket and the fill model would cross orders against price action past the
 * candle's close (lookahead). Since the streamed interval is the config's
 * `candleInterval` (not the run param), a caller whose `detailInterval`
 * disagrees (e.g. a run whose `candleInterval` is finer than the detail)
 * is held to the same finer-only rule here rather than at the param validator.
 */
export function buildTickSeries(
  symbols: readonly string[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  strategyInterval: CandleInterval,
  detailInterval: CandleInterval,
): SymbolCandles[] {
  const detailIsFiner = intervalToMs(detailInterval) < intervalToMs(strategyInterval);
  return symbols.map((symbol) => {
    const detail = candlesByKey.get(`${symbol}|${detailInterval}`);
    return {
      symbol,
      interval: strategyInterval,
      candles: candlesByKey.get(`${symbol}|${strategyInterval}`) ?? [],
      ...(detailIsFiner && detail ? { detailCandles: detail } : {}),
    };
  });
}

/**
 * Build the per-tick `{technicals, override}` bundle from loaded candle windows.
 * `signalCache` (optional) memoises the derived signal (the expensive rating plus
 * its projection); pass the same cache for every tick of a backtest, and a shared
 * cache across separate runs to reuse signals between them (the signal minus its
 * timestamp is config-independent). `windowCursor` is the per-run forward-only
 * window index, keyed the same way; pass a fresh `Map` per run.
 *
 * `discoveryMode` (default false): when true and the strategy declares the
 * entry-hint provider, every tick carries an armed entry hint — the same seam
 * the live worker injects from discovery — so backtested entries are marked
 * discovery-managed and exit via the discovery regime (trail/stop/time-stop,
 * no technicals force-sell). Off-mode emits nothing, byte-identical to before.
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
      // Advance the forward-only cursor to the count of candles closed by asOfMs
      // (the series is ascending by closeTimeMs, and asOfMs is monotonic per
      // run), then take the bounded raw source, O(1) amortised instead of
      // re-filtering the whole history each tick. Without a cursor (no shared
      // state) fall back to a one-shot scan from 0.
      const cursorKey = `${symbol}|${interval}`;
      let count = windowCursor?.get(cursorKey) ?? 0;
      while (count < all.length && (all[count]?.closeTimeMs ?? Infinity) <= asOfMs) count++;
      windowCursor?.set(cursorKey, count);
      // Keep the cache identity on the raw clock-bar source. Filtering sparse
      // bars is only needed on a miss, and cannot make two raw windows collide.
      const startIdx = Math.max(0, count - TECHNICALS_SOURCE_CANDLE_LIMIT);
      // A window too short to rate yields a null signal — the strategy treats
      // that as "no technicals reading this interval", matching the live path
      // which also degrades to null. (Warm-up makes real ticks long-windowed;
      // this only guards the cold start.)
      try {
        // Memoise the SIGNAL by the interval's window: it does not change until a
        // new candle of this interval closes, so a strategy ticking faster than
        // the interval reuses it instead of re-running ~30 rating indicators, the
        // ema5/sma5 courtesy replays, and the ~33-field Zod parse. Only the
        // freshness timestamp tracks the tick, so it is re-stamped on read (live
        // parity preserved). The key carries BOTH the first and last close so a
        // shared cross-run cache cannot collide a full 250-candle window with a
        // shorter cold-start window that happens to end at the same close. Both
        // close-times are read straight off `all` by index — byte-identical to
        // the old `window.at(-1)` / `window[0]` (asOfMs fallback for count === 0)
        // — so no slice is needed to compute the key.
        const latestClose = count > 0 ? (all[count - 1]?.closeTimeMs ?? asOfMs) : asOfMs;
        const firstClose = count > 0 ? (all[startIdx]?.closeTimeMs ?? asOfMs) : asOfMs;
        const key = `${symbol}|${interval}|${firstClose}|${latestClose}`;
        const cached = signalCache?.get(key);
        if (cached !== undefined) {
          return { interval, signal: { ...cached, receivedAtMs: asOfMs } };
        }
        // Miss: materialise and normalize the bounded source before rating it.
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
  // Discovery mode arms the entry hint on every tick (only `enterOnAdd` — the
  // anti-chase guards default off and are entry-timing, not the exit-regime gap
  // this models). This is the same `entryHint` key the live bundle-builder
  // writes, so a backtested entry stamps `discoveryEntry` and exits via the
  // discovery regime. No reaping is modelled: the hint stays armed all window.
  if (discoveryMode && providers.includes(BUNDLE_PROVIDER_ENTRY_HINT)) {
    bundle['entryHint'] = { enterOnAdd: true };
  }
  return bundle;
}

/**
 * The interval the strategy decides on, read from its resolved config exactly as
 * the live worker reads it (`feed-intervals.ts` / `tick-context.ts` key off
 * `config.candleInterval`). Returns null for a strategy that declares no
 * `candleInterval`, so the caller falls back to the run param. Keeping the
 * backtest's streamed interval equal to the live one is what guarantees the
 * strategy's `candlesByInterval[candleInterval]` reads are populated. Exported
 * for a focused unit test of the resolve/fallback contract.
 *
 * `CandleInterval` is a superset of the fixed-duration intervals the backtest
 * can replay (it also carries calendar intervals like `'1M'`, which `intervalToMs`
 * rejects). A strategy could declare such an interval, so this rejects it at the
 * boundary with a clear message rather than letting it throw mid-backfill.
 */
export function readConfigInterval(config: unknown): CandleInterval | null {
  if (typeof config !== 'object' || config === null) return null;
  const value = (config as { candleInterval?: unknown }).candleInterval;
  // A non-string means the strategy has no candle-interval concept → fall back.
  if (typeof value !== 'string') return null;
  try {
    intervalToMs(value); // the fixed-duration source of truth; throws on e.g. '1M'
  } catch {
    throw new Error(`backtest does not support candle interval: ${value}`);
  }
  return value as CandleInterval;
}

function readTechnicalsConfig(config: unknown): TechnicalsBundleConfig | null {
  if (typeof config !== 'object' || config === null || !('technicals' in config)) return null;
  const parsed = TechnicalsBundleConfigSchema.safeParse(
    (config as { technicals: unknown }).technicals,
  );
  return parsed.success ? parsed.data : null;
}

function lastClose(window: readonly Candle[]): number {
  return window.length > 0 ? (window[window.length - 1]?.closeTimeMs ?? 0) : 0;
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
