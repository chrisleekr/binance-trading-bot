import { Decimal } from '@app/money';
import { log, metric } from '@app/strategy-core';
import type { Decision, LogEntry, MetricEntry, TickInput, TickOutput } from '@app/strategy-core';

import type { RebalanceBundle, RebalanceConfig, RebalanceState } from './schema.js';
import { computeRebalance } from './rebalance.js';
import { momentumScore, momentumTargetWeight, type MomentumEntry } from './momentum.js';
import { rebalanceClientOrderId } from './client-order-id.js';

/** KV namespace this strategy publishes each symbol's mark-to-market value under. */
export const KV_VALUE_PREFIX = 'rebalance:value:';
/** KV namespace each symbol publishes its momentum score under (momentum mode only). */
export const KV_MOMENTUM_PREFIX = 'rebalance:momentum:';

type RebalanceInput = TickInput<RebalanceConfig, RebalanceState, RebalanceBundle>;
type RebalanceOutput = TickOutput<RebalanceState>;

/** Tolerant decimal parse — the live worker passes RAW (unparsed) config. */
const dec = (v: unknown, fallback: string): Decimal => {
  try {
    return new Decimal(typeof v === 'string' ? v : fallback);
  } catch {
    return new Decimal(fallback);
  }
};

/** This symbol's target weight from the config basket, or 0 when absent. */
const targetWeightFor = (config: RebalanceConfig, symbol: string): Decimal => {
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const hit = targets.find((t) => t?.symbol === symbol);
  return hit ? dec(hit.weight, '0') : new Decimal(0);
};

/** Sibling symbols' published values from the KV snapshot (excludes self). */
const siblingValues = (
  profileKv: Readonly<Record<string, unknown>> | undefined,
  symbol: string,
): Decimal[] => {
  const out: Decimal[] = [];
  for (const [key, value] of Object.entries(profileKv ?? {})) {
    if (key.startsWith(KV_VALUE_PREFIX) && key.slice(KV_VALUE_PREFIX.length) !== symbol) {
      out.push(dec(value, '0'));
    }
  }
  return out;
};

/** Sibling symbols' published momentum scores from the KV snapshot (excludes self
 *  and any symbol with no valid score). */
const siblingMomentum = (
  profileKv: Readonly<Record<string, unknown>> | undefined,
  symbol: string,
): MomentumEntry[] => {
  const out: MomentumEntry[] = [];
  for (const [key, value] of Object.entries(profileKv ?? {})) {
    if (!key.startsWith(KV_MOMENTUM_PREFIX)) continue;
    const sib = key.slice(KV_MOMENTUM_PREFIX.length);
    if (sib === symbol) continue;
    let score: Decimal;
    try {
      score = new Decimal(typeof value === 'string' ? value : String(value));
    } catch {
      continue;
    }
    if (score.isFinite()) out.push({ symbol: sib, score });
  }
  return out;
};

/** Tolerant positive-int read from RAW config (the live worker passes unparsed config). */
const intField = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const momentumOf = (config: RebalanceConfig): { lookbackCandles?: unknown; topK?: unknown } => {
  const m = (config as { momentum?: unknown }).momentum;
  return typeof m === 'object' && m !== null
    ? (m as { lookbackCandles?: unknown; topK?: unknown })
    : {};
};

/**
 * One rebalance tick. Always publishes this symbol's mark-to-market value to the
 * cross-symbol KV store; emits a market BUY/SELL only when its share of the
 * basket has drifted past the threshold and the trade clears the dust floor.
 * Pure: all money math is Decimal, no I/O.
 */
