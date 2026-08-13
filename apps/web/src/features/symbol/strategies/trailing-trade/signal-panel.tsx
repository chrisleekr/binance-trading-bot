// Symbol signal panel — the operator's "how do I get out, and when" readout.
//
// For a held position it draws an EXIT MAP: a price ladder centred on the
// current price, profit exits above and protective exits below, each with the
// signed gap, and the single nearest exit flagged. Below the ladder sit the two
// non-price exits — the Technicals force-sell and the daily regime exit (with a
// live "N of M closes below the line" countdown). For a flat position it shows
// the entry gates plus a regime-block notice when the daily trend is bearish.
//
// The trailing-trade math is a pure function of (config, state, currentPrice);
// it is replayed here with Number() math. Display-only — these values never
// feed an order, the worker re-derives every threshold in Decimal at decision
// time. Same decimal-barred-web pattern as `gridPricesFrom` in the symbol route.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  fetchSymbolCandles,
  symbolCandleBucketMs,
  symbolCandlesQueryKey,
} from '@/features/symbol/api/symbol';
import {
  fetchTechnicalsRecommendations,
  technicalsRecommendationsQueryKey,
} from '@/features/technicals/api/technicals';
import { formatAmount, formatPrice } from '@/shared/lib/format';

import {
  deriveBullHold,
  deriveRegimeExit,
  parseBullHoldParams,
  parseRegimeExitParams,
  REGIME_FRAMES,
  type BullHoldStatus,
  type RegimeExitStatus,
} from './regime-status.js';
import { asRecord, parseNum } from './lib.js';

import type { SymbolStateResponse, TechnicalsResponse } from '@app/contracts';

// The TT state fields this mirror reads. A local shape, not an import of the
// strategy package's `TTState`: that package's index transitively pulls
// node-only modules (strategy-core's replay), which apps/web's browser
// tsconfig cannot compile. The parity test (a node-env vitest process) imports
// the real `TTStateSchema` to build fixtures and pins these names against drift.
interface TTStateMirror {
  readonly discoveryEntry?: boolean;
  readonly entryAtMs?: number | null;
  readonly breakEvenArmed?: boolean;
}

interface PriceTarget {
  readonly price: number;
  /** Signed percent the current price sits relative to this target: (current / price - 1) * 100. Null when no current price. */
  readonly gapPct: number | null;
}

/**
 * Status of the force-sell-on-Technicals row. The four branches mirror the
 * strategy's `evaluateTechnicalsForceSell` decision tree so an operator can
 * read the row and predict the worker's next tick decision without diffing
 * code.
 *
 * - `would-fire`: every guard passes AND a configured interval reports a
 *   matching recommendation right now — the next tick will emit a sell.
 * - `waiting-signal`: guards pass but no interval reports a matching
 *   recommendation; the rule is armed.
 * - `above-trigger`: current price is at or above the sell-trigger; the
 *   normal sell ladder is responsible.
 * - `in-loss`: current price is at or below `avgEntryPrice`; the
 *   profit-only guard blocks force-sell unconditionally.
 */
type ForceSellStatus =
  | { readonly kind: 'would-fire'; readonly interval: string; readonly recommendation: string }
  | { readonly kind: 'waiting-signal'; readonly intervals: readonly string[] }
  | { readonly kind: 'above-trigger' }
  | { readonly kind: 'in-loss' };

interface ForceSellView {
  readonly trigger: PriceTarget;
  readonly status: ForceSellStatus;
}

/** Discriminated view the panel renders. `unavailable` covers a non-trailing-trade or unparsed strategy payload. */
type SignalView =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'flat'; readonly buyEnabled: boolean; readonly gates: readonly string[] }
  | {
      readonly kind: 'holding';
      readonly avgEntryPrice: number;
      readonly current: number | null;
      readonly rungIndex: number;
      readonly rungTotal: number;
      readonly nextBuy: PriceTarget | null;
      /** True for a position opened by auto-discovery: a single-entry momentum
       * bet that never averages down (the grid is suppressed) and that the
       * discovery time-stop can exit. */
      readonly discoveryEntry: boolean;
      /** Present for a discovery entry with a configured time-stop: the bar
       * count + trading interval after which a stale single-entry is
       * market-sold to cash. Null when not a discovery entry or the time-stop
       * is disabled (`discoveryTimeStopBars` = 0). */
      readonly discoveryTimeStop: { readonly bars: number; readonly interval: string } | null;
      /** Present for a NON-discovery position with a configured general time-stop
       * that has NOT reached its sell trigger (`highSinceBuy === null`): the bar
       * count + interval after which a stalled position is market-sold for going
       * nowhere. Null when disabled, a discovery entry, or the trail has armed. */
      readonly timeStop: { readonly bars: number; readonly interval: string } | null;
      readonly sellArm: PriceTarget | null;
      readonly trailingStop: PriceTarget | null;
      /** True once the position has a running high (`highSinceBuy`): the trailing stop is then an active exit, not a pending one. Unarmed, NO trailing exit exists at any price. */
      readonly trailingArmed: boolean;
      /** True when some trail exists for the sell arm to arm: a fixed retrace
       * percentage, the ATR trail, or the bull hold. False means reaching the
       * sell arm sets a high-water mark that nothing consumes, so the arm is not
       * a gate on any exit. */
      readonly trailConfigured: boolean;
      readonly stopLoss: PriceTarget | null;
      /** Break-even stop, when enabled. `stage: 'arm'` is the level price must
       * rise to (on a closed candle) to arm the floor; `stage: 'floor'` is the
       * armed near-entry exit, shown only while the profit trail has not taken
       * over. Null when disabled, or armed but superseded by the trail. */
      readonly breakEven: { readonly stage: 'arm' | 'floor'; readonly target: PriceTarget } | null;
      /**
       * True when the worker recorded that NOTHING configured would exit this
       * position below the entry: it can only close at a profit or by hand.
       * False when it recorded an exit; null when it recorded nothing either
       * way, which must not render as reassurance.
       */
      readonly noDownsideExit: boolean | null;
      /** Present when any configured Technicals interval has at least one of
       * `whenSell` / `whenStrongSell` / `whenNeutral` enabled — i.e. when the
       * force-sell-on-Technicals rule has anything to do for this profile. */
      readonly forceSell: ForceSellView | null;
      /** Bull-pyramid readout when `regime.onBull.pyramid` is enabled, else null.
       * `nextAdd` is null once the add cap is reached. */
      readonly pyramid: {
        readonly addCount: number;
        readonly maxAdds: number;
        readonly nextAdd: PriceTarget | null;
      } | null;
    };

