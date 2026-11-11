import { Decimal } from '@app/money';
import { ema, sma } from '@app/indicators';
import {
  clearPositionScopedFields,
  decOrNull,
  log,
  metric,
  protectiveStopBandAdjustment,
} from '@app/strategy-core';
import type {
  Candle,
  Decision,
  LogEntry,
  MetricEntry,
  TickInput,
  TickOutput,
} from '@app/strategy-core';

import {
  MOMENTUM_STATE_SCHEMA_VERSION,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumState,
} from './schema.js';
import { computeEntryQuantity, computeExitQuantity, entryStopFloor } from './quantity.js';
import { extensionMaxPercent, extensionPeriod } from './extension.js';
import { trendMaType, trendPeriod } from './trend-filter.js';
import { breakoutLevel, breakoutLookback } from './breakout.js';
import { exhaustionReading, type ExhaustionReading } from './exhaustion.js';
import { obvLeadReading, type ObvLeadReading } from './obv-lead.js';
import { trendQualityReading, type TrendQualityReading } from './trend-quality.js';
import {
  weekendGapReading,
  weekendGapSettings,
  weekendGapTarget,
  type WeekendGapReading,
} from './weekend-gap.js';
import { impulseReading, type ImpulseReading } from './impulse.js';
import {
  choppiness,
  MA_CLUSTER_CHOP_PERIOD,
  maClusterMaxChoppiness,
  maClusterReading,
  type MaClusterReading,
} from './ma-cluster.js';
import { relativeStrengthGate, relativeStrengthPublish } from './relative-strength.js';
import { profitLegDistance } from './profit-leg.js';
import { configForEntryLayer } from './trailing-stop.js';
import { profitTrailEpoch, ratchetProfitHigh, resolveStopLevel } from './stop-level.js';
import { resolveEntryBudget } from './sizing.js';
import { entryClientOrderId, exitClientOrderId } from './client-order-id.js';
import {
  closingSellDecisions,
  desiredTrailDistance,
  evaluateProtectiveStopArm,
  findRestingProtectiveStop,
  nativeTrailHigh,
} from './protective-stop.js';

type MomentumInput = TickInput<MomentumConfig, MomentumState, MomentumBundle>;
type MomentumOutput = TickOutput<MomentumState>;

// `side` is a DECLARED label on the worker's `strategy_metric_total`, so its value space is now series cardinality rather than free-form annotation, and prom-client never evicts a child. A `string` parameter here is the only thing between a typo at a call site and a permanent series. The union is the three values every call site already passes.
const skipMetric = (side: 'entry' | 'exit' | 'sell', reason: string): MetricEntry =>
  metric('momentum.skip', { side, reason });

// Unparsed state means the key may be absent on a row written before it existed.
// Anything but a number reads as "never entered", so the guard fails open.
// '0' is the idle "row exists, quantity zero" body the repo really produces, so only a positive quantity counts as coins held. An unparseable one stays held, so a corrupt body cannot unlock a buy.
const holdsCoins = (quantity: string | null): boolean =>
  quantity !== null && (decOrNull(quantity)?.gt(0) ?? true);

const lastEntryCandle = (state: MomentumState): number | null =>
  typeof state.lastEntryCandleMs === 'number' ? state.lastEntryCandleMs : null;

// Same unparsed-state guard, and load-bearing rather than merely tidy: absent,
// `undefined` would fail OPEN downstream, because `openTimeMs < undefined` is
// false for every candle and the whole pre-entry window would fold in.
const profitTrailSince = (state: MomentumState): number | null =>
  typeof state.profitTrailSinceMs === 'number' ? state.profitTrailSinceMs : null;

/**
 * A no-op tick. `entryBlocker` records why an entry was suppressed this tick, or
 * null (the default) to clear it: a warm-up hold, a flat no-signal hold, or an
 * exit-path hold is not an entry suppression, so it resets the field. Only the
 * four entry-refusal sites pass a reason.
 */
const hold = (
  state: MomentumState,
  logs: readonly LogEntry[],
  metrics: readonly MetricEntry[] = [],
  entryBlocker: MomentumState['entryBlocker'] = null,
): MomentumOutput => ({
  nextState: { ...state, entryBlocker },
  decisions: [{ type: 'noop' }],
  logs,
  metrics,
});

// Entry confirmation margin as a non-negative Decimal; an absent or malformed
// value reads as 0 (bare cross). The live worker stores config unparsed, so the
// field may be missing entirely.
const entryMargin = (config: MomentumConfig): Decimal => {
  try {
    const m = new Decimal(config.entryMarginPct ?? '0');
    return m.lt(0) ? new Decimal(0) : m;
  } catch {
    return new Decimal(0);
  }
};

/**
 * Macro trend gate result. `pass` allows the entry. The block reasons are kept
 * distinct for observability: `below-trend` is a genuine sit-out (price under
 * the line); `above-trend` is its mirror under `side: 'below'` (price at or over
 * the line); `falling-trend` is the slope veto (price is above the line but the
 * line is not rising, the bear-rally signature); `insufficient-history` is
 * fail-closed (the window is too short to compute the line, or its slope) — a
 * misconfiguration tell, e.g. a 200-period filter on a profile that has not
 * loaded 200 candles, which must not look like a normal downtrend on the metric.
 */
type TrendGate = 'pass' | 'below-trend' | 'above-trend' | 'falling-trend' | 'insufficient-history';

const trendLine = (maType: 'sma' | 'ema', candles: readonly Candle[], period: number): Decimal =>
  maType === 'ema' ? ema(candles, period) : sma(candles, period);

/**
 * Macro trend gate: an entry is allowed only while price trades above the
 * configured long-term MA, and (when `requireRising`) only while that MA is
 * itself rising over the last `slopeLookbackBars`. Price-above-line alone cannot
 * separate an early bull from a bear rally; the slope veto rejects a pop above a
 * still-falling line. Disabled or absent => `pass`. Fail-closed: too little
 * history to compute the line, or to read it `slopeLookbackBars` candles back,
 * returns `insufficient-history` (suppress rather than guess). Exit logic does
 * not consult this — an open long is still managed by the trailing stop.
 */