export const computeTick = (input: RebalanceInput): RebalanceOutput => {
  const { market, config, state, account, profile } = input;
  const symbol = market.symbol;
  const price = new Decimal(market.currentPrice);
  const heldQty = state.heldQuantity ? dec(state.heldQuantity, '0') : new Decimal(0);
  const quoteAsset = market.symbolInfo.quoteAsset;
  const bal = account.balances[quoteAsset];

  const isMomentum = config.weightMode === 'momentum';
  const decisions: Decision[] = [];
  let targetWeight: Decimal;
  // Only a SCORED symbol that ranks below the top-K rotates to cash; a symbol that
  // could not be scored (data gap) holds, and a cold KV holds — neither liquidates.
  let exitWhenZeroWeight = false;

  if (isMomentum) {
    // Cross-sectional momentum: rank the universe by trailing return and hold the
    // top-K at equal weight. Publish this symbol's score so siblings rank the same
    // set; drop it from the KV when it has too little history to score.
    const window = market.candlesByInterval[config.candleInterval] ?? [];
    const m = momentumOf(config);
    const selfScore = momentumScore(window, intField(m.lookbackCandles, 30));
    if (selfScore === null) {
      // Unscorable (short history or a candle-feed gap): drop it from the KV so
      // siblings don't rank a stale value, and HOLD — a data gap must never sell a
      // held position.
      decisions.push({ type: 'delete-kv', key: `${KV_MOMENTUM_PREFIX}${symbol}` });
      targetWeight = new Decimal(0);
    } else {
      decisions.push({
        type: 'set-kv',
        key: `${KV_MOMENTUM_PREFIX}${symbol}`,
        value: selfScore.toString(),
      });
      const siblings = siblingMomentum(input.profileKv, symbol);
      const scoredCount = siblings.length + 1;
      // The universe is the configured targets. Wait until at least min(topK,
      // universe) of them have published before deploying, so the first symbol to
      // tick on a cold KV doesn't take the whole budget then unwind it next cycle.
      const universeSize = Array.isArray(config.targets) ? config.targets.length : 0;
      const topK = intField(m.topK, 3);
      const needed = topK < universeSize ? topK : universeSize;
      if (scoredCount < needed) {
        targetWeight = new Decimal(0); // KV not converged — hold, don't deploy or rotate
      } else {
        targetWeight = momentumTargetWeight({ symbol, score: selfScore }, siblings, topK);
        exitWhenZeroWeight = true; // converged: a ranked-out symbol rotates to cash
      }
    }
  } else {
    targetWeight = targetWeightFor(config, symbol);
  }

  const plan = computeRebalance({
    currentPrice: price,
    heldQty,
    targetWeight,
    siblingValuesQuote: siblingValues(input.profileKv, symbol),
    driftThreshold: dec(config.driftThreshold, '0.05'),
    minTradeQuote: dec(config.minTradeQuote, '10'),
    basketBudgetQuote: dec(config.basketBudgetQuote, '0'),
    availableQuote: bal ? bal.free : new Decimal(0),
    stepSize: dec(market.symbolInfo.filters.stepSize, '0'),
    enabled: config.enabled === true,
    exitWhenZeroWeight,
  });

  // Publish this symbol's value so siblings' next ticks can weight the basket.
  decisions.push({ type: 'set-kv', key: `${KV_VALUE_PREFIX}${symbol}`, value: plan.ownValueQuote });
  const logs: LogEntry[] = [];
  const metrics: MetricEntry[] = [metric('rebalance.decision', { symbol, reason: plan.reason })];

  if (plan.trade) {
    const window = market.candlesByInterval[config.candleInterval] ?? [];
    const lastCandle = window[window.length - 1];
    const candleCloseMs = lastCandle ? lastCandle.closeTimeMs : 0;
    decisions.push({
      type: 'place-order',
      intent: {
        symbol,
        side: plan.trade.side,
        reason: 'rebalance',
        clientOrderId: rebalanceClientOrderId(profile.id, symbol, candleCloseMs, plan.trade.side),
      },
      params: { type: 'MARKET', quantity: plan.trade.quantity },
    });
    logs.push(
      log('info', 'rebalance: trading toward target', {
        symbol,
        side: plan.trade.side,
        quantity: plan.trade.quantity,
      }),
    );
  }

  return { nextState: state, decisions, logs, metrics };
};