const target = (price: number, currentPrice: number | null): PriceTarget => ({
  price,
  gapPct: currentPrice !== null && price > 0 ? (currentPrice / price - 1) * 100 : null,
});

/**
 * Human-readable list of the preconditions a buy emission must satisfy: the
 * indicator-gate knobs that are enabled plus the Technicals gate. An empty
 * list means the entry fires on the next tick with nothing to wait for. Lets
 * a flat profile see what it is waiting on, not just that it is flat.
 */
function entryGates(
  buy: Record<string, unknown> | null,
  config: Record<string, unknown>,
): readonly string[] {
  const gates: string[] = [];
  const gate = asRecord(buy?.['indicatorGate']);
  // rsiMaxBuy is constrained to (0, 100]; empty/'0'/out-of-range is "no gate".
  const rsiMax = parseNum(gate?.['rsiMaxBuy']);
  if (rsiMax !== null && rsiMax > 0 && rsiMax <= 100) {
    gates.push(`RSI(14) at or below ${rsiMax}`);
  }
  const sma = gate?.['smaBias'];
  if (sma === 'price-below-sma') gates.push('price below SMA(20)');
  else if (sma === 'price-above-sma') gates.push('price above SMA(20)');
  const ema = gate?.['emaBias'];
  if (ema === 'price-below-ema') gates.push('price below EMA(20)');
  else if (ema === 'price-above-ema') gates.push('price above EMA(20)');
  // Technicals gate: the master switch (`forceBuyOverride.checkTechnicals`)
  // defaults to `true`, so an absent override leaves the gate active. The
  // strategy's `technicals-gate` also opens the gate when `intervals[]` is empty
  // (TV opted out at the profile level) or when no row has a non-empty
  // allow-buy set (every row is force-sell-only). Match that so the panel
  // does not claim a non-existent gate.
  const tvCheck = asRecord(config['forceBuyOverride'])?.['checkTechnicals'];
  if (tvCheck !== false) {
    const tvBlock = asRecord(config['technicals']);
    const rawIntervals = Array.isArray(tvBlock?.['intervals']) ? tvBlock['intervals'] : [];
    const buyParticipating = rawIntervals
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => row !== null)
      .filter((row) => row['whenStrongBuy'] === true || row['whenBuy'] === true)
      .map((row) => (typeof row['interval'] === 'string' ? row['interval'] : null))
      .filter((iv): iv is string => iv !== null);
    if (buyParticipating.length > 0) {
      gates.push(`Technicals signal allows the buy on ${buyParticipating.join(' + ')}`);
    }
  }
  return gates;
}

/**
 * Builds the Technicals force-sell status for a held position.
 *
 * @param config - Strategy configuration containing Technicals sell rules
 * @param lbp - Average entry price
 * @param current - Current market price, if available
 * @param sellTrigger - Configured force-sell price multiplier
 * @param signals - Latest Technicals signals and freshness settings
 * @param nowMs - Current time used to assess signal freshness
 * @returns The force-sell view, or `null` when no Technicals sell rule is configured
 */
function forceSellViewOf(
  config: Record<string, unknown>,
  lbp: number,
  current: number | null,
  sellTrigger: number | null,
  signals: TechnicalsResponse | undefined,
  nowMs: number,
): ForceSellView | null {
  if (sellTrigger === null || sellTrigger <= 0) return null;
  const tvBlock = asRecord(config['technicals']);
  const rawIntervals = Array.isArray(tvBlock?.['intervals']) ? tvBlock['intervals'] : [];
  const participating = rawIntervals
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter(
      (row) =>
        row['whenSell'] === true || row['whenStrongSell'] === true || row['whenNeutral'] === true,
    );
  if (participating.length === 0) return null;
  const triggerPrice = lbp * sellTrigger;
  const trigger = target(triggerPrice, current);
  const intervals: string[] = participating
    .map((row) => (typeof row['interval'] === 'string' ? row['interval'] : null))
    .filter((iv): iv is string => iv !== null);

  // Signal-independent guards mirror `evaluateTechnicalsForceSell`.
  if (current === null) return { trigger, status: { kind: 'waiting-signal', intervals } };
  if (current >= triggerPrice) return { trigger, status: { kind: 'above-trigger' } };
  if (current <= lbp) return { trigger, status: { kind: 'in-loss' } };

  // Signal-dependent: only computable when the technicals query has landed.
  if (!signals) return { trigger, status: { kind: 'waiting-signal', intervals } };
  const useOnlyWithinMin = signals.technicals.useOnlyWithinMin;
  const maxAgeMs = useOnlyWithinMin * 60_000;
  const item = signals.items.find((row) =>
    intervals.some((iv) => row.signals.some((s) => s.interval === iv)),
  );
  const intervalSignals = item?.signals ?? [];
  for (const row of participating) {
    const interval = typeof row['interval'] === 'string' ? row['interval'] : null;
    if (interval === null) continue;
    const triggers = new Set<string>();
    if (row['whenSell'] === true) triggers.add('SELL');
    if (row['whenStrongSell'] === true) triggers.add('STRONG_SELL');
    if (row['whenNeutral'] === true) triggers.add('NEUTRAL');
    const signal = intervalSignals.find((s) => s.interval === interval)?.signal;
    if (!signal) continue;
    const ageMs = Math.max(0, nowMs - signal.receivedAtMs);
    if (ageMs > maxAgeMs) continue;
    if (triggers.has(signal.recommendation)) {
      return {
        trigger,
        status: { kind: 'would-fire', interval, recommendation: signal.recommendation },
      };
    }
  }
  return { trigger, status: { kind: 'waiting-signal', intervals } };
}