const trendGate = (
  config: MomentumConfig,
  candles: readonly Candle[],
  currentPrice: string,
): TrendGate => {
  const tf = config.trendFilter;
  if (tf?.enabled !== true) return 'pass';
  // The live worker stores config unparsed, so `requireRising` may be absent
  // (reads as the price-only gate) and `slopeLookbackBars` may be missing or a
  // raw non-number. Coerce the lookback to a finite value >= 1, else fall back to
  // 1, so the slope window is always valid and `period + k` is arithmetic, never
  // a string concatenation or a NaN that empties the slice.
  // `period`/`maType` are coerced too: a partial per-symbol override may enable
  // the filter without carrying them, and the worker reads config unparsed, so
  // an undefined period must not reach `sma`/`ema` (which throw on it).
  // The slope veto guards an above-the-line entry against a bear-rally pop. A below-side sleeve buys under the line, which is normally falling, so the veto would block nearly every signal there; it is skipped and `lintConfig` flags the setting as inert.
  const rising = tf.requireRising === true && tf.side !== 'below';
  const rawK = Number(tf.slopeLookbackBars ?? 10);
  const k = rising ? (Number.isFinite(rawK) && rawK >= 1 ? rawK : 1) : 0;
  const period = trendPeriod(tf.period);
  const maType = trendMaType(tf.maType);
  if (candles.length < period + k) return 'insufficient-history';
  const line = trendLine(maType, candles, period);
  // Strict on both sides, so a price exactly on the line enters neither sleeve.
  if (tf.side === 'below') {
    if (new Decimal(currentPrice).gte(line)) return 'above-trend';
  } else if (new Decimal(currentPrice).lte(line)) return 'below-trend';
  if (rising) {
    const prevLine = trendLine(maType, candles.slice(0, candles.length - k), period);
    if (line.lte(prevLine)) return 'falling-trend';
  }
  return 'pass';
};

/**
 * Whether price sits on or under the trend filter's line, read from its period and MA type even with the filter off. The below-trend layer uses it under the MA cluster trigger, which has no trend gate of its own. Same boundary as {@link trendGate}: on the line counts as under.
 *
 * @param config - Profile config; only `trendFilter.period` and `trendFilter.maType` are read, coerced like the gate does.
 * @param candles - Closed candles, oldest first.
 * @param currentPrice - Live price compared with the line, as the gate compares it.
 * @returns False while the window is shorter than the period, so a short window never buys.
 */
const underTrendLine = (
  config: MomentumConfig,
  candles: readonly Candle[],
  currentPrice: string,
): boolean => {
  const period = trendPeriod(config.trendFilter?.period);
  if (candles.length < period) return false;
  return new Decimal(currentPrice).lte(
    trendLine(trendMaType(config.trendFilter?.maType), candles, period),
  );
};

/**
 * The below-trend layer's choppiness gate: in the 2025-26 1h research a below-trend breakout taken while the Choppiness Index was 50 or more mostly faded, on the majors and on nine pre-chosen large caps alike.
 *
 * @param block - The unparsed `belowTrendBreakout` block; an empty or invalid `maxChoppiness` turns the gate off.
 * @param candles - Closed candles, oldest first, ending with the judged candle.
 * @returns True when the gate is off or the index is under the ceiling; false on a window too short to measure it.
 */
const belowTrendCalm = (block: unknown, candles: readonly Candle[]): boolean => {
  const ceiling = maClusterMaxChoppiness(block);
  if (ceiling === null) return true;
  return candles.length > MA_CLUSTER_CHOP_PERIOD && choppiness(candles).lt(ceiling);
};

/**
 * Extension-gate result. `pass` allows the entry; `overextended` is the ceiling
 * veto (price too far above its baseline); `extension-insufficient-history` is
 * fail-closed (window too short to compute the baseline). The warm-up code is
 * distinct from the trend gate's `insufficient-history` so the operator is
 * pointed at the extension period, not the trend-filter period.
 */
type ExtensionGate = 'pass' | 'overextended' | 'extension-insufficient-history';

/**
 * Entry overextension gate: the ceiling complement to {@link trendGate}'s floor.
 * With the guard on, a fresh long is suppressed while live price sits more than
 * `maxPercent` above its baseline MA — the overextended-blow-off signature a
 * lagging EMA cross buys late. Disabled or absent => `pass`. Fail-closed: too
 * little history to compute the baseline returns `extension-insufficient-history`
 * (suppress rather than enter unmeasured; {@link momentumRequiredWindow} folds
 * the period in so a live window is never short of it, making this a warm-up
 * edge). Exit logic does not consult this — an open long is still managed by the
 * trailing stop. Config is coerced via the shared {@link extensionPeriod} /
 * {@link extensionMaxPercent} so the preview cannot project a different ceiling.
 */
const extensionGate = (
  config: MomentumConfig,
  candles: readonly Candle[],
  currentPrice: string,
): ExtensionGate => {
  const ext = config.entryExtension;
  if (ext?.enabled !== true) return 'pass';
  const period = extensionPeriod(ext.period);
  if (candles.length < period) return 'extension-insufficient-history';
  const line = trendLine(ext.maType === 'ema' ? 'ema' : 'sma', candles, period);
  const ceiling = line.mul(new Decimal(1).plus(extensionMaxPercent(ext.maxPercent)));
  return new Decimal(currentPrice).gt(ceiling) ? 'overextended' : 'pass';
};

/**
 * Momentum strategy: enter long on a fast/slow EMA cross-up, or on any closed candle while the fast EMA is above the slow under `entryTrigger: 'trend'` (either way the fast EMA must clear the slow EMA by `entryMarginPct` to filter chop; one entry per candle), exit on a trailing stop retrace from the high since entry or an EMA cross-down. While holding, a resting exchange-side protective stop mirrors the trailing level so the position survives a worker outage or a gap. One long per (profile, symbol); no grid. Pure — EMAs are computed in-strategy from the candle window. With the relative-strength gate on, every tick also keeps this symbol's score current in the profile KV store, once per closed candle.
 *
 * @param input - One tick's world for a single (profile, symbol): config, the state body as stored, the candle window and live price, wallet and account balances, and any pending operator override. Never mutated.
 * @returns The next state body plus the decisions the worker should execute. A hold returns a `noop` decision rather than an empty list, so a tick that chose to do nothing is distinguishable from one that never ran.
 */
export const computeTick = (input: MomentumInput): MomentumOutput => {
  const out = decide(input);
  // Publishing is independent of what the tick decided: a held or refused symbol still has a score its siblings rank against.
  const closed = (input.market.candlesByInterval[input.config.candleInterval] ?? []).filter(
    (c) => c.isClosed,
  );
  const publish = relativeStrengthPublish(
    closed,
    input.config.relativeStrength,
    input.market.symbol,
    input.profileKv,
  );
  return publish === null ? out : { ...out, decisions: [...out.decisions, publish] };
};

