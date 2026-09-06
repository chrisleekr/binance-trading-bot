import type { Strategy } from '@app/strategy-core';

import {
  defaultMomentumConfig,
  initialMomentumState,
  MomentumBundleSchema,
  MomentumConfigSchema,
  MomentumOverrideConfigSchema,
  MomentumStateSchema,
  MOMENTUM_CANDLE_INTERVALS,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumState,
} from './schema.js';
import { computeTick } from './tick.js';
import { extensionPeriod } from './extension.js';
import { atrStopPeriod } from './trailing-stop.js';
import { trendPeriod } from './trend-filter.js';
import { momentumPositionAdapter } from './position-adapter.js';
import { momentumReasonAttribution } from './attribution.js';
import { momentumPreviewLevels, momentumPreviewDataNeeds } from './preview.js';
import { momentumAttributeOrder } from './client-order-id.js';
import { momentumStopBandSettings } from './protective-stop.js';

export { momentumReasonAttribution } from './attribution.js';
export { momentumPositionAdapter } from './position-adapter.js';
export { momentumPreviewLevels, momentumPreviewDataNeeds } from './preview.js';
export {
  MomentumBundleSchema,
  MomentumConfigSchema,
  MomentumOverrideConfigSchema,
  MomentumStateSchema,
  MOMENTUM_CANDLE_INTERVALS,
  MOMENTUM_EXIT_BLOCKER_REASONS,
  MOMENTUM_STATE_SCHEMA_VERSION,
  defaultMomentumConfig,
  initialMomentumState,
  type MomentumBundle,
  type MomentumConfig,
  type MomentumOverrideConfig,
  type MomentumState,
} from './schema.js';
export { computeTick } from './tick.js';

/**
 * Momentum: the first non-trailing-trade strategy plugin. Enters long on a
 * fast/slow EMA cross-up and exits on a trailing-stop retrace or EMA
 * cross-down. Exercises the {@link PositionStateAdapter} capability and
 * deliberately omits `gridTrade` and all bundle providers — proof the plugin
 * contract holds for a strategy with a different shape from trailing-trade.
 */
/** Coerce an unparsed-config leaf to a finite number, else 0. */
const finiteNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Candle lookback this config needs on the strategy interval: the EMA cross reads `slow + 1` closes, an enabled trend filter reads `period` closes (plus the slope lookback when it requires a rising line), an enabled extension guard reads its own `period` closes, and an enabled ATR trailing stop reads `period + 1` closes for its first true-range value. Mirrors the exact arithmetic each gate in {@link computeTick} uses (including the shared {@link extensionPeriod}, {@link trendPeriod} and {@link atrStopPeriod} coercions) so the window is never short of what a decision reads. Defensive: the live worker passes the config unparsed.
 *
 * The ATR term is a HARD need, not the trail's soft one. Risk-based entry sizing divides equity risk by the initial stop distance, and that distance is unresolvable on a short ATR window, so the entry is refused outright (`risk-sizing-unavailable`) rather than degraded. The exit trail's own shortfall behaviour is a fallback to the fixed `trailingStopPct`, which is why the term could be omitted here before entry sizing read it.
 */
export const momentumRequiredWindow = (config: MomentumConfig): number => {
  const c = config as {
    ema?: { slow?: unknown };
    trendFilter?: {
      enabled?: unknown;
      period?: unknown;
      requireRising?: unknown;
      slopeLookbackBars?: unknown;
    };
    entryExtension?: { enabled?: unknown; period?: unknown };
    atrTrailingStop?: { enabled?: unknown; period?: unknown };
  };
  const emaNeed = finiteNum(c.ema?.slow) + 1;
  const tf = c.trendFilter;
  let trendNeed = 0;
  if (tf?.enabled === true) {
    const rawK = Number(tf.slopeLookbackBars ?? 10);
    const k = tf.requireRising === true ? (Number.isFinite(rawK) && rawK >= 1 ? rawK : 1) : 0;
    // Coerce with the same helper the gate uses, so a partial override that
    // omits `period` sizes the window to the 200 default rather than 0.
    trendNeed = trendPeriod(tf.period) + k;
  }
  const ce = c.entryExtension;
  const extNeed = ce?.enabled === true ? extensionPeriod(ce.period) : 0;
  const at = c.atrTrailingStop;
  // ATR needs period + 1 candles for the first true-range value, matching the guard in
  // `initialStopDistanceFraction` — which resolves the period through this same coercion, so a
  // malformed leaf lands on one number here and at the gate rather than two. Gated on `enabled`
  // for the reason that guard is: a disabled block reads no candles, so declaring a need for them
  // would stop this function describing what a decision actually reads. The term changes no
  // schema-valid window on its own — the period caps at 100, so the need caps at 101 and the 200
  // floor already covers it — which is why it is a correctness statement, not a load lever.
  const atrNeed = at?.enabled === true ? atrStopPeriod(at.period) + 1 : 0;
  const need = emaNeed > trendNeed ? emaNeed : trendNeed;
  const widest = need > extNeed ? need : extNeed;
  return widest > atrNeed ? widest : atrNeed;
};

export const momentum: Strategy<MomentumConfig, MomentumState, MomentumBundle> = {
  name: 'momentum',
  version: '1.0.0',
  displayName: 'Momentum',
  description:
    'EMA cross-up entry with a trailing-stop / cross-down exit. Single long position, no grid.',
  capabilities: {
    candleIntervals: MOMENTUM_CANDLE_INTERVALS,
    needsUserDataStream: true,
    needsMiniTicker: true,
    // Reads the operator-override slot so a force-sell can reach the tick.
    bundleProviders: ['override'],
    // Force-sell only: an operator can flatten a held position (`trigger-sell`),
    // routed through the normal exit path so the protective stop is cancelled
    // and state flattened. Momentum runs no grid and takes no manual BUY, so it
    // declares none of the grid / avg-entry / trigger-buy actions.
    operatorActions: ['trigger-sell'],
  },
  configSchema: MomentumConfigSchema,
  overrideConfigSchema: MomentumOverrideConfigSchema,
  stateSchema: MomentumStateSchema,
  bundleSchema: MomentumBundleSchema,
  events: {},
  defaultConfig: defaultMomentumConfig(),
  position: momentumPositionAdapter,
  // Authoritative orphan attribution: only the protective stop is re-derivable
  // from (profile, symbol). It GATES adoption, so an orphan momentum never placed
  // can never be handed to it.
  attributeOrder: momentumAttributeOrder,
  initialState: initialMomentumState,
  requiredWindow: momentumRequiredWindow,
  reasonAttribution: momentumReasonAttribution,
  previewDataNeeds: momentumPreviewDataNeeds,
  previewLevels: momentumPreviewLevels,
  // Lets a caller holding the symbol's filters warn at BIND time that the
  // configured trail is deeper than the symbol's price band will hold, instead
  // of the operator learning it from the first tick that could not arm a stop.
  protectiveStopBandSettings: momentumStopBandSettings,
  tick: computeTick,
};