/**
 * Builds the signal-panel view for a symbol's current strategy state.
 *
 * @param strategy - The strategy configuration and state
 * @param holding - The symbol's average entry price
 * @param currentPrice - The current market price
 * @param exitBlocker - The worker's recorded downside-exit status
 * @param signals - Current Technicals signals used for force-sell status
 * @param nowMs - Timestamp used to determine signal freshness
 * @returns The signal view for an unavailable, flat, or held position
 */
export function deriveSignal(
  strategy: SymbolStateResponse['strategy'],
  holding: SymbolStateResponse['avgEntryPrice'],
  currentPrice: string | null,
  exitBlocker: SymbolStateResponse['exitBlocker'] = null,
  signals?: TechnicalsResponse,
  nowMs: number = Date.now(),
): SignalView {
  const config = asRecord(strategy.config);
  const state = asRecord(strategy.state);
  if (!config || !state) return { kind: 'unavailable' };

  const buy = asRecord(config['buy']);
  const sell = asRecord(config['sell']);
  // `holding != null` (not `!== null`) — during a navigation/HMR boundary
  // the prop can be momentarily `undefined` before TanStack Query resolves.
  const lbp = holding != null ? parseNum(holding.avgEntryPrice) : null;
  const current = parseNum(currentPrice);

  if (lbp === null) {
    return {
      kind: 'flat',
      buyEnabled: buy?.['enabled'] === true,
      gates: entryGates(buy, config),
    };
  }

  const gridLevels = Array.isArray(buy?.['gridLevels']) ? buy['gridLevels'] : [];
  const rungIndex = parseNum(state['currentGridTradeIndex']) ?? 0;

  // A discovery single-entry never averages down — the strategy's grid-buy
  // branch returns noop for `discoveryEntry`, so any "next grid buy" the mirror
  // drew was a phantom level that can never fire. Suppress it.
  const discoveryEntry = (state as TTStateMirror).discoveryEntry === true;
  const nextLevelTrigger = parseNum(asRecord(gridLevels[rungIndex + 1])?.['triggerPercentage']);
  const nextBuy =
    !discoveryEntry && nextLevelTrigger !== null ? target(lbp * nextLevelTrigger, current) : null;

  // Discovery time-stop: a stale single-entry is market-sold after this many
  // closed `candleInterval` candles from entry. Mirrors sell-gate.ts exactly —
  // including its `entryAtMs !== null` guard, so the readout can never claim an
  // exit the worker would not fire (a discovery entry always sets entryAtMs
  // atomically today, but matching the guard keeps the mirror honest if a
  // future partial state reset ever decoupled them).
  const entryAtMs = (state as TTStateMirror).entryAtMs;
  const timeStopBars = parseNum(sell?.['discoveryTimeStopBars']);
  const candleInterval =
    typeof config['candleInterval'] === 'string' ? config['candleInterval'] : '';
  const discoveryTimeStop =
    discoveryEntry && entryAtMs != null && timeStopBars !== null && timeStopBars > 0
      ? { bars: timeStopBars, interval: candleInterval }
      : null;

  const sellTrigger = parseNum(sell?.['triggerPercentage']);
  const sellArm =
    sellTrigger !== null && sellTrigger > 1 ? target(lbp * sellTrigger, current) : null;

  const stopLossPct = parseNum(sell?.['stopLossPercentage']);
  const stopLoss =
    stopLossPct !== null && stopLossPct > 0 ? target(lbp * stopLossPct, current) : null;

  const highSinceBuy = parseNum(state['highSinceBuy']);
  const trailingPct = parseNum(sell?.['trailingStopPercentage']);
  const trailingStop =
    highSinceBuy !== null && trailingPct !== null && trailingPct > 0
      ? target(highSinceBuy * trailingPct, current)
      : null;

  // General time-stop: a NON-discovery position that never reached its sell
  // trigger (highSinceBuy null) is market-sold after `timeStopBars` closed
  // candles. Mirrors sell-gate.ts exactly, including the highSinceBuy === null
  // gate, so the panel never claims an exit the worker would not fire.
  const generalTimeStopBars = parseNum(sell?.['timeStopBars']);
  const timeStop =
    !discoveryEntry &&
    entryAtMs != null &&
    highSinceBuy === null &&
    generalTimeStopBars !== null &&
    generalTimeStopBars > 0
      ? { bars: generalTimeStopBars, interval: candleInterval }
      : null;
  // Armed exactly when the worker has a running high to trail from: the sell
  // gate's trailing branches are gated on `highSinceBuy !== null` and nothing
  // else, and only the arm paths ever set it. Re-deriving the arm from the
  // sell-arm price instead would call an ATR `fromEntry` trail (armed at entry,
  // below the sell arm) unarmed while the worker was already trailing it.
  const trailingArmed = highSinceBuy !== null;

  // Is there a trail for the sell arm to arm at all? Mirrors the same three
  // config reads in sell-gate.ts: with none of them on, reaching the arm sets a
  // high-water mark nothing consumes, so naming the arm as the gate would
  // promise an exit that does not exist. Read off config, not the live regime
  // verdict, so the answer is stable tick to tick.
  const trailConfigured =
    (trailingPct !== null && trailingPct > 0) ||
    asRecord(sell?.['atrTrailing'])?.['enabled'] === true ||
    asRecord(asRecord(asRecord(config['regime'])?.['onBull'])?.['hold'])?.['enabled'] === true;

  // Break-even stop mirror: arms once a closed candle confirms a gain of
  // armAtPercentage, then a fall to floorPercentage (>= entry) sells near flat —
  // but only while the profit trail has not taken over (highSinceBuy null),
  // matching sell-gate.ts. Before arming, surface the arm level; once armed, the
  // floor; once the trail owns the position, nothing (the trailing row covers it).
  const beCfg = asRecord(sell?.['breakEven']);
  let breakEven: Extract<SignalView, { kind: 'holding' }>['breakEven'] = null;
  if (beCfg?.['enabled'] === true) {
    const beArmed = (state as TTStateMirror).breakEvenArmed === true;
    const beFloorPct = parseNum(beCfg['floorPercentage']);
    const beArmPct = parseNum(beCfg['armAtPercentage']);
    if (beArmed && highSinceBuy === null && beFloorPct !== null && beFloorPct > 0) {
      breakEven = { stage: 'floor', target: target(lbp * beFloorPct, current) };
    } else if (!beArmed && beArmPct !== null && beArmPct > 1) {
      breakEven = { stage: 'arm', target: target(lbp * beArmPct, current) };
    }
  }

  const hasDownsideExit = exitBlocker?.detail?.['hasDownsideExit'];
  const noDownsideExit = typeof hasDownsideExit === 'boolean' ? !hasDownsideExit : null;

  const forceSell = forceSellViewOf(config, lbp, current, sellTrigger, signals, nowMs);

  // Bull pyramid: "N of M adds" plus the next-add trigger price. The next add is
  // spaced one step above the last add (or avgEntryPrice for the first add),
  // mirroring the worker's evaluator; null once the cap is reached.
  const pyramidCfg = asRecord(asRecord(asRecord(config['regime'])?.['onBull'])?.['pyramid']);
  let pyramid: Extract<SignalView, { kind: 'holding' }>['pyramid'] = null;
  if (pyramidCfg?.['enabled'] === true) {
    const maxAdds = parseNum(pyramidCfg['maxAdds']) ?? 0;
    const step = parseNum(pyramidCfg['stepPercentage']);
    const addCount = parseNum(state['bullAddCount']) ?? 0;
    const anchor = parseNum(state['lastBullAddPrice']) ?? lbp;
    const nextAdd =
      step !== null && step > 0 && addCount < maxAdds ? target(anchor * (1 + step), current) : null;
    pyramid = { addCount, maxAdds, nextAdd };
  }

  return {
    kind: 'holding',
    avgEntryPrice: lbp,
    current,
    rungIndex,
    rungTotal: gridLevels.length,
    nextBuy,
    discoveryEntry,
    discoveryTimeStop,
    timeStop,
    sellArm,
    trailingStop,
    trailingArmed,
    trailConfigured,
    stopLoss,
    breakEven,
    noDownsideExit,
    forceSell,
    pyramid,
  };
}

