import { Decimal } from '@app/money';
import { readsProfileKv, resolveCandleWindow, resolveFill } from '@app/strategy-core';
import type {
  Candle,
  CandleInterval,
  IndicatorSnapshot,
  LogEntry,
  MarketSnapshot,
  MetricEntry,
  PositionStateAdapter,
  PositionView,
  Strategy,
  SymbolInfo,
  TickInput,
} from '@app/strategy-core';
import { SyntheticClock } from './clock.js';
import { createSnapshotComputer } from './snapshot-computer.js';
import { SeededRng } from './rng.js';
import { BacktestExecutor, type DrainedFill } from './executor.js';
import { computeMetrics } from './metrics.js';
import type {
  BacktestReport,
  DecisionBreakdown,
  EquityPoint,
  FillModel,
  MarketDataSource,
  StreamRequest,
} from './types.js';

// Bound the STORED equity/drawdown curves. They carry one point per tick, so a
// long or fine-interval run is hundreds of thousands of points — that bloats the
// result JSONB, every API poll that reads it, and the mobile client that renders
// it (an OOM tab-kill). Metrics (max drawdown + its window, CAGR) are computed on
// the FULL curve BEFORE this cap, so the stored curve only ever feeds the chart,
// which cannot resolve more than this. Evenly spaced, first and last always kept;
// a run at or under the cap is returned untouched (no copy, so the golden and
// short runs are byte-identical).
export const MAX_CURVE_POINTS = 2000;

export const capCurve = <T>(arr: readonly T[]): readonly T[] => {
  if (arr.length <= MAX_CURVE_POINTS) return arr;
  const step = (arr.length - 1) / (MAX_CURVE_POINTS - 1);
  const out: T[] = [];
  // `(x + 0.5) | 0` rounds a non-negative index — `Math` is banned in strategy
  // packages (the Math.random→injected-RNG purity rule). Indices stay well under
  // 2^31, so the 32-bit bitwise truncation is exact.
  for (let i = 0; i < MAX_CURVE_POINTS; i++) out.push(arr[(i * step + 0.5) | 0] as T);
  return out;
};

// Stable key for a metric's tag set so identical (name, tags) emissions bucket
// together regardless of key insertion order.
const canonicalTags = (tags?: Readonly<Record<string, string>>): string =>
  tags
    ? Object.keys(tags)
        .sort()
        .map((k) => `${k}=${tags[k]}`)
        .join(',')
    : '';