/**
 * Everything {@link computeTick} decides except the relative-strength KV publish.
 *
 * @param input - The tick's input, as {@link computeTick} received it.
 * @returns The next state body and the tick's decisions.
 */
const decide = (input: MomentumInput): MomentumOutput => {
  const { config, market } = input;
  // A position-scoped blocker explains something about a position that is OPEN; with the position gone it describes nothing, so it must not outlive it. Cleared here rather than inside the flat branch below because the warm-up return above that branch is itself a flat tick, and would otherwise carry a refusal forward for as long as the candle window stays short.
  //
  // Position-free means no cost basis AND no coins. A body carrying a held quantity with no basis is a real, unguarded holding, not a flat profile, and its stop refusal is the only trace of that exposure — the reconciler names this exact shape as the one where the strategy reads flat while still holding.
  // Flat means no basis (`entryPrice === null`) and no positive quantity (`holdsCoins`), the same two tests the entry/exit dispatch below uses: the dispatch sends a null basis to the entry branch, and `holdsCoins` there refuses a held-without-basis entry. A different test here would call a body flat that the dispatch then treats as held, clearing the blocker on a live holding. `'0'` reads as flat in both places, and an unparseable quantity reads as held, which keeps the warning, the safe direction.
  const positionFree = input.state.entryPrice === null && !holdsCoins(input.state.heldQuantity);
  const state = positionFree ? clearPositionScopedFields(input.state) : input.state;
  // One name for the normalised input, allocated unconditionally rather than aliased back to `input` on the no-clear path: aliasing is only sound while this predicate matches the entry/exit dispatch below, and that coupling is invisible at the call site. `clearPositionScopedFields` already returns its argument when there is nothing to clear, so the inner allocation is still skipped on a steady flat tick.
  const scoped: MomentumInput = { ...input, state };
  const allCandles = market.candlesByInterval[config.candleInterval] ?? [];
  // Act only on closed candles: a forming candle's close moves intra-tick and
  // would make the cross non-deterministic.
  const candles = allCandles.filter((c) => c.isClosed);
  const lastCandle = candles.at(-1);

  // The slow EMA needs `slow` candles; detecting a cross needs one more candle
  // to compare the prior window against.
  const need = config.ema.slow + 1;
  // Operator force-sell (a `trigger-sell` override in the bundle). Read here, not
  // only in the exit path, because warm-up returns before the exit path runs: a
  // force-sell that lands on a cold worker or a freshly added symbol must be kept
  // armed, not consumed by a tick that could not even compute a cross.
  const forceSell = input.bundle.override?.kind === 'trigger-sell';
  if (lastCandle === undefined || candles.length < need) {
    const warmingUp = hold(state, [
      log('debug', 'momentum: insufficient closed candles for EMA cross', {
        have: candles.length,
        need,
      }),
    ]);
    // Transient: the window fills as candles close, so keep the override armed
    // rather than let a tick that could not evaluate anything consume it.
    return forceSell
      ? { ...warmingUp, overrideDeferred: true, overrideDeclineReason: 'warming-up' }
      : warmingUp;
  }

  const windowPrev = candles.slice(0, -1);
  const fastNow = ema(candles, config.ema.fast);
  const slowNow = ema(candles, config.ema.slow);
  const fastPrev = ema(windowPrev, config.ema.fast);
  const slowPrev = ema(windowPrev, config.ema.slow);
  // Entry threshold is the slow EMA raised by the confirmation margin, so a
  // cross-up counts only when the fast EMA clears it. Exit stays a bare
  // cross-down: quick to leave, slow to enter.
  const band = new Decimal(1).plus(entryMargin(config));
  const crossUp = fastPrev.lte(slowPrev.mul(band)) && fastNow.gt(slowNow.mul(band));
  const crossDown = fastPrev.gte(slowPrev) && fastNow.lt(slowNow);

  if (state.entryPrice === null) {
    // Coins with no cost basis are an unguarded holding, not a flat symbol: the reconciler seeds a held quantity from the wallet, and deleting a basis keeps it. Entering here would place a second buy and overwrite `heldQuantity` with that order alone, dropping the original coins from tracking. Refuse and say so until the operator sets a basis or sells.
    if (holdsCoins(state.heldQuantity)) {
      // debug, not warn: this holds on every tick until the operator acts, and the entryBlocker change row already records it once.
      const blocked = hold(
        state,
        [
          log('debug', 'momentum: holding coins with no cost basis, entry suppressed', {
            symbol: market.symbol,
            heldQuantity: state.heldQuantity,
          }),
        ],
        [skipMetric('entry', 'held-without-basis')],
        { reason: 'held-without-basis' },
      );
      // A force-sell cannot be sized against a position the strategy does not hold, so decline it with the reason rather than the generic "did not act".
      return forceSell ? { ...blocked, overrideDeclineReason: 'held-without-basis' } : blocked;
    }
    // `trend` enters on the state (fast above the threshold) rather than the event, because discovery admits symbols that already crossed and for them the event does not recur while the trend lasts.
    const breakout =
      config.entryTrigger === 'breakout'
        ? breakoutLevel(windowPrev, breakoutLookback(config.breakoutLookback))
        : null;
    const impulse =
      config.entryTrigger === 'impulse' ? impulseReading(candles, config.impulse) : null;
    const cluster =
      config.entryTrigger === 'maCluster' ? maClusterReading(candles, config.maCluster) : null;
    const exhaustion =
      config.entryTrigger === 'exhaustion' ? exhaustionReading(candles, config.exhaustion) : null;
    const obvLead =
      config.entryTrigger === 'obvLead' ? obvLeadReading(candles, config.obvLead) : null;
    const weekendGap =
      config.entryTrigger === 'weekendGap' ? weekendGapReading(candles, config) : null;
    const trendQuality =
      config.entryTrigger === 'trendQuality'
        ? trendQualityReading(candles, config.trendQuality)
        : null;
    const entrySignal =
      config.entryTrigger === 'trend'
        ? fastNow.gt(slowNow.mul(band))
        : config.entryTrigger === 'breakout'
          ? breakout !== null && new Decimal(lastCandle.close).gt(breakout)
          : config.entryTrigger === 'impulse'
            ? impulse?.fired === true
            : config.entryTrigger === 'maCluster'
              ? cluster?.fired === true
              : config.entryTrigger === 'exhaustion'
                ? exhaustion?.fired === true
                : config.entryTrigger === 'obvLead'
                  ? obvLead?.fired === true
                  : config.entryTrigger === 'weekendGap'
                    ? // Below the Friday close, else the gap-filled exit sells on the next tick and the round trip pays only fees.
                      weekendGap?.fired === true &&
                      weekendGap.refClose !== null &&
                      new Decimal(market.currentPrice).lt(weekendGap.refClose)
                    : config.entryTrigger === 'trendQuality'
                      ? trendQuality?.fired === true
                      : crossUp;
    // The below-trend layer's range, read only when that layer can act: the breakout or MA cluster trigger with the layer on.
    const belowTrend = config.belowTrendBreakout;
    const belowBreakout =
      (config.entryTrigger === 'breakout' || config.entryTrigger === 'maCluster') &&
      belowTrend?.enabled === true
        ? breakoutLevel(windowPrev, breakoutLookback(belowTrend.lookback))
        : null;
    const gate = trendGate(config, candles, market.currentPrice);
    // Under breakout the layer fires only where the primary rule's own trend gate refuses for `below-trend`, so above the line nothing changes, and a `below` side or a disabled filter (which never answers `below-trend`) leaves it inert. The MA cluster rule was researched with no trend gate, so there the layer reads the trend filter's line itself, whether or not the filter gates entries.
    const belowSignal =
      belowBreakout !== null &&
      new Decimal(lastCandle.close).gt(belowBreakout) &&
      (config.entryTrigger === 'maCluster'
        ? underTrendLine(config, candles, market.currentPrice)
        : gate === 'below-trend') &&
      belowTrendCalm(belowTrend, candles);
    // When the primary rule may also buy on this candle it wins, so the position keeps the primary trail.
    const layer =
      belowSignal && !(entrySignal && gate === 'pass') ? ('below-trend' as const) : null;
    if (entrySignal || belowSignal) {
      // One entry per candle. The signal (cross-up, or fast above slow under `trend`) reads the last CLOSED candles, so it stays true for the rest of the candle it fired on: a position stopped out inside that window would otherwise re-enter at the price the stop just rejected, unbounded. Checked before the trend gate so a repeat attempt does not report itself as a trend-filter veto.
      if (lastEntryCandle(state) === lastCandle.closeTimeMs) {
        return hold(
          state,
          [
            log('debug', 'momentum: entry suppressed, already entered on this candle', {
              symbol: market.symbol,
              candleCloseMs: lastCandle.closeTimeMs,
            }),
          ],
          [skipMetric('entry', 'already-entered-this-candle')],
          { reason: 'already-entered-this-candle' },
        );
      }
      // Macro trend gate: suppress a fresh long unless price is above the long-term
      // trend line, so the strategy sits out confirmed downtrends instead of buying
      // false cross-ups on bear rallies. The skip reason distinguishes a genuine
      // below-trend sit-out from a too-short window (a misconfiguration tell).
      if (gate !== 'pass' && layer === null) {
        return hold(
          state,
          [
            log('debug', 'momentum: entry suppressed by trend filter', {
              symbol: market.symbol,
              gate,
            }),
          ],
          [skipMetric('entry', gate)],
          { reason: gate },
        );
      }
      // Overextension ceiling: the trend gate is the floor (price above the
      // line), this rejects a cross that fires while price sits far ABOVE the
      // line — the late, exhausted blow-off entry. Runs after the trend gate so
      // a below-trend sit-out reports itself, not an overextension.
      const extension = extensionGate(config, candles, market.currentPrice);
      if (extension !== 'pass') {
        return hold(
          state,
          [
            log('debug', 'momentum: entry suppressed by extension guard', {
              symbol: market.symbol,
              gate: extension,
            }),
          ],
          [skipMetric('entry', extension)],
          { reason: extension },
        );
      }
      // Cross-symbol rank, last because it is the only gate that reads other symbols: a refusal by any per-symbol gate reports itself first.
      const strength = relativeStrengthGate(
        candles,
        config.relativeStrength,
        market.symbol,
        input.profileKv,
      );
      if (strength.gate !== 'pass') {
        return hold(
          state,
          [
            log('debug', 'momentum: entry suppressed by relative strength', {
              symbol: market.symbol,
              gate: strength.gate,
              score: strength.score?.toFixed(6) ?? null,
              rank: strength.rank,
              siblings: strength.siblings,
            }),
          ],
          [skipMetric('entry', strength.gate)],
          { reason: strength.gate },
        );
      }
    }
    return evaluateEntry(
      { ...scoped, config: configForEntryLayer(config, layer) },
      entrySignal || belowSignal,
      lastCandle.closeTimeMs,
      candles,
      {
        fastNow,
        slowNow,
        threshold: slowNow.mul(band),
        breakout,
        belowBreakout,
        impulse,
        cluster,
        exhaustion,
        obvLead,
        weekendGap,
        trendQuality,
        close: new Decimal(lastCandle.close),
        gate,
      },
      layer,
    );
  }
  return evaluateExit(
    { ...scoped, config: configForEntryLayer(config, state.entryLayer) },
    state.entryPrice,
    crossDown,
    lastCandle,
    candles,
    forceSell,
  );
};