// Display precision matches the header/chart (shared formatPrice: 2dp at or
// above 1, finer below) so the same price doesn't read at 8dp here and 2dp
// elsewhere on one screen. Full precision is preserved in the title.
const fmtPrice = (n: number): string => formatPrice(String(n));

/**
 * True when the profile's strategy config has any Technicals interval with at
 * least one of `whenSell` / `whenStrongSell` / `whenNeutral` enabled — i.e.
 * when the force-sell-on-Technicals rule has anything to do. Pulled out so
 * the panel can short-circuit the technicals query when the rule is dormant.
 */
function hasForceSellTrigger(strategy: SymbolStateResponse['strategy']): boolean {
  const config = asRecord(strategy.config);
  if (!config) return false;
  const tvBlock = asRecord(config['technicals']);
  const rawIntervals = Array.isArray(tvBlock?.['intervals']) ? tvBlock['intervals'] : [];
  return rawIntervals.some((row) => {
    const r = asRecord(row);
    return (
      r !== null &&
      (r['whenSell'] === true || r['whenStrongSell'] === true || r['whenNeutral'] === true)
    );
  });
}

/** The regime config knobs the daily-candle query needs, or null when the
 *  cash-rotation exit is disabled. Delegates to the shared `parseRegimeExitParams`
 *  so the fetched window and the verdict computation read one parse with one set
 *  of (clamped) defaults. */
function regimeQueryConfig(
  strategy: SymbolStateResponse['strategy'],
): { period: number; confirmBars: number } | null {
  const params = parseRegimeExitParams(asRecord(strategy.config));
  return params === null ? null : { period: params.period, confirmBars: params.confirmBars };
}

/** The bull-hold daily-window knobs, or null when bull hold is disabled. The
 *  daily candle query is shared with the regime-exit readout, so either feature
 *  being enabled fetches the same `1d` series. */
function bullHoldQueryConfig(
  strategy: SymbolStateResponse['strategy'],
): { period: number; confirmBars: number } | null {
  const params = parseBullHoldParams(asRecord(strategy.config));
  return params === null ? null : { period: params.period, confirmBars: params.confirmBars };
}

/** Operator-facing text for each ForceSellStatus branch. */
function forceSellStatusText(s: ForceSellStatus): string {
  switch (s.kind) {
    case 'would-fire':
      return `FIRES NOW · ${s.recommendation} on ${s.interval}`;
    case 'waiting-signal':
      return s.intervals.length === 0
        ? 'awaiting matching signal'
        : `awaiting matching signal on ${s.intervals.join(' or ')}`;
    case 'above-trigger':
      return 'price above trigger — armed gate idle';
    case 'in-loss':
      return 'in loss — force-sell gated until in profit';
  }
}

const fmtGap = (gapPct: number | null): string => {
  if (gapPct === null) return '—';
  const sign = gapPct >= 0 ? '+' : '';
  return `${sign}${gapPct.toFixed(2)}%`;
};