// Codepoint compare, not String.localeCompare: the latter is ICU/locale
// dependent and the backtest report must be byte-reproducible across runtimes.
const codepointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface RunBacktestOptions<C, S, B extends Readonly<Record<string, unknown>>> {
  readonly strategy: Strategy<C, S, B>;
  readonly config: C;
  readonly dataSource: MarketDataSource;
  readonly fillModel: FillModel;
  readonly request: StreamRequest;
  /** Opening balances keyed by asset (decimal-strings), e.g. `{ USDT: '1000' }`. */
  readonly initialBalances: Readonly<Record<string, string>>;
  /** Asset the equity curve is denominated in. */
  readonly quoteAsset: string;
  readonly symbolInfos: readonly SymbolInfo[];
  /**
   * Candles consumed for indicator warm-up before any tick fires. The data
   * source is expected to stream this many extra candles before the
   * intended window so the first traded candle already has valid indicators.
   */
  readonly startupCandleCount?: number;
  /** PRNG seed; a fixed seed makes the run byte-identical across executions. */
  readonly seed?: number;
  /**
   * Builds the per-tick strategy bundle (technicals etc.) offline. Defaults
   * to an empty bundle; the indicator/technicals provider injects the real
   * one. Receives the closed-candle window so it can recompute indicators.
   * REQUIRED whenever the strategy declares a non-empty bundle — the default
   * returns `{}`, which a strategy reading bundle fields would see as missing.
   */
  readonly buildBundle?: (args: {
    readonly symbol: string;
    readonly interval: CandleInterval;
    readonly window: readonly Candle[];
  }) => B;
  /**
   * Read-only candle windows for intervals OTHER than the streamed one, merged
   * into `market.candlesByInterval` each tick. Mirrors live, where the worker
   * subscribes the daily regime candle for every symbol on top of the trading
   * interval, so a daily-regime gate (regime filter / regime exit) sees its
   * window in backtest too. The streamed interval always wins on key collision.
   * `asOfMs` is the current candle's closeTime; the provider MUST return only
   * candles closed at or before it (no lookahead). Default: none — the snapshot
   * carries the streamed interval alone, exactly as before.
   */
  readonly auxiliaryWindows?: (args: {
    readonly symbol: string;
    readonly asOfMs: number;
  }) => Partial<Record<CandleInterval, readonly Candle[]>>;
  /**
   * Called once per processed candle with the running count, so a caller that
   * knows the total can report progress. The engine consumes a stream and does
   * not know the total, so it reports a count, not a percentage. Keep the
   * callback cheap (throttle any I/O) — it fires on every candle.
   */
  readonly onProgress?: (processed: number) => void;
  /**
   * Awaited once after the replay loop finishes and BEFORE metrics are computed.
   * The post-loop metric pass (drawdown walk, trade pairing, regime split) is
   * itself CPU-bound; a host that drives long runs injects a macrotask yield here
   * so the worker's heartbeat / lock renewal survives the gap between the last
   * tick's yield and the finished report. Default: none — an omitted hook leaves
   * the run byte-identical (the golden passes nothing), so this cannot shift a
   * result. The engine only awaits the injected function; it does no I/O itself.
   */
  readonly onBeforeMetrics?: () => void | Promise<void>;
  /**
   * Tick the strategy on every detail bar inside a candle while it holds a position, and hand it the bars that closed since its previous tick under `interval`. Live ticks on every price update, so an exit level that moves on 1-minute closes (momentum's profit trail) fires mid-candle; one tick per candle cannot see that. The detail bars must be of `interval` for the strategy to read them as such.
   *
   * Single-symbol only: the within-candle ticks advance the clock inside each candle, so a second symbol would replay its bars after the first symbol's later ones and mutate the shared account out of time order. The loop throws on a second symbol. Default: none, one tick per candle exactly as before.
   */
  readonly intraCandle?: { readonly interval: CandleInterval };
  /**
   * Awaited after each within-candle tick. A held daily candle replays 1,440 minute ticks inside one streamed candle, so a host that shares its process with live trading injects a throttled event-loop yield here, the same one that paces the stream. The engine only awaits the injected function; it does no I/O itself. Default: none.
   */
  readonly onIntraCandleTick?: () => void | Promise<void>;
}

const PROFILE_ID = 'backtest';
const USER_ID = 'backtest';

// Shared immutable Decimal constants, hoisted out of the per-tick hot loop.
// decimal.js Decimals are immutable (every op returns a new instance), so one
// shared ZERO/ONE is safe to reuse as an accumulator seed or a numerator.
const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/**
 * Event-driven backtest over a historical candle stream. Each closed candle
 * advances the simulated clock, is appended to its window, and (past
 * warm-up) drives one `tick()` whose decisions flow through the
 * {@link BacktestExecutor}. State is threaded forward per symbol. Determinism
 * comes from the {@link SyntheticClock} and seeded {@link SeededRng}, so a
 * fixed `(strategy, data, fillModel, seed)` yields a byte-identical report.
 *
 * Precondition: each symbol streams exactly ONE interval (the strategy's
 * configured candleInterval). Per-symbol state, warm-up, and the marked
 * last-price are all symbol-scoped, so two intervals for one symbol would
 * interleave incorrectly; the loop throws rather than silently miscount.
 */
