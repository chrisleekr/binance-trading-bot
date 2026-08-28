import type { Strategy } from '@app/strategy-core';

import {
  defaultRebalanceConfig,
  initialRebalanceState,
  RebalanceBundleSchema,
  RebalanceConfigSchema,
  RebalanceOverrideConfigSchema,
  RebalanceStateSchema,
  REBALANCE_CANDLE_INTERVALS,
  type RebalanceBundle,
  type RebalanceConfig,
  type RebalanceState,
} from './schema.js';
import { computeTick } from './tick.js';
import { rebalancePositionAdapter } from './position-adapter.js';
import { rebalancePreviewLevels, rebalancePreviewDataNeeds } from './preview.js';

export { rebalancePositionAdapter } from './position-adapter.js';
export { rebalancePreviewLevels, rebalancePreviewDataNeeds } from './preview.js';
export {
  RebalanceBundleSchema,
  RebalanceConfigSchema,
  RebalanceOverrideConfigSchema,
  RebalanceStateSchema,
  REBALANCE_CANDLE_INTERVALS,
  REBALANCE_STATE_SCHEMA_VERSION,
  defaultRebalanceConfig,
  initialRebalanceState,
  type RebalanceBundle,
  type RebalanceConfig,
  type RebalanceOverrideConfig,
  type RebalanceState,
  type RebalanceTarget,
} from './schema.js';
export { computeTick, KV_VALUE_PREFIX, KV_MOMENTUM_PREFIX } from './tick.js';
export { computeRebalance, type RebalancePlan, type RebalanceInput } from './rebalance.js';
export { momentumScore, momentumTargetWeight, type MomentumEntry } from './momentum.js';

/**
 * Rebalance: a cross-symbol basket strategy with two weight modes over one order
 * engine. `fixed` holds a fixed-weight basket and harvests the rebalancing premium
 * (sell what rose, buy what fell). `momentum` ignores the configured weights and
 * equal-weights the top-K symbols by trailing return, rotating as the
 * cross-sectional ranking shifts — the strong form of momentum the single-symbol
 * EMA cross lacks. The first CROSS-SYMBOL strategy: each tick publishes to the
 * per-profile KV store and reads the siblings back, so it needs
 * `needsProfileKv`. Disabled by default — the operator backtests it before turning
 * it on.
 */
/**
 * Candle lookback this config needs on the strategy interval. Only `momentum`
 * weight mode reads history: {@link momentumScore} needs a window STRICTLY
 * longer than `lookbackCandles` (it compares the last close to the one N candles
 * ago), so require `lookback + 1`. `fixed` mode reads no window, so it needs
 * none. Without this the window floors at 200 (see `resolveCandleWindow`) and a
 * configured `lookbackCandles > 199` silently scores `null` for every symbol —
 * the basket never deploys, identically in live and backtest. Defensive: the
 * live worker passes the config unparsed.
 */
export const rebalanceRequiredWindow = (config: RebalanceConfig): number => {
  const c = config as { weightMode?: unknown; momentum?: { lookbackCandles?: unknown } };
  if (c.weightMode !== 'momentum') return 0;
  const lb = Number(c.momentum?.lookbackCandles);
  return Number.isFinite(lb) && lb > 0 ? lb + 1 : 0;
};

/**
 * No `attributeOrder`, deliberately.
 *
 * Rebalance places exactly one kind of order, `MARKET`, which never rests on the
 * book: it fills or it is rejected, in both cases immediately. It therefore
 * cannot leave an open order behind for the orphan detector to find, so there is
 * nothing for an attributor to claim. (Its clientOrderId folds the triggering
 * candle's close time anyway, which is unbounded runtime data and not
 * re-derivable from the order alone — so even a resting one would have to return
 * null.)
 *
 * If rebalance ever grows a resting order type, it MUST gain an `attributeOrder`
 * in the same change, or those orders become permanently un-adoptable: adoption
 * is derived from the id, never chosen by the operator, and a strategy that
 * cannot prove it placed an order gets no claim on it.
 */
export const rebalance: Strategy<RebalanceConfig, RebalanceState, RebalanceBundle> = {
  name: 'rebalance',
  version: '1.0.0',
  displayName: 'Rebalance',
  description:
    'Hold a basket at target weights and trade back when one drifts — fixed weights, or equal-weight the top-K by momentum. Cross-symbol; off by default.',
  capabilities: {
    candleIntervals: REBALANCE_CANDLE_INTERVALS,
    needsUserDataStream: true,
    needsMiniTicker: true,
    needsProfileKv: true,
    bundleProviders: [],
    operatorActions: [],
  },
  configSchema: RebalanceConfigSchema,
  overrideConfigSchema: RebalanceOverrideConfigSchema,
  stateSchema: RebalanceStateSchema,
  bundleSchema: RebalanceBundleSchema,
  events: {},
  defaultConfig: defaultRebalanceConfig(),
  position: rebalancePositionAdapter,
  initialState: initialRebalanceState,
  requiredWindow: rebalanceRequiredWindow,
  previewDataNeeds: rebalancePreviewDataNeeds,
  previewLevels: rebalancePreviewLevels,
  tick: computeTick,
};