// --- Exit-map ladder ------------------------------------------------------

type RowTone = 'profit' | 'loss' | 'arm' | 'add';

interface LadderRow {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly price: number;
  readonly gapPct: number | null;
  readonly tone: RowTone;
  /** True when hitting this price triggers a SELL (an exit). The nearest such row is flagged. */
  readonly sells: boolean;
  /** Short status suffix, e.g. armed / not-yet-armed for the trailing stop. */
  readonly note?: string;
  /**
   * True for the one row the position is actually waiting on when no profit exit
   * exists yet. Distinct from `sells`: reaching this price arms an exit rather
   * than firing one, so it is never a candidate for the nearest-exit flag, but it
   * is what the operator must watch.
   */
  readonly nextGate?: boolean;
}

const toneClass: Record<RowTone, string> = {
  profit: 'text-success',
  loss: 'text-danger',
  arm: 'text-warning',
  add: 'text-muted-fg',
};

/** Assemble the price-ordered ladder rows from a holding view (high price first). */
function ladderRows(view: Extract<SignalView, { kind: 'holding' }>): readonly LadderRow[] {
  const rows: LadderRow[] = [];
  if (view.sellArm) {
    // Unarmed, this is the only thing standing between the position and any
    // profit exit — nothing below it can fire, so it is named as the gate rather
    // than left as one more level in the list. With no trail configured there is
    // nothing to arm, and calling it the gate would promise an exit that does
    // not exist, the same phantom promise as drawing a trailing line with no
    // trail. The worker refuses to name the arm on that config too.
    const pending = !view.trailingArmed && view.trailConfigured;
    // Armed with no trailing row to follow it. `trailingStop` needs a fixed
    // retrace percentage, so an ATR or bull-hold trail arms without one: the
    // level lives in the worker's closed-candle ATR, which this mirror is not
    // given. Saying only "armed" would leave the operator hunting for an exit
    // level that is nowhere on the page.
    const unmirrored = view.trailingArmed && view.trailingStop === null;
    rows.push({
      key: 'sell-arm',
      label: 'Sell arm',
      hint: !view.trailConfigured
        ? 'Your sell trigger level. No trailing stop is configured, so reaching it starts no profit exit.'
        : pending
          ? 'Price rises to here → the trailing stop arms (profit-taking begins). Until it does there is no trailing exit at any price.'
          : unmirrored
            ? 'Price rises to here → the trailing stop arms (profit-taking begins). The bot computes that level from its own ATR reading, so it is not shown here.'
            : 'Price rises to here → the trailing stop arms (profit-taking begins).',
      price: view.sellArm.price,
      gapPct: view.sellArm.gapPct,
      tone: 'arm',
      sells: false,
      ...(pending ? { nextGate: true } : {}),
      note: !view.trailConfigured
        ? 'no trailing stop configured — reaching this arms nothing'
        : pending
          ? 'next gate — no trailing exit until price reaches here'
          : unmirrored
            ? 'armed — trailed from the ATR, level not mirrored here'
            : 'armed',
    });
  }
  // A trailing level exists only once armed (both are `highSinceBuy !== null`),
  // so the row is unconditionally a live exit — an unarmed trail has no price to
  // show and is covered by the sell-arm gate row above.
  if (view.trailingStop) {
    rows.push({
      key: 'trailing',
      label: 'Trailing stop',
      hint: 'A fall to this retrace level → market sell in profit.',
      price: view.trailingStop.price,
      gapPct: view.trailingStop.gapPct,
      tone: 'profit',
      sells: true,
      note: 'active exit',
    });
  }
  if (view.stopLoss) {
    rows.push({
      key: 'stop-loss',
      label: 'Stop-loss',
      hint: 'A fall to this level → market sell at a loss (capital preservation).',
      price: view.stopLoss.price,
      gapPct: view.stopLoss.gapPct,
      tone: 'loss',
      sells: true,
    });
  }
  if (view.breakEven) {
    const be = view.breakEven;
    rows.push({
      key: 'break-even',
      label: 'Break-even stop',
      hint:
        be.stage === 'arm'
          ? 'Price rises to here → the break-even stop arms; after that, a fall back toward entry sells near flat.'
          : 'A fall to this level → market sell near your entry, protecting a stalled move from the full stop-loss.',
      price: be.target.price,
      gapPct: be.target.gapPct,
      tone: be.stage === 'arm' ? 'arm' : 'profit',
      sells: be.stage === 'floor',
      note: be.stage === 'arm' ? 'not yet armed' : 'active exit',
    });
  }
  if (view.nextBuy) {
    rows.push({
      key: 'next-buy',
      label: 'Next grid buy',
      hint: 'A fall to this level → the next buy level executes (adds to the position, not an exit).',
      price: view.nextBuy.price,
      gapPct: view.nextBuy.gapPct,
      tone: 'add',
      sells: false,
    });
  }
  return rows.sort((a, b) => b.price - a.price);
}

/** Key of the nearest exit (smallest absolute gap among selling rows), or null. */
function nearestExitKey(rows: readonly LadderRow[]): string | null {
  let best: { key: string; abs: number } | null = null;
  for (const r of rows) {
    if (!r.sells || r.gapPct === null) continue;
    const abs = Math.abs(r.gapPct);
    if (best === null || abs < best.abs) best = { key: r.key, abs };
  }
  return best?.key ?? null;
}

/**
 * Renders an exit-ladder row with its price, gap, status, and relevant marker.
 *
 * @param row - The exit-ladder row to display
 * @param isNearest - Whether the row is nearest to the current price
 * @returns The rendered exit-ladder row
 */