export async function runBacktest<C, S, B extends Readonly<Record<string, unknown>>>(
  opts: RunBacktestOptions<C, S, B>,
): Promise<BacktestReport> {
  const { strategy, config, dataSource, fillModel, request, quoteAsset } = opts;
  const startup = opts.startupCandleCount ?? 0;
  const buildBundle = opts.buildBundle ?? (() => ({}) as B);

  // Rolling candle-window bound per (symbol, interval), derived from the config
  // the SAME way the live tick path sizes its window (resolveCandleWindow over
  // the strategy's requiredWindow), so a config's lookback behaves identically
  // in backtest and live instead of the backtest honouring a longer window.
  const windowCap = resolveCandleWindow(strategy.requiredWindow?.(config));

  const clock = new SyntheticClock(request.fromMs);
  const rng = new SeededRng(opts.seed ?? 0);
  const executor = new BacktestExecutor(fillModel, opts.initialBalances, opts.symbolInfos);

  const symbolInfos = new Map(opts.symbolInfos.map((i) => [i.symbol, i]));
  const intervalOf = new Map<string, CandleInterval>();
  const windows = new Map<string, Candle[]>();
  const states = new Map<string, S>();
  const seen = new Map<string, number>();
  const equityCurve: EquityPoint[] = [];
  // The first requested symbol is the regime benchmark: its post-warm-up close
  // series drives the market-regime attribution and the per-regime buy-and-hold
  // comparator. Single-symbol runs (the live case) align it 1:1 with the equity
  // curve; for a basket it is the primary symbol's regime, labelled as such.
  const benchmarkSymbol = request.symbols[0];
  const benchmarkPrices: { tsMs: number; close: string }[] = [];
  // Portfolio equity sampled on the SAME benchmark cadence as benchmarkPrices, so
  // the regime split compounds the strategy return and the hold return over one
  // shared set of steps. Sampling the full equity curve instead would, for a
  // multi-symbol basket, give the strategy side one step per symbol per candle
  // while hold gets one per candle — not apples-to-apples.
  const benchmarkEquity: EquityPoint[] = [];
  // First/last close per symbol → the buy-and-hold benchmark (market change).
  const firstClose = new Map<string, Decimal>();
  const lastClose = new Map<string, Decimal>();
  // Sum of 1/close and the close count per symbol → the dollar-cost-average
  // benchmark: investing an equal cash slice at every close buys 1/price units,
  // so the final value per unit of cash is lastClose * mean(1/close).
  const closeInvSum = new Map<string, Decimal>();
  const closeCount = new Map<string, number>();
  // Carries each (symbol, interval) indicator state forward across ticks, like
  // live, instead of re-seeding the whole window every tick (the old dominant
  // per-tick cost).
  const snapshotComputer = createSnapshotComputer();

  let startingBalance: Decimal | null = null;
  let lastCloseMs = -Infinity;
  let processed = 0;

  // Behavioural diagnostics: aggregate the per-tick `metrics`/`logs` the
  // strategy emits (the engine otherwise consumes only `decisions`). Keys
  // bucket by (name, tags) and (level, message, reason); cardinality stays
  // bounded by the strategy's fixed metric/log vocabulary. Per-symbol splits
  // fall out for free since strategies tag emissions with `symbol`.
  //
  // Only unit counters (value === 1 on every emission) survive into the
  // breakdown, since `count` is an occurrence count, not a sum. Those are the
  // decision events the panel reports: buys placed, skips by reason, gate
  // vetoes. Gauge metrics (e.g. TT's indicator readings) carry their value in
  // `value`, so a bucket that ever sees a non-1 value is flagged non-unit and
  // dropped, rather than surfacing a meaningless "RSI computed N times" row.
  // The `\n` separator cannot occur in a name, message, or tag value.
  const metricBuckets = new Map<
    string,
    { name: string; tags: Record<string, string>; count: number; unit: boolean }
  >();
  const logBuckets = new Map<
    string,
    { level: LogEntry['level']; message: string; reason: string | null; count: number }
  >();
  const tallyMetric = (m: MetricEntry): void => {
    const key = `${m.name}\n${canonicalTags(m.tags)}`;
    const bucket = metricBuckets.get(key);
    if (bucket) {
      bucket.count += 1;
      if (m.value !== 1) bucket.unit = false;
    } else {
      metricBuckets.set(key, {
        name: m.name,
        tags: { ...(m.tags ?? {}) },
        count: 1,
        unit: m.value === 1,
      });
    }
  };
  const tallyLog = (l: LogEntry): void => {
    const reason = typeof l.context?.['reason'] === 'string' ? l.context['reason'] : null;
    const key = `${l.level}\n${l.message}\n${reason ?? ''}`;
    const bucket = logBuckets.get(key);
    if (bucket) bucket.count += 1;
    else logBuckets.set(key, { level: l.level, message: l.message, reason, count: 1 });
  };

  // Converge the plugin's position state from the executor's fills, the engine's analogue of the live fill-adopter. Without this a stateful strategy (e.g. TT, which reads `state.avgEntryPrice`) never learns it holds a position and re-buys every candle. The prior position comes from a fills-only ledger, the analogue of live's durable avg-entry row, not from state: momentum writes its order quantity into state when it places the entry, so folding the fill onto state counted every entry twice.
  const positionLedger = new Map<string, PositionView | null>();
  // The state a tick started from when it placed a SELL, so a refused SELL can restore it the way live discards a tick whose order never executes. Held only until the next tick, since a refusal is adopted before that tick runs.
  const preSellStates = new Map<string, S>();
  const adoptFills = (symbol: string): void => {
    const position = strategy.position;
    if (!position) return; // strategy doesn't manage a position; nothing to converge
    const drained = executor.drainFills(symbol);
    const buyRejected = executor.drainRejected(symbol, 'BUY');
    const sellRejected = executor.drainRejected(symbol, 'SELL');
    if (drained.length === 0 && !buyRejected && !sellRejected) return;
    let state = states.get(symbol) ?? strategy.initialState(config);
    let prior = positionLedger.get(symbol) ?? null;
    for (const fill of drained) ({ state, prior } = adoptOne(position, state, prior, fill));
    positionLedger.set(symbol, prior);
    states.set(symbol, state);
    // A strategy that records its position when it places the entry (momentum) is left claiming coins the refused BUY never bought. Live discards that tick's state, so flatten it here; otherwise the run carries a phantom position that blocks re-entry and arms stops against nothing. Only a claim no fill backs is cleared.
    if (buyRejected && prior === null && holdsPosition(symbol)) {
      states.set(symbol, position.applyFill(state, { kind: 'empty' }) ?? state);
    }
    // The mirror case: a strategy that flattens when it places the exit (momentum) is left flat on coins the refused SELL never sold, so it stops guarding them and a re-entry folds onto them. Restore the state the exit tick started from, which keeps its trailing high-water marks so the next tick retries the exit against the same threshold, then pin the position to the ledger in case fills moved it since.
    if (!sellRejected) return;
    const before = preSellStates.get(symbol);
    preSellStates.delete(symbol);
    const view = position.readPosition(state);
    if (
      prior !== null &&
      prior.avgEntryPrice !== null &&
      prior.heldQuantity !== null &&
      (view?.heldQuantity !== prior.heldQuantity || view.avgEntryPrice !== prior.avgEntryPrice)
    ) {
      const base = before ?? state;
      const held = position.setHeldQuantity(base, prior.heldQuantity) ?? base;
      states.set(symbol, position.setAvgEntryPrice(held, prior.avgEntryPrice) ?? held);
    }
  };

  // Account-wide deployed quote = Σ(avgEntryPrice × heldQuantity) over every
  // symbol position the run holds, read through the plugin's position
  // capability (strategy-agnostic). Supplies `account.deployedQuoteAcross
  // Profiles` so the strategy's account exposure cap evaluates against the same
  // scalar it gets live (the veto logic itself is exercised at the strategy
  // unit / tick layers); here the single backtest profile's symbols stand in
  // for the live account's profiles. '0' when the strategy manages no position.
  const accountDeployedQuote = (): string => {
    const position = strategy.position;
    if (!position) return '0';
    let total = ZERO;
    for (const s of states.values()) {
      const view = position.readPosition(s);
      if (!view || view.avgEntryPrice === null || view.heldQuantity === null) continue;
      // A malformed position string contributes 0 rather than aborting the
      // whole run; the live cap path guards the same way via safeDecimal.
      try {
        total = total.add(new Decimal(view.avgEntryPrice).mul(view.heldQuantity));
      } catch {
        continue;
      }
    }
    return total.toString();
  };

  /**
   * Whether the strategy holds a position on `symbol`, read through its position capability. Gates the within-candle ticks: they exist to replay a held position's exit, and skipping them while flat keeps a long minute-bar replay affordable. The cost is an entry live would take mid-candle after a price-dependent gate deferred it past the close; the replay takes it at the next close instead.
   *
   * @param symbol - The symbol whose replayed state is read.
   * @returns True only when the position view parses to a held quantity above zero; a strategy with no position capability, or no state yet, reads as flat.
   */
  const holdsPosition = (symbol: string): boolean => {
    const position = strategy.position;
    const state = states.get(symbol);
    if (!position || state === undefined) return false;
    const held = position.readPosition(state)?.heldQuantity;
    if (held === null || held === undefined) return false;
    try {
      return new Decimal(held).gt(0);
    } catch {
      return false;
    }
  };

  // Within-candle bars that closed since the symbol's previous tick, handed to the next tick under `intraCandle.interval`. The strategy keeps its own high-water marks in state, so the bars since the last tick are all it needs, and the buffer never outgrows one trading candle because every close ticks and drains it.
  const pendingBars = new Map<string, Candle[]>();
  const takePendingBars = (symbol: string): readonly Candle[] => {
    const bars = pendingBars.get(symbol) ?? [];
    pendingBars.set(symbol, []);
    return bars;
  };
  const addPendingBar = (symbol: string, bar: Candle): void => {
    const bars = pendingBars.get(symbol);
    if (bars) bars.push(bar);
    else pendingBars.set(symbol, [bar]);
  };

  /**
   * One strategy tick: assemble the snapshot, run `tick()`, fold its diagnostics, and apply its decisions. Shared by the per-candle close and the within-candle ticks so the two cannot drift in what the strategy sees.
   *
   * @param args - The symbol and its streamed interval; its trading window, which ends at the last CLOSED trading candle (mid-candle it excludes the candle in progress); the price the tick sees; the instant auxiliary windows are cut at, so none reaches past it; and the trigger handed to the strategy.
   * @returns Resolves once every decision has been applied and any immediate fills adopted.
   */
  const runTick = async (args: {
    readonly symbol: string;
    readonly interval: CandleInterval;
    readonly window: readonly Candle[];
    readonly price: string;
    readonly asOfMs: number;
    readonly trigger: TickInput<C, S, B>['trigger'];
  }): Promise<void> => {
    const { symbol, interval, window } = args;
    const symbolInfo = symbolInfos.get(symbol);
    if (!symbolInfo) throw new Error(`no SymbolInfo provided for ${symbol}`);

    const state = states.get(symbol) ?? strategy.initialState(config);
    const auxWindows = opts.auxiliaryWindows?.({ symbol, asOfMs: args.asOfMs });
    const intraKey = opts.intraCandle?.interval;
    // The streamed interval's rolling window is authoritative; auxiliary
    // windows (e.g. the daily regime candle) fill OTHER intervals only, so the
    // streamed key is spread last to win any collision.
    const candlesByInterval: Partial<Record<CandleInterval, readonly Candle[]>> = {
      ...(auxWindows ?? {}),
      ...(intraKey !== undefined ? { [intraKey]: takePendingBars(symbol) } : {}),
      [interval]: window,
    };
    // Per-interval indicator snapshots, mirroring what the live worker writes to Redis and reads into `market.indicatorsByInterval`. Without this an armed indicatorGate (RSI/SMA/EMA bias) reads `undefined` and fails closed with `indicator-unavailable` on every tick, so the profile can never trade — or pass the live-enablement gate — in a backtest. `snapshotComputer.step` reuses the same incremental indicators as live for byte-parity. The within-candle bars are skipped: they are a since-last-tick slice, not a rolling window an indicator can be computed over, and `step` requires each call to advance one closed candle.
    const indicatorsByInterval: Partial<Record<CandleInterval, IndicatorSnapshot>> = {};
    for (const iv of Object.keys(candlesByInterval) as CandleInterval[]) {
      if (iv === intraKey && iv !== interval) continue;
      const win = candlesByInterval[iv];
      const snap = win ? snapshotComputer.step(`${symbol}|${iv}`, win) : null;
      if (snap) indicatorsByInterval[iv] = snap;
    }
    const market: MarketSnapshot = {
      symbol,
      currentPrice: args.price,
      candlesByInterval,
      indicatorsByInterval,
      symbolInfo,
    };
    const input: TickInput<C, S, B> = {
      clock,
      rng,
      trigger: args.trigger,
      profile: {
        id: PROFILE_ID,
        userId: USER_ID,
        binanceMode: 'test',
        status: 'running',
        strategyVersion: strategy.version,
      },
      config,
      state,
      market,
      account: {
        ...executor.snapshotAccount(),
        deployedQuoteAcrossProfiles: accountDeployedQuote(),
      },
      openOrders: executor.openOrders(symbol),
      bundle: buildBundle({ symbol, interval, window }),
      limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10_000 },
      // Cross-symbol KV: mirror the live read gating — only a strategy
      // that opts in sees the store, so per-symbol strategies stay byte-identical.
      ...(readsProfileKv(strategy, config) ? { profileKv: executor.kvSnapshot() } : {}),
    };

    // Fail closed on a schema-invalid bundle, matching the live tick boundary:
    // a bundle the strategy cannot consume throws before tick() rather than
    // feeding a malformed shape through the engine.
    strategy.bundleSchema.parse(input.bundle);
    const out = strategy.tick(input);
    states.set(symbol, out.nextState);
    if (out.decisions.some((d) => d.type === 'place-order' && d.intent.side === 'SELL'))
      preSellStates.set(symbol, state);
    else preSellStates.delete(symbol);

    for (const m of out.metrics) tallyMetric(m);
    for (const l of out.logs) tallyLog(l);

    for (const decision of out.decisions) {
      await executor.apply(
        { userId: USER_ID, profileId: PROFILE_ID, clock, strategyName: strategy.name },
        decision,
      );
    }
    // An immediate-fill model (ideal) fills on placement; adopt those fills
    // onto the post-tick state so the next tick sees the position. A resting
    // model produces nothing here — its fills are adopted at the next candle.
    adoptFills(symbol);
  };

  for await (const tick of dataSource.stream(request)) {
    const { symbol, interval, candle } = tick;
    const detailCandles = tick.detailCandles;

    // Enforce the MarketDataSource ordering contract: the shared account must
    // mutate in true time order, so an out-of-order tick would silently
    // mis-sequence a portfolio's balance. Fail loudly instead.
    if (candle.closeTimeMs < lastCloseMs) {
      throw new Error(
        `market data out of order: ${symbol} closeTime ${candle.closeTimeMs} < ${lastCloseMs}`,
      );
    }
    lastCloseMs = candle.closeTimeMs;

    const priorInterval = intervalOf.get(symbol);
    if (priorInterval && priorInterval !== interval) {
      throw new Error(
        `symbol ${symbol} streamed two intervals (${priorInterval}, ${interval}); ` +
          `a backtest expects exactly one interval per symbol`,
      );
    }
    intervalOf.set(symbol, interval);

    const key = `${symbol}|${interval}`;
    const window = windows.get(key) ?? [];

    // Bars the closing step crosses resting orders against. Under within-candle ticking every bar but the last has already been crossed by its own tick, so the close crosses only the last one.
    let closeBars = detailCandles;
    if (opts.intraCandle !== undefined && detailCandles !== undefined && detailCandles.length > 0) {
      // Within-candle ticks advance the clock inside each candle, so a second symbol would replay its bars after this one's later ones and mutate the shared account out of time order.
      if (symbol !== benchmarkSymbol) {
        throw new Error(
          `within-candle ticking replays one symbol; ${symbol} is not the run's only symbol`,
        );
      }
      if (!coversCandle(detailCandles, candle)) {
        // A hole in the bars hides minutes the coarse candle's high and low still include, so cross the whole candle once and tick only on its close.
        for (const bar of detailCandles) addPendingBar(symbol, bar);
        closeBars = undefined;
      } else {
        for (const bar of detailCandles.slice(0, -1)) {
          clock.advanceTo(bar.closeTimeMs);
          executor.setMarketContext(symbol, new Decimal(bar.close), bar, [bar]);
          adoptFills(symbol);
          addPendingBar(symbol, bar);
          // Warm-up never reaches here holding anything: no tick has run, so no order has filled.
          if (!holdsPosition(symbol)) continue;
          // The trading window still ends at the previous close: this candle has not closed yet, exactly as live sees it mid-candle.
          await runTick({
            symbol,
            interval,
            window,
            price: bar.close,
            asOfMs: bar.closeTimeMs,
            trigger: { kind: 'tick' },
          });
          await opts.onIntraCandleTick?.();
        }
        const last = detailCandles[detailCandles.length - 1];
        if (last !== undefined) addPendingBar(symbol, last);
        closeBars = detailCandles.slice(-1);
      }
    }

    window.push(candle);
    if (window.length > windowCap) window.shift();
    windows.set(key, window);

    clock.advanceTo(candle.closeTimeMs);
    const price = new Decimal(candle.close);
    // When the data source supplies the finer detail bars for this candle, the
    // OHLCV model crosses orders against them in time order; otherwise it falls
    // back to the coarse candle. The data source owns the grouping.
    executor.setMarketContext(symbol, price, candle, closeBars);
    // Resting orders may have filled against this candle; adopt them before
    // the tick so the strategy sees the resulting position this candle
    // (signal-N, fill-N+1, position-visible-N+1 — the live ordering).
    adoptFills(symbol);

    // Mark opening equity once the first candle has set a price, so a
    // non-quote opening balance is valued, not zeroed.
    if (startingBalance === null) startingBalance = executor.equityInQuote(quoteAsset);

    const count = (seen.get(symbol) ?? 0) + 1;
    seen.set(symbol, count);
    if (count <= startup) {
      // Warm-up bars feed no tick, so drop them rather than handing a stale pre-trading slice to the first traded tick.
      pendingBars.set(symbol, []);
      continue; // warm-up: accumulate, do not trade
    }

    // Buy-and-hold / DCA benchmark accumulators, anchored on the first TRADED
    // candle (post-warmup) so the hold baseline spans the same window as the
    // strategy's equity curve. Accumulating during warmup would measure the
    // benchmark over the extra warmup candles the operator never asked to
    // evaluate, distorting alphaVsHold.
    if (!firstClose.has(symbol)) firstClose.set(symbol, price);
    lastClose.set(symbol, price);
    // A non-positive close cannot anchor a percentage benchmark; skip it from
    // both accumulators (the same drop rule the buy-and-hold mean applies).
    if (price.gt(0)) {
      closeInvSum.set(symbol, (closeInvSum.get(symbol) ?? ZERO).add(ONE.div(price)));
      closeCount.set(symbol, (closeCount.get(symbol) ?? 0) + 1);
    }

    await runTick({
      symbol,
      interval,
      window,
      price: candle.close,
      asOfMs: candle.closeTimeMs,
      trigger: { kind: 'candle-close', interval, openTimeMs: candle.openTimeMs },
    });

    const equity = executor.equityInQuote(quoteAsset).toString();
    equityCurve.push({ tsMs: clock.nowMs(), equity });
    // On the benchmark symbol's cadence, sample both its close and the portfolio
    // equity so the regime split's strategy and hold returns share one set of
    // steps (apples-to-apples, including multi-symbol baskets).
    if (symbol === benchmarkSymbol) {
      benchmarkPrices.push({ tsMs: candle.closeTimeMs, close: candle.close });
      benchmarkEquity.push({ tsMs: candle.closeTimeMs, equity });
    }
    processed += 1;
    opts.onProgress?.(processed);
  }

  // No candle ever streamed → no opening mark; report a flat empty run.
  const start = startingBalance ?? ZERO;
  const trades = executor.getTrades();
  // Cede the loop before the CPU-bound metric pass (host-injected; no-op by
  // default, so the report is byte-identical whether or not a yield runs here).
  await opts.onBeforeMetrics?.();
  const { metrics, drawdownSeries, perSymbol, roundTrips, regimeBreakdown, outOfSample } =
    computeMetrics({
      equityCurve,
      trades,
      startingBalance: start,
      marketChangePct: benchmarkPct(firstClose, lastClose),
      dcaChangePct: dcaBenchmarkPct(closeInvSum, closeCount, lastClose),
      benchmarkPrices,
      benchmarkEquity,
    });

  // Most-frequent first so the UI leads with the dominant behaviour; ties
  // break on the full bucket key for a total, locale-independent order so the
  // report stays byte-reproducible regardless of Map iteration order.
  const decisionBreakdown: DecisionBreakdown = {
    metrics: [...metricBuckets.values()]
      .filter((b) => b.unit)
      .sort(
        (a, b) =>
          b.count - a.count ||
          codepointCompare(a.name, b.name) ||
          codepointCompare(canonicalTags(a.tags), canonicalTags(b.tags)),
      )
      .map(({ name, tags, count }) => ({ name, tags, count })),
    logs: [...logBuckets.values()].sort(
      (a, b) =>
        b.count - a.count ||
        codepointCompare(a.message, b.message) ||
        codepointCompare(a.reason ?? '', b.reason ?? '') ||
        codepointCompare(a.level, b.level),
    ),
  };

  return {
    equityCurve: capCurve(equityCurve),
    drawdownSeries: capCurve(drawdownSeries),
    trades,
    roundTrips,
    perSymbol,
    metrics,
    summary: {
      startingBalance: metrics.startingBalance,
      finalBalance: metrics.finalBalance,
      totalReturnPct: metrics.totalReturnPct,
      tradeCount: trades.length,
    },
    decisionBreakdown,
    regimeBreakdown,
    outOfSample,
  };
}