const evaluateEntry = (
  input: MomentumInput,
  entrySignal: boolean,
  candleCloseMs: number,
  candles: readonly Candle[],
  signal: {
    fastNow: Decimal;
    slowNow: Decimal;
    threshold: Decimal;
    breakout: Decimal | null;
    belowBreakout: Decimal | null;
    impulse: ImpulseReading | null;
    cluster: MaClusterReading | null;
    exhaustion: ExhaustionReading | null;
    obvLead: ObvLeadReading | null;
    weekendGap: WeekendGapReading | null;
    trendQuality: TrendQualityReading | null;
    close: Decimal;
    gate: TrendGate;
  },
  // Which rule this entry belongs to, stamped into state so the exit trails at that rule's multiple; `input.config` already carries it.
  layer: 'below-trend' | null,
): MomentumOutput => {
  const { state, config, market, profile, account } = input;
  if (!entrySignal && config.entryTrigger === 'impulse') {
    // The two ratios say how far the last candle was from qualifying; null means the window is still too short to measure them.
    const reading = signal.impulse;
    return hold(state, [
      log('debug', 'momentum: flat, no impulse', {
        symbol: market.symbol,
        volumeRatio: reading?.volumeRatio.toFixed(2) ?? null,
        bodyAtr: reading?.bodyAtr.toFixed(2) ?? null,
        trendGate: signal.gate,
        waitingFor: reading === null ? 'impulse-history' : 'heavy-volume-up-candle',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'exhaustion') {
    // The three readings say which leg is short of firing; null means the window is still too short to measure them.
    const reading = signal.exhaustion;
    return hold(state, [
      log('debug', 'momentum: flat, no exhaustion', {
        symbol: market.symbol,
        choppiness: reading?.choppiness.toFixed(1) ?? null,
        belowAveragePercent: reading?.belowAverage.times(100).toFixed(2) ?? null,
        rsi: reading?.rsi.toFixed(1) ?? null,
        trendGate: signal.gate,
        waitingFor: reading === null ? 'exhaustion-history' : 'one-way-oversold-slide',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'obvLead') {
    // Names the first leg short of firing, in the order the rule reads them; null means the window is still too short.
    const reading = signal.obvLead;
    return hold(state, [
      log('debug', 'momentum: flat, no OBV lead', {
        symbol: market.symbol,
        obvNewHigh: reading?.obvNewHigh ?? null,
        priceToHighPercent: reading?.priceToHigh.times(100).toFixed(2) ?? null,
        choppiness: reading?.choppiness.toFixed(1) ?? null,
        trendGate: signal.gate,
        waitingFor:
          reading === null
            ? 'obv-lead-history'
            : !reading.obvNewHigh
              ? 'obv-new-high'
              : !reading.priceToHigh.gt(0)
                ? 'price-already-at-high'
                : 'less-choppy-market',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'weekendGap') {
    // Null means the interval is not 1h, so the Sunday candle can never be identified; otherwise names the first leg short of firing.
    const reading = signal.weekendGap;
    return hold(state, [
      log('debug', 'momentum: flat, no weekend gap', {
        symbol: market.symbol,
        refClose: reading?.refClose ?? null,
        gapPercent: reading?.gapPercent ?? null,
        trendGate: signal.gate,
        waitingFor:
          reading === null
            ? 'one-hour-candles-only'
            : !reading.isEntryCandle
              ? 'sunday-22utc-candle'
              : reading.refClose === null
                ? 'weekend-gap-history'
                : 'close-below-friday-close',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'trendQuality') {
    // Names the first leg short of firing, in the order the rule reads them; null means the window is still too short. A trend that was already straight a candle ago waits for a fresh one even when the close is above its line.
    const reading = signal.trendQuality;
    return hold(state, [
      log('debug', 'momentum: flat, no trend quality', {
        symbol: market.symbol,
        rSquared: reading?.rSquared.toFixed(3) ?? null,
        slopePercentPerCandle: reading?.slope.times(100).toFixed(3) ?? null,
        aboveLinePercent: reading?.aboveLine.times(100).toFixed(2) ?? null,
        previousArmed: reading?.previousArmed ?? null,
        trendGate: signal.gate,
        waitingFor:
          reading === null
            ? 'trend-quality-history'
            : !reading.armed
              ? 'straight-rising-trend'
              : reading.previousArmed
                ? 'fresh-trend'
                : 'close-above-trend-line',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'maCluster') {
    // Spread says whether the averages have bunched yet; the rise says how far a close must climb to clear the top one; choppiness says whether the gate would refuse a break. Null means the window is still too short.
    const reading = signal.cluster;
    return hold(state, [
      log('debug', 'momentum: flat, no MA cluster break', {
        symbol: market.symbol,
        clusterTop: reading?.top.toFixed() ?? null,
        clusterSpreadPercent: reading?.spread.times(100).toFixed(2) ?? null,
        riseToClusterTopPercent:
          reading === null ? null : reading.top.div(signal.close).minus(1).times(100).toFixed(2),
        choppiness: reading?.choppiness.toFixed(1) ?? null,
        atrPercentile: reading?.atrPercentile?.toFixed(2) ?? null,
        ...(signal.belowBreakout === null
          ? {}
          : {
              belowTrendBreakoutLevel: signal.belowBreakout.toFixed(),
              riseToBelowTrendBreakoutPercent: signal.belowBreakout
                .div(signal.close)
                .minus(1)
                .times(100)
                .toFixed(2),
            }),
        trendGate: signal.gate,
        // Names the condition that binds: a close already above the top cannot cross until it falls back, and with the averages spread out no cross counts at all.
        waitingFor:
          reading === null
            ? 'ma-cluster-history'
            : reading.choppy
              ? 'less-choppy-market'
              : reading.volatile
                ? 'calmer-market'
                : reading.unconfirmed
                  ? 'next-close-above-cluster'
                  : !reading.bunched
                    ? 'averages-to-bunch'
                    : signal.close.gt(reading.top)
                      ? 'fall-back-then-close-above-cluster'
                      : 'close-above-bunched-averages',
      }),
    ]);
  }
  if (!entrySignal && config.entryTrigger === 'breakout') {
    // A null level means the window has not yet filled the lookback range, which a "waiting for a close above" line would misreport.
    // The rise percents and the trend verdict say how far each rule is from firing and which side of the line price is on, so a reader of the trace can name the blocking condition without recomputing it from candles.
    const riseTo = (level: Decimal): string =>
      level.div(signal.close).minus(1).times(100).toFixed(2);
    return hold(state, [
      log('debug', 'momentum: flat, no breakout', {
        symbol: market.symbol,
        breakoutLevel: signal.breakout?.toFixed() ?? null,
        riseToBreakoutPercent: signal.breakout === null ? null : riseTo(signal.breakout),
        ...(signal.belowBreakout === null
          ? {}
          : {
              belowTrendBreakoutLevel: signal.belowBreakout.toFixed(),
              riseToBelowTrendBreakoutPercent: riseTo(signal.belowBreakout),
            }),
        trendGate: signal.gate,
        waitingFor: signal.breakout === null ? 'breakout-history' : 'close-above-breakout-level',
      }),
    ]);
  }
  if (!entrySignal) {
    // A bare "no signal" cannot tell an operator, or an agent reading the tick trace, whether the coin is about to cross or crossed weeks ago and must fall back first. The EMA values answer that without recomputing them from candles.
    const { fastNow, slowNow, threshold } = signal;
    return hold(state, [
      log('debug', 'momentum: flat, no entry signal', {
        symbol: market.symbol,
        fastEma: fastNow.toFixed(),
        slowEma: slowNow.toFixed(),
        entryThreshold: threshold.toFixed(),
        fastVsThresholdPercent: fastNow.div(threshold).minus(1).times(100).toFixed(2),
        waitingFor: fastNow.gt(threshold) ? 'fall-back-then-cross-up' : 'cross-up',
      }),
    ]);
  }
  // Resolve the quote budget (percentage sizing + reserve cap) before sizing the
  // order; a typed skip here is a held entry with a specific reason, not a guess.
  // An ENTRY-TIME measurement: the risk cap inside sizing derives the initial stop distance from this tick's closed window and from the price this entry will fill at, which is also the price the first stop is anchored to (`highSinceEntry` below is seeded to the same `currentPrice`). The resting stop is re-derived from each later tick's own window, so the distance this size was set against can drift after entry. Only volatility can widen it: the high-water mark is monotone, so the ratcheting-high leg only ever tightens.
  const budget = resolveEntryBudget(config, account, market.symbolInfo.quoteAsset, {
    price: market.currentPrice,
    candles,
  });
  if ('skip' in budget) {
    return hold(
      state,
      [log('warn', 'momentum: entry skipped', { reason: budget.skip, symbol: market.symbol })],
      [skipMetric('entry', budget.skip)],
      { reason: budget.skip },
    );
  }
  const sized = computeEntryQuantity(
    budget.budget,
    market.currentPrice,
    market.symbolInfo.filters,
    entryStopFloor(config, candles, market.currentPrice),
  );
  if ('skip' in sized) {
    return hold(
      state,
      [log('warn', 'momentum: entry skipped', { reason: sized.skip, symbol: market.symbol })],
      [skipMetric('entry', sized.skip)],
      { reason: sized.skip },
    );
  }
  const decision: Decision = {
    type: 'place-order',
    intent: {
      symbol: market.symbol,
      side: 'BUY',
      reason: 'entry',
      clientOrderId: entryClientOrderId(profile.id, market.symbol, candleCloseMs),
    },
    params: { type: 'MARKET', quantity: sized.quantity },
  };
  const nextState: MomentumState = {
    schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
    entryPrice: market.currentPrice,
    highSinceEntry: market.currentPrice,
    // Seeded on the first held tick from the 1m window, not here: at entry the
    // profit trail is definitionally unarmed, and seeding it to the entry price
    // would be indistinguishable from "no 1m candle has closed yet".
    profitHigh: null,
    heldQuantity: sized.quantity,
    lastEntryCandleMs: candleCloseMs,
    profitTrailSinceMs: profitTrailEpoch(market.candlesByInterval['1m'] ?? []),
    // A fired entry is the definitive clear: the next re-block is a fresh
    // null -> reason edge the worker appends.
    entryBlocker: null,
    // The stop arms on the next tick, once the fill is known: nothing to report.
    protectiveStopBlocker: null,
    exitBlocker: null,
    nativeTrail: null,
    // The weekendGap trigger has no layer of its own; its stamp arms the Friday target and time stop.
    entryLayer: layer ?? (config.entryTrigger === 'weekendGap' ? 'weekend-gap' : null),
  };
  return {
    nextState,
    decisions: [decision],
    logs: [
      log(
        'info',
        layer === 'below-trend'
          ? 'momentum: entry on breakout below the trend line'
          : config.entryTrigger === 'trend'
            ? 'momentum: entry with fast EMA above slow'
            : config.entryTrigger === 'breakout'
              ? 'momentum: entry on breakout above the lookback high'
              : config.entryTrigger === 'impulse'
                ? 'momentum: entry on impulse candle'
                : config.entryTrigger === 'maCluster'
                  ? 'momentum: entry on break above bunched averages'
                  : config.entryTrigger === 'exhaustion'
                    ? 'momentum: entry on exhausted sell-off'
                    : config.entryTrigger === 'obvLead'
                      ? 'momentum: entry on OBV leading price'
                      : config.entryTrigger === 'weekendGap'
                        ? 'momentum: entry on weekend gap below the Friday close'
                        : config.entryTrigger === 'trendQuality'
                          ? 'momentum: entry on a fresh straight rising trend'
                          : 'momentum: entry on EMA cross-up',
        {
          symbol: market.symbol,
          price: market.currentPrice,
          quantity: sized.quantity,
        },
      ),
    ],
    metrics: [metric('momentum.entry')],
  };
};

const evaluateExit = (
  input: MomentumInput,
  entryPrice: string,
  crossDown: boolean,
  lastCandle: Candle,
  candles: readonly Candle[],
  // Operator force-sell (a `trigger-sell` override in the bundle) flattens the
  // position now, regardless of the trail or EMA cross. Read by the caller so the
  // warm-up early-return sees it too; a fixture / empty bundle reads as no
  // override, keeping replays byte-identical.
  forceSell: boolean,
): MomentumOutput => {
  const { state, config, market, profile } = input;
  // Ratchet the high-water mark on the CLOSED candle's close, never on the live
  // currentPrice — a transient intra-candle wick must not tighten the stop. The
  // entry price is the floor (highSinceEntry may be null after a fill-adopter
  // reset). The trail FIRES against live currentPrice so it reacts intra-candle.
  const prevHigh = new Decimal(state.highSinceEntry ?? entryPrice);
  const closedClose = new Decimal(lastCandle.close);
  // A candle that had already closed when the entry landed is a peak this position never held, so folding it rests the first stop a retrace below yesterday's close instead of below the entry: the operator's configured initial risk stops being the one resting on the exchange, and the realised risk drifts with wherever inside yesterday's range the entry happened to land.
  // Strictly `>` because the stamp is the close time of the last candle that had already CLOSED when the buy fired — the candle whose close produced the cross, not the one the buy landed in, since a cross stays live for the rest of the following candle — so `>=` would re-admit that pre-entry close.
  // A null stamp fails OPEN: a wallet-reconciled position never carries one, and gating on it would pin the mark at the entry price for the life of that position and stop the hard leg ratcheting at all, which is strictly worse than admitting a single pre-entry close.
  // Editing `candleInterval` on a profile that already holds a position leaves the stamp untouched, so switching to a LONGER interval makes the newest closed candle older than the stamp and the hard leg cannot ratchet until the first candle of the new interval closes: bounded to at most one candle of that interval and self-healing. Deliberately not relaxed to fail open when the stamp is ahead of the window — a momentarily stale window would then re-admit exactly the pre-entry close this gate exists to exclude.
  const entryCandleMs = lastEntryCandle(state);
  const closedAfterEntry = entryCandleMs === null || lastCandle.closeTimeMs > entryCandleMs;
  const madeNewHigh = closedAfterEntry && closedClose.gt(prevHigh);
  const effectiveHigh = madeNewHigh ? closedClose : prevHigh;
  const entry = new Decimal(entryPrice);
  // The profit leg advances on closed 1m candles instead, which the worker feeds
  // for every symbol regardless of `candleInterval`. That is the whole point: on
  // a 1d profile the hard leg above is 24h stale, so an intraday run would be
  // unprotected until the next daily close.
  // Establish the epoch when the state carries none. The entry tick stamps it,
  // but the fill adopter clears it on every adopted buy (it holds no candle
  // window to derive one from), and a wallet-reconciled position never had one.
  // Without this the mark would stay pinned at the entry price for the life of
  // the position and the leg would never arm. Establishing it late only ever
  // folds FEWER closes, so it cannot admit a peak the position never held.
  const profitSinceMs =
    profitTrailSince(state) ?? profitTrailEpoch(market.candlesByInterval['1m'] ?? []);
  const profitHigh = ratchetProfitHigh(
    config,
    decOrNull(state.profitHigh),
    entry,
    market.candlesByInterval['1m'] ?? [],
    profitSinceMs,
  );
  const resting = findRestingProtectiveStop(input.openOrders, profile.id, market.symbol);
  const previousStop =
    resting !== undefined && resting.trailingDelta === undefined
      ? decOrNull(resting.stopPrice)
      : null;
  const level = resolveStopLevel(
    config,
    entry,
    effectiveHigh,
    profitHigh,
    candles,
    {
      reference: market.currentPrice,
      band: market.symbolInfo.filters.percentPriceBySide,
    },
    previousStop,
  );
  const price = new Decimal(market.currentPrice);
  // A null level means NEITHER leg resolved — no usable retrace fraction, no
  // computable ATR, no armed profit leg — so hold, never sell. The resting stop
  // is cancelled by the arm below for the same reason.
  const trailHit = level.stop !== null && price.lte(level.stop);
  // The weekend gap legs need 1h candles, the only interval the Sunday and Friday hours exist on. The stamp names the rule that opened the position, so one another trigger opened (even on the same Sunday candle) or an adopted or wallet-reconciled one (the adapter clears entryLayer) gets no Friday target or time limit, and a weekend-gap position keeps both after the operator switches triggers.
  const gapLegs =
    config.candleInterval === '1h' && entryCandleMs !== null && state.entryLayer === 'weekend-gap';
  const target = gapLegs ? weekendGapTarget(candles, entryCandleMs) : null;
  const gapFilled = target !== null && price.gte(target);
  const timeStop =
    gapLegs &&
    lastCandle.closeTimeMs - entryCandleMs >=
      weekendGapSettings(config.weekendGap).maxHoldBars * 3_600_000;

  if (forceSell || trailHit || gapFilled || timeStop || crossDown) {
    if (state.heldQuantity === null) {
      // Long with no tracked quantity (entry price revived before the held-qty
      // reconciler ran). A trail / cross-down defers and self-heals: the signal
      // recurs next tick once the quantity is pinned. A force-sell does NOT
      // recur on its own — it is a one-shot override — so ask the worker to keep
      // it armed (`overrideDeferred`) instead of letting it be consumed by a tick
      // that did nothing. The blocker is transient by construction: the held-qty
      // reconciler pins the quantity within a tick or two. `force-sell-no-held`
      // stays a distinct metric reason so the defer is queryable.
      const deferred = hold(
        state,
        [
          log(
            'warn',
            forceSell
              ? 'momentum: operator force-sell could not execute — no tracked quantity yet'
              : 'momentum: exit signal but no held quantity',
            { symbol: market.symbol },
          ),
        ],
        [skipMetric('exit', forceSell ? 'force-sell-no-held' : 'no-held')],
      );
      // Absent rather than `false` (exactOptionalPropertyTypes) so a trail /
      // cross-down hold, which has no override to speak for, keeps its existing shape.
      return forceSell
        ? { ...deferred, overrideDeferred: true, overrideDeclineReason: 'force-sell-no-held' }
        : deferred;
    }
    const sized = computeExitQuantity(
      state.heldQuantity,
      market.currentPrice,
      market.symbolInfo.filters,
    );
    if ('skip' in sized) {
      // Deliberately NOT deferred, even under a force-sell: an exchange-filter
      // rejection (dust below minQty/minNotional) is permanent for this position,
      // so re-arming the override would replay this same refusal every tick until
      // the TTL expired. The operator needs the warn, not a stuck override.
      const skipped = hold(
        state,
        [log('warn', 'momentum: exit skipped', { reason: sized.skip, symbol: market.symbol })],
        [skipMetric('exit', sized.skip)],
      );
      // Only an override-driven exit has an override to explain itself to; a
      // trail / cross-down skip has none.
      return forceSell ? { ...skipped, overrideDeclineReason: sized.skip } : skipped;
    }
    const reason = forceSell
      ? 'operator-force-sell'
      : trailHit
        ? 'trailing-stop'
        : crossDown
          ? 'ema-cross'
          : gapFilled
            ? 'gap-filled'
            : 'time-stop';
    // A force-sell exit exists to carry out the operator's override, so it
    // carries the override's id: that stamp is the only thing that lets the
    // worker tie this order's real outcome back to the row the operator is
    // watching. A trail / cross-down exit is the strategy's own and carries none.
    const overrideActionId = forceSell ? input.bundle.override?.overrideActionId : undefined;
    const sell: Decision = {
      type: 'place-order',
      intent: {
        symbol: market.symbol,
        side: 'SELL',
        reason: 'exit',
        clientOrderId: exitClientOrderId(profile.id, market.symbol, lastCandle.closeTimeMs),
        ...(overrideActionId === undefined ? {} : { overrideActionId }),
      },
      params: { type: 'MARKET', quantity: sized.quantity },
    };
    // Carry the entry stamp through the flatten: this flat state is exactly what
    // a same-cross re-entry would fire from.
    const nextState: MomentumState = {
      schemaVersion: MOMENTUM_STATE_SCHEMA_VERSION,
      entryPrice: null,
      highSinceEntry: null,
      profitHigh: null,
      heldQuantity: null,
      lastEntryCandleMs: lastEntryCandle(state),
      // The epoch does NOT carry through: it bounds the profit trail of the
      // position being closed, and a same-cross re-entry stamps its own.
      profitTrailSinceMs: null,
      // An exit is not an entry suppression; leave the field clear.
      entryBlocker: null,
      // Flat: there is no position left to protect, so no stop to be blocked.
      protectiveStopBlocker: null,
      exitBlocker: null,
      nativeTrail: null,
      entryLayer: null,
    };
    return {
      nextState,
      // One atomic request retires the resting protective stop AND places the exit. Two separate requests would leave both live against the same base for the round trip between them.
      decisions: closingSellDecisions(input, sell),
      logs: [
        log('info', 'momentum: exit', {
          symbol: market.symbol,
          reason,
          price: market.currentPrice,
          quantity: sized.quantity,
        }),
      ],
      metrics: [metric('momentum.exit', { reason })],
    };
  }

  // Hold the long: ratchet the high-water mark and arm / reprice the resting
  // protective stop against the same trailing level.
  const newHigh = madeNewHigh ? closedClose.toString() : (state.highSinceEntry ?? entryPrice);
  // A held long is not entry-suppressed, so clear any blocker the state carries.
  // A fill adopted out-of-band (the reconciler sets entryPrice without routing
  // through evaluateEntry) could leave a stale reason here; normalising it on
  // every held tick keeps the exit from emitting a spurious unblock row.
  const held: MomentumState = {
    ...state,
    highSinceEntry: newHigh,
    profitHigh: level.profitHigh?.toString() ?? null,
    // Persist whatever epoch this tick resolved, so an adopted fill costs the
    // profit leg one tick rather than the whole position.
    profitTrailSinceMs: profitSinceMs,
    entryBlocker: null,
  };
  // The resting stop mirrors the SAME resolved level the trail just tested, so
  // the two cannot report different numbers.
  const arm = evaluateProtectiveStopArm(input, held, level, entry);
  const attemptedDistance = desiredTrailDistance(config, level, entry);
  const profitArmed = profitLegDistance(config, level.profitHigh, entry) !== null;
  // Two orderings carry weight here, and they fail in opposite directions. "Nothing is resting" is tested BEFORE the reason nothing native could rest: `nativeUnavailable` is derived from the config mode, the wanted distance and the symbol's trailingDelta filter alone — it never consults the open orders — so testing it first reported a symbol whose filter refuses the distance as falling back to a priced stop on every held tick, including the ticks where the priced fallback also failed to land and the position was in fact naked, and the unplaced span an unprotected position is watched by never opened. Among the stops that ARE resting, the order's own shape is tested before the cause, because that same cause is derived from the PRIMARY wanted distance alone and cannot see the band escape, which rests its trail at an independently configured distance the filter may well accept: asking the cause first described a resting exchange trail as a resting priced fallback, which is the one shape it cannot be. Neither ordering loses the cause — it rides `detail`.
  const exitBlocker: MomentumState['exitBlocker'] =
    config.protectiveStop?.enabled !== true
      ? null
      : resting === undefined
        ? {
            reason: 'protective-stop-unplaced',
            // The native-unavailable fact belongs in the identity so that a flip between the two unplaced shapes rewrites `detail`, which is otherwise frozen at the span's start. This key is not stable: under `atrTrailingStop` the wanted distance is recomputed from live candles every tick and the filter bounds are judged strictly, so a distance oscillating across a bound flips it while the position stays unplaced. Each flip costs one `condition_states` rewrite and one activity-feed edge — and never the span, because only a change of CODE restarts `since`, and the code does not move. The stop level stays out because it would pay that cost on every tick rather than on a bound crossing.
            changeKey: arm.nativeUnavailable ? 'unplaced|native-unavailable' : 'unplaced',
            detail: {
              stop: level.stop?.toFixed() ?? null,
              ...(arm.nativeUnavailable
                ? { nativeUnavailable: true, distancePct: attemptedDistance?.toFixed() ?? null }
                : {}),
            },
          }
        : resting.trailingDelta !== undefined
          ? {
              reason: profitArmed ? 'profit-leg-armed' : 'native-trail-resting',
              changeKey: `native|delta=${resting.trailingDelta}`,
              detail: { trailingDelta: resting.trailingDelta, quantity: resting.origQty },
            }
          : arm.nativeUnavailable
            ? {
                reason: 'native-trail-unavailable',
                changeKey: 'native-trail-unavailable',
                detail: {
                  distancePct: attemptedDistance?.toFixed() ?? null,
                  fallback: 'priced',
                },
              }
            : {
                reason: 'priced-stop-resting',
                changeKey: `priced|stop=${resting.stopPrice}`,
                detail: { stop: resting.stopPrice },
              };
  const nativeHigh = nativeTrailHigh(input, held, resting);
  const nativeTrail: MomentumState['nativeTrail'] =
    nativeHigh === null ? null : { orderId: resting!.orderId, high: nativeHigh.toFixed() };
  // Only the stop-arm outcome writes this field: a refused stop must be visible on
  // the dashboard for as long as it is refused, and must clear itself the tick it
  // arms. It never gates an ENTRY — the position is already open.
  const nextState: MomentumState = {
    ...held,
    protectiveStopBlocker: arm.blocker,
    exitBlocker,
    nativeTrail,
  };
  return {
    nextState,
    decisions: arm.decisions.length > 0 ? arm.decisions : [{ type: 'noop' }],
    logs:
      arm.blocker === null
        ? [
            log('debug', 'momentum: holding long', {
              symbol: market.symbol,
              highSinceEntry: newHigh,
            }),
          ]
        : [
            // An open position with no protective stop is not a debug detail. One
            // still covered by the previous level is a different, quieter fact:
            // logging it at warn every tick, for as long as a winning trail sits
            // outside the band, is how the real warning gets skimmed past.
            arm.blocker.detail['guarded'] === true
              ? log('info', 'momentum: protective stop held at its previous level', {
                  symbol: market.symbol,
                  reason: arm.blocker.reason,
                  ...arm.blocker.detail,
                })
              : log('warn', 'momentum: protective stop not armed', {
                  symbol: market.symbol,
                  reason: arm.blocker.reason,
                  ...arm.blocker.detail,
                }),
          ],
    // The refusal is a SKIP with a reason, like every entry suppression: that is
    // what makes it queryable and what gives the attribution gloss a consumer.
    // Alongside it, the quieter case: the band did not refuse the stop, it moved
    // it, and the operator's configured level is not the one resting.
    //
    // Gated on decisions because the series counts adjustments APPLIED, not ticks
    // spent holding an adjusted stop. `level.floorClamped` stays true for as long
    // as the clamp binds, so an ungated emit would count held ticks here while the
    // sibling strategy counts orders — one name meaning two things, and a sum
    // across strategies meaning nothing. "Is my stop clamped right now" is a state
    // question, answered by the blocker surfaces, not by a counter.
    metrics: [
      ...(arm.blocker === null ? [] : [skipMetric('sell', arm.blocker.reason)]),
      ...(arm.decisions.length === 0
        ? []
        : protectiveStopBandAdjustment({
            symbol: market.symbol,
            floorClamped: level.floorClamped,
            nativeTrailed: arm.nativeTrailed,
          })),
    ],
  };
};