function LadderRowView({
  row,
  isNearest,
}: {
  readonly row: LadderRow;
  readonly isNearest: boolean;
}): React.JSX.Element {
  return (
    <div
      className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs"
      data-testid={`exit-row-${row.key}`}
      data-nearest={isNearest ? 'true' : undefined}
      data-next-gate={row.nextGate === true ? 'true' : undefined}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        {isNearest ? (
          <span className="text-warning" aria-hidden title="Nearest exit">
            ⚡
          </span>
        ) : row.nextGate === true ? (
          <span className="text-warning" aria-hidden title="Next exit gate">
            ⚑
          </span>
        ) : null}
        <span className={toneClass[row.tone]} title={row.hint}>
          {row.label}
        </span>
        {row.note ? <span className="truncate text-muted-fg">· {row.note}</span> : null}
      </span>
      <span className="font-mono whitespace-nowrap">
        <span title={formatAmount(row.price)}>{fmtPrice(row.price)}</span>
        <span className="ml-2 text-muted-fg">{fmtGap(row.gapPct)}</span>
      </span>
    </div>
  );
}

/** The "you are here" divider band placed between the above-current and below-current rows. */
function CurrentRow({ current }: { readonly current: number }): React.JSX.Element {
  return (
    <div
      className="flex items-baseline justify-between gap-2 bg-muted/40 px-3 py-1.5 text-xs font-medium"
      data-testid="exit-row-current"
    >
      <span className="text-fg">◀ Current price</span>
      <span className="font-mono" title={formatAmount(current)}>
        {fmtPrice(current)}
      </span>
    </div>
  );
}

/** Interleave the current-price divider into the price-sorted ladder rows. */
function ExitLadder({
  view,
}: {
  readonly view: Extract<SignalView, { kind: 'holding' }>;
}): React.JSX.Element {
  const rows = ladderRows(view);
  const nearest = nearestExitKey(rows);
  const current = view.current;
  const items: React.JSX.Element[] = [];
  let currentPlaced = false;
  for (const row of rows) {
    if (current !== null && !currentPlaced && row.price < current) {
      items.push(<CurrentRow key="__current" current={current} />);
      currentPlaced = true;
    }
    items.push(<LadderRowView key={row.key} row={row} isNearest={row.key === nearest} />);
  }
  // Current sits below every level (e.g. price fell under the stop-loss line).
  if (current !== null && !currentPlaced)
    items.push(<CurrentRow key="__current" current={current} />);
  return <div className="divide-y divide-border rounded-md border">{items}</div>;
}

// --- Regime-exit row ------------------------------------------------------

/** Operator copy + tone for the regime-exit status, in the held-position context. */
function regimeHoldingText(s: RegimeExitStatus): { text: string; tone: 'loud' | 'warn' | 'muted' } {
  switch (s.kind) {
    case 'disabled':
      return { text: '', tone: 'muted' };
    case 'unavailable':
      return { text: `warming up — ${s.have}/${s.need} daily candles`, tone: 'muted' };
    case 'bear':
      return {
        text: `SELLS TO CASH — ${s.confirmBars}/${s.confirmBars} daily closes below the ${s.period}-day ${s.maType.toUpperCase()}. Position will be exited; new entries blocked until recovery.`,
        tone: 'loud',
      };
    case 'watching':
      if (s.below === 0)
        return {
          text: `healthy — price above the ${s.period}-day ${s.maType.toUpperCase()}`,
          tone: 'muted',
        };
      return {
        text: `${s.below}/${s.confirmBars} daily closes below the line — ${s.confirmBars - s.below} more confirms a sell-to-cash`,
        tone: 'warn',
      };
  }
}

/** Operator copy + tone for the regime status when flat (entry-suppression half). */
function regimeFlatText(s: RegimeExitStatus): { text: string; tone: 'loud' | 'warn' } | null {
  if (s.kind === 'bear')
    return {
      text: `Entries blocked — daily regime is bearish (${s.confirmBars}/${s.confirmBars} closes below the ${s.period}-day ${s.maType.toUpperCase()}). New buys resume when price recovers above the line.`,
      tone: 'loud',
    };
  if (s.kind === 'watching' && s.below > 0)
    return {
      text: `Regime watch — ${s.below}/${s.confirmBars} daily closes below the line; entries pause if it reaches ${s.confirmBars}.`,
      tone: 'warn',
    };
  return null;
}

const regimeToneClass: Record<'loud' | 'warn' | 'muted', string> = {
  loud: 'text-danger font-medium',
  warn: 'text-warning',
  muted: 'text-muted-fg',
};

const ROOM_WORD: Record<'tight' | 'normal' | 'loose', string> = {
  tight: 'a little',
  normal: 'more',
  loose: 'lots of',
};

/** Operator copy + tone for the bull-hold status, in the held-position context.
 *  `null` means render nothing (disabled, or armed-but-not-yet-a-bull). */
function bullHoldText(s: BullHoldStatus): { text: string; tone: 'good' | 'muted' } | null {
  switch (s.kind) {
    case 'disabled':
      return null;
    case 'unavailable':
      return {
        text: `bull hold on — warming up (${s.have}/${s.need} daily candles)`,
        tone: 'muted',
      };
    case 'inactive':
      return null;
    case 'holding':
      return {
        text: `HOLDING THROUGH THE BULL — giving this winner ${ROOM_WORD[s.room]} room while the daily ${s.period}-day ${s.maType.toUpperCase()} trend holds. The trailing stop above is loosened to ride routine dips, and snaps back to normal the moment the bull ends.`,
        tone: 'good',
      };
  }
}

const bullHoldToneClass: Record<'good' | 'muted', string> = {
  good: 'text-success font-medium',
  muted: 'text-muted-fg',
};

/**
 * Renders entry conditions for flat positions and exit conditions for held positions, including configured regime and Technicals signals.
 *
 * @param profileId - The profile identifier used to load market data
 * @param symbol - The symbol whose signal is displayed
 * @param strategy - The strategy configuration and state
 * @param holding - The average entry price for the position
 * @param currentPrice - The current market price
 * @param exitBlocker - The worker-recorded downside-exit status
 */