/**
 * Merge one executor fill onto the plugin's position state via the shared {@link resolveFill} fold (the same fold the live fill-adopter uses, so the two cannot drift). Each fill is folded at its own price; folding sub-fills one at a time is arithmetically equal to averaging a whole order's VWAP once. A `null` from `applyFill` (unusable body) leaves the state unchanged, but `prior` still advances because it tracks fills, not state.
 *
 * @param position - The strategy's position capability.
 * @param state - The symbol's state before this fill.
 * @param prior - The position built from earlier fills only, the backtest's stand-in for live's durable avg-entry row; never read from state, which a strategy may have pre-filled when it placed the order.
 * @param fill - The executor fill to fold.
 * @returns The next state, and the next fills-only position (null once flat) to pass as `prior` for the following fill.
 */
export function adoptOne<S>(
  position: PositionStateAdapter<S>,
  state: S,
  prior: PositionView | null,
  fill: DrainedFill,
): { state: S; prior: PositionView | null } {
  const adopted = resolveFill(prior, { side: fill.side, price: fill.price, quantity: fill.qty });
  const next: PositionView | null =
    adopted.kind === 'buy'
      ? { avgEntryPrice: adopted.avgEntryPrice, heldQuantity: adopted.heldQuantity }
      : adopted.kind === 'sell-reduce'
        ? { avgEntryPrice: prior?.avgEntryPrice ?? null, heldQuantity: adopted.heldQuantity }
        : null;
  return { state: position.applyFill(state, adopted) ?? state, prior: next };
}