export function SymbolSignalPanel({
  profileId,
  symbol,
  strategy,
  holding,
  currentPrice,
  exitBlocker,
}: {
  readonly profileId: string;
  readonly symbol: string;
  readonly strategy: SymbolStateResponse['strategy'];
  readonly holding: SymbolStateResponse['avgEntryPrice'];
  readonly currentPrice: string | null;
  /** The projection's worker-written exit record; see {@link deriveSignal}. */
  readonly exitBlocker: SymbolStateResponse['exitBlocker'];
}): React.JSX.Element {
  // Skip the technicals query entirely when no sell-side toggle is configured —
  // the force-sell row will not render, so the data is dead weight. Cache key
  // is shared with `SymbolTechnicalsPanel` when it is mounted, so the typical
  // symbol-detail route still pays zero extra network for this subscribe.
  const forceSellConfigured = useMemo(() => hasForceSellTrigger(strategy), [strategy]);
  const technicals = useQuery({
    queryKey: technicalsRecommendationsQueryKey(profileId),
    queryFn: () => fetchTechnicalsRecommendations(profileId),
    staleTime: 15_000,
    enabled: forceSellConfigured,
  });
  const signalsForSymbol: TechnicalsResponse | undefined = useMemo(() => {
    if (!technicals.data) return undefined;
    const item = technicals.data.items.find((row) => row.symbol === symbol);
    return item ? { ...technicals.data, items: [item] } : { ...technicals.data, items: [] };
  }, [technicals.data, symbol]);

  // Daily candles, fetched once and shared by BOTH daily-regime readouts: the
  // cash-rotation exit (onBear) and the bull hold (onBull). Either being enabled
  // runs the query; frames are sized to the larger window so both verdicts warm
  // up. Bucketed to the day so the key is stable across re-renders.
  const regimeCfg = useMemo(() => regimeQueryConfig(strategy), [strategy]);
  const bullHoldCfg = useMemo(() => bullHoldQueryConfig(strategy), [strategy]);
  const dailyEnabled = regimeCfg !== null || bullHoldCfg !== null;
  const framePeriod = Math.max(regimeCfg?.period ?? 0, bullHoldCfg?.period ?? 0) || 200;
  const frameConfirm = Math.max(regimeCfg?.confirmBars ?? 0, bullHoldCfg?.confirmBars ?? 0) || 3;
  const dailyBucketMs = symbolCandleBucketMs('1d');
  const dailyCandles = useQuery({
    queryKey: symbolCandlesQueryKey(profileId, symbol, '1d', dailyBucketMs),
    queryFn: () =>
      fetchSymbolCandles(profileId, symbol, {
        interval: '1d',
        // The query only runs when a daily readout is enabled (below); the
        // fallback keeps the closure total for the disabled render.
        frames: REGIME_FRAMES(framePeriod, frameConfirm),
      }),
    staleTime: 60_000,
    enabled: dailyEnabled,
  });
  const config = asRecord(strategy.config);
  const regime = useMemo(
    () => deriveRegimeExit(config, dailyCandles.data),
    [config, dailyCandles.data],
  );
  const bullHold = useMemo(
    () => deriveBullHold(config, dailyCandles.data),
    [config, dailyCandles.data],
  );

  const view = deriveSignal(strategy, holding, currentPrice, exitBlocker, signalsForSymbol);

  return (
    <section className="space-y-2" data-testid="symbol-signal-panel">
      <h2 className="text-sm font-semibold text-fg">Signal</h2>
      {view.kind === 'unavailable' ? (
        <p className="text-xs text-muted-fg" data-testid="symbol-signal-unavailable">
          No signal — strategy state unavailable.
        </p>
      ) : view.kind === 'flat' ? (
        <FlatView view={view} regime={regime} />
      ) : (
        <HoldingView view={view} regime={regime} bullHold={bullHold} />
      )}
    </section>
  );
}

function FlatView({
  view,
  regime,
}: {
  readonly view: Extract<SignalView, { kind: 'flat' }>;
  readonly regime: RegimeExitStatus;
}): React.JSX.Element {
  const regimeNote = regimeFlatText(regime);
  return (
    <div className="space-y-1.5 text-xs" data-testid="symbol-signal-flat">
      {regimeNote ? (
        <p
          className={regimeToneClass[regimeNote.tone]}
          data-testid="symbol-signal-regime"
          data-regime={regime.kind}
        >
          {regimeNote.text}
        </p>
      ) : null}
      {!view.buyEnabled ? (
        <p className="text-muted-fg">Flat — no open position. Buy is disabled for this strategy.</p>
      ) : view.gates.length === 0 ? (
        <p className="text-muted-fg">
          Flat — no open position. Entry is a market buy on the next tick; no indicator or
          Technicals gate is configured.
        </p>
      ) : (
        <>
          <p className="text-muted-fg">
            Flat — no open position. Entry is a market buy once every condition holds:
          </p>
          <ul
            className="divide-y divide-border rounded-md border"
            data-testid="symbol-signal-gates"
          >
            {/* `entryGates` emits at most one entry per knob, so each gate
                string is unique within the list — safe as the React key. */}
            {view.gates.map((gate) => (
              <li key={gate} className="px-3 py-1.5">
                {gate}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Renders the signal panel for a held position, including exit levels, add conditions, and applicable
 * time-stop, regime, and bull-hold status.
 *
 * @param view - Derived holding-position signal data.
 * @param regime - Current regime-exit status.
 * @param bullHold - Current bull-hold status.
 * @returns The rendered holding-position signal view.
 */
function HoldingView({
  view,
  regime,
  bullHold,
}: {
  readonly view: Extract<SignalView, { kind: 'holding' }>;
  readonly regime: RegimeExitStatus;
  readonly bullHold: BullHoldStatus;
}): React.JSX.Element {
  const regimeNote = regime.kind === 'disabled' ? null : regimeHoldingText(regime);
  const bullHoldNote = bullHoldText(bullHold);
  return (
    <div className="space-y-2" data-testid="symbol-signal-table">
      <div className="flex items-baseline justify-between gap-2 px-1 text-xs text-muted-fg">
        <span>
          Avg entry{' '}
          <span className="font-mono" title={formatAmount(view.avgEntryPrice)}>
            {fmtPrice(view.avgEntryPrice)}
          </span>
        </span>
        <span>
          Buy level #{view.rungIndex + 1}
          {view.rungTotal > 0 ? ` of ${view.rungTotal}` : ''}
        </span>
      </div>

      <ExitLadder view={view} />

      {view.noDownsideExit === true ? (
        <p className="px-1 text-xs text-warning" data-testid="symbol-signal-no-downside-exit">
          No exit below your entry. Nothing on this ladder sells at a loss, so a fall is held until
          you act — switch on a stop-loss, a break-even stop or a time-stop if that is not what you
          want.
        </p>
      ) : null}

      {view.discoveryEntry ? (
        <p className="px-1 text-xs text-muted-fg" data-testid="symbol-signal-discovery-note">
          Single-entry discovery position — no grid re-buys (a discovery pick never averages down).
        </p>
      ) : view.nextBuy === null ? (
        <p className="px-1 text-xs text-muted-fg">Highest buy level reached — no further adds.</p>
      ) : null}

      {view.discoveryTimeStop ? (
        <div className="rounded-md border px-3 py-2" data-testid="symbol-signal-time-stop">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span
              className="text-muted-fg"
              title="A discovery single-entry that has neither taken profit nor hit its stop is market-sold to cash after this many closed candles, freeing the capital."
            >
              Discovery time-stop
            </span>
            <span className="font-mono">
              {view.discoveryTimeStop.bars} closed {view.discoveryTimeStop.interval} candle
              {view.discoveryTimeStop.bars === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-fg">
            Sells to cash after that many closed candles from entry if it has not already taken
            profit or hit its stop.
          </p>
        </div>
      ) : null}

      {view.timeStop ? (
        <div className="rounded-md border px-3 py-2" data-testid="symbol-signal-general-time-stop">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span
              className="text-muted-fg"
              title="A position that never reached your sell trigger (went nowhere) is market-sold to cash after this many closed candles, freeing the capital. A position that did reach the trigger is left to the trailing stop."
            >
              Time-stop
            </span>
            <span className="font-mono">
              {view.timeStop.bars} closed {view.timeStop.interval} candle
              {view.timeStop.bars === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-fg">
            Sells to cash after that many closed candles from entry if it never reached your sell
            trigger.
          </p>
        </div>
      ) : null}

      {view.forceSell ? (
        <div
          className="divide-y divide-border rounded-md border"
          data-testid="symbol-signal-force-sell"
        >
          <div className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs">
            <span
              className="text-muted-fg"
              title="Below this price, in profit, and any matching Technicals signal → market sell."
            >
              Technicals force-sell
            </span>
            <span className="font-mono whitespace-nowrap">
              <span title={formatAmount(view.forceSell.trigger.price)}>
                {fmtPrice(view.forceSell.trigger.price)}
              </span>
              <span className="ml-2 text-muted-fg">{fmtGap(view.forceSell.trigger.gapPct)}</span>
            </span>
          </div>
          <p
            className={
              view.forceSell.status.kind === 'would-fire'
                ? 'px-3 py-1.5 text-xs font-medium text-down'
                : 'px-3 py-1.5 text-xs text-muted-fg'
            }
            data-testid="symbol-signal-force-sell-status"
            data-status={view.forceSell.status.kind}
          >
            {forceSellStatusText(view.forceSell.status)}
          </p>
        </div>
      ) : null}

      {view.pyramid ? (
        <div
          className="divide-y divide-border rounded-md border"
          data-testid="symbol-signal-pyramid"
          data-add-count={view.pyramid.addCount}
        >
          <div className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs">
            <span
              className="text-muted-fg"
              title="On a confirmed daily bull, adds to the position on strength above cost, up to the add cap."
            >
              Bull pyramid
            </span>
            <span className="font-mono">
              {view.pyramid.addCount} of {view.pyramid.maxAdds} adds
            </span>
          </div>
          <p className="px-3 py-1.5 text-xs text-muted-fg">
            {view.pyramid.nextAdd ? (
              <>
                Next add at{' '}
                <span className="font-mono" title={formatAmount(view.pyramid.nextAdd.price)}>
                  {fmtPrice(view.pyramid.nextAdd.price)}
                </span>
                <span className="ml-2">{fmtGap(view.pyramid.nextAdd.gapPct)}</span>
              </>
            ) : (
              'Add cap reached — no further adds.'
            )}
          </p>
        </div>
      ) : null}

      {regimeNote ? (
        <div
          className="rounded-md border px-3 py-2"
          data-testid="symbol-signal-regime"
          data-regime={regime.kind}
        >
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span
              className="text-muted-fg"
              title="Exits the whole position to cash on a confirmed daily downtrend."
            >
              Regime exit
            </span>
          </div>
          <p className={`mt-1 text-xs ${regimeToneClass[regimeNote.tone]}`}>{regimeNote.text}</p>
        </div>
      ) : null}

      {bullHoldNote ? (
        <div
          className="rounded-md border px-3 py-2"
          data-testid="symbol-signal-bull-hold"
          data-bull-hold={bullHold.kind}
        >
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span
              className="text-muted-fg"
              title="On a confirmed daily uptrend, gives a winning trade more room so routine dips do not sell you out."
            >
              Bull hold
            </span>
          </div>
          <p className={`mt-1 text-xs ${bullHoldToneClass[bullHoldNote.tone]}`}>
            {bullHoldNote.text}
          </p>
        </div>
      ) : null}
    </div>
  );
}