/**
 * Buy-and-hold benchmark: the mean per-symbol close-to-close change over the
 * run, as a number percentage. Equal-weighted across symbols — a simple,
 * honest comparator for the portfolio's total return.
 */
function benchmarkPct(
  firstClose: ReadonlyMap<string, Decimal>,
  lastClose: ReadonlyMap<string, Decimal>,
): number {
  const changes: Decimal[] = [];
  for (const [symbol, first] of firstClose) {
    const last = lastClose.get(symbol);
    // A symbol with a non-positive first close is dropped from the mean (not
    // zero-weighted) — it cannot yield a meaningful percentage change.
    if (last && first.gt(0)) changes.push(last.sub(first).div(first).mul(100));
  }
  if (changes.length === 0) return 0;
  let acc = ZERO;
  for (const c of changes) acc = acc.add(c);
  return acc.div(changes.length).toNumber();
}

/**
 * Dollar-cost-average benchmark: the mean per-symbol return of investing an
 * equal cash slice at every close over the run, as a number percentage.
 * Per symbol the final value per unit invested is `lastClose * mean(1/close)`,
 * so the return is `lastClose * (closeInvSum / closeCount) - 1`. Equal-weighted
 * across symbols, mirroring {@link benchmarkPct}. This is the honest comparator
 * for a dip-buyer: did its timing beat mechanically averaging in?
 */
function dcaBenchmarkPct(
  closeInvSum: ReadonlyMap<string, Decimal>,
  closeCount: ReadonlyMap<string, number>,
  lastClose: ReadonlyMap<string, Decimal>,
): number {
  const changes: Decimal[] = [];
  for (const [symbol, invSum] of closeInvSum) {
    const count = closeCount.get(symbol) ?? 0;
    const last = lastClose.get(symbol);
    if (last && count > 0) {
      changes.push(last.mul(invSum).div(count).sub(1).mul(100));
    }
  }
  if (changes.length === 0) return 0;
  let acc = ZERO;
  for (const c of changes) acc = acc.add(c);
  return acc.div(changes.length).toNumber();
}

/**
 * Whether the detail bars tile the coarse candle with no gap, which within-candle replay needs before it can cross each bar on its own and the close against only the last one.
 *
 * @param bars - The candle's detail bars, in time order.
 * @param candle - The coarse candle they belong to.
 * @returns True when the first bar opens at the candle's open, each bar opens the millisecond after the previous one closed, and the last closes at the candle's close.
 */
function coversCandle(bars: readonly Candle[], candle: Candle): boolean {
  if (bars[0]?.openTimeMs !== candle.openTimeMs) return false;
  if (bars[bars.length - 1]?.closeTimeMs !== candle.closeTimeMs) return false;
  return bars.every((bar, i) => i === 0 || bar.openTimeMs === (bars[i - 1]?.closeTimeMs ?? 0) + 1);
}
