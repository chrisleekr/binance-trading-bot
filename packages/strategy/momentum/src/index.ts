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
import { breakoutLookback } from './breakout.js';
import { impulseNeed } from './impulse.js';
import { momentumPositionAdapter } from './position-adapter.js';
import { momentumReasonAttribution } from './attribution.js';
import { momentumPreviewLevels, momentumPreviewDataNeeds } from './preview.js';
import { momentumAttributeOrder } from './client-order-id.js';
import { momentumStopBandSettings } from './protective-stop.js';
import { lintMomentumConfig } from './lint.js';
import { relativeStrengthNeed, relativeStrengthSettings } from './relative-strength.js';

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
 * Momentum: the first non-trailing-trade strategy plugin. Enters long on a fast/slow EMA cross-up, or while the fast EMA is above the slow under `entryTrigger: 'trend'` (one entry per candle), and exits on a trailing-stop retrace or EMA cross-down. Exercises the {@link PositionStateAdapter} capability and deliberately omits `gridTrade` and all bundle providers — proof the plugin contract holds for a strategy with a different shape from trailing-trade.
 */
/** Coerce an unparsed-config leaf to a finite number, else 0. */
const finiteNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Candle lookback this config needs on the strategy interval: the EMA cross reads `slow + 1` closes (the breakout trigger reads `breakoutLookback + 1`, and the impulse trigger its volume lookback plus the judged candle, when that is longer), an enabled trend filter reads `period` closes (plus the slope lookback when it requires a rising line), an enabled extension guard reads its own `period` closes, an enabled ATR trailing stop reads `period + 1` closes for its first true-range value, and an enabled relative-strength gate reads `lookbackBars + 1` closes for its score. Mirrors the exact arithmetic each gate in {@link computeTick} uses (including the shared {@link extensionPeriod}, {@link trendPeriod} and {@link atrStopPeriod} coercions) so the window is never short of what a decision reads. Defensive: the live worker passes the config unparsed.
 *
 * The ATR term is a HARD need, not the trail's soft one. Risk-based entry sizing divides equity risk by the initial stop distance, and that distance is unresolvable on a short ATR window, so the entry is refused outright (`risk-sizing-unavailable`) rather than degraded. The exit trail's own shortfall behaviour is a fallback to the fixed `trailingStopPct`, which is why the term could be omitted here before entry sizing read it.
 */
export const momentumRequiredWindow = (config: MomentumConfig): number => {
  const c = config as {
    ema?: { slow?: unknown };
    trendFilter?: {
      enabled?: unknown;
      period?: unknown;
      side?: unknown;
      requireRising?: unknown;
      slopeLookbackBars?: unknown;
    };
    entryExtension?: { enabled?: unknown; period?: unknown };
    atrTrailingStop?: { enabled?: unknown; period?: unknown };
    entryTrigger?: unknown;
    breakoutLookback?: unknown;
    belowTrendBreakout?: { enabled?: unknown; lookback?: unknown };
    impulse?: unknown;
    relativeStrength?: unknown;
  };
  // The breakout level reads `lookback` candles before the one being judged; folded into the EMA term since both are entry-signal needs.
  const bt = c.belowTrendBreakout;
  const mainRange = breakoutLookback(c.breakoutLookback);
  const layerRange = bt?.enabled === true ? breakoutLookback(bt.lookback) : 0;
  const rangeNeed = layerRange > mainRange ? layerRange : mainRange;
  const breakoutNeed =
    c.entryTrigger === 'breakout'
      ? rangeNeed + 1
      : c.entryTrigger === 'impulse'
        ? impulseNeed(c.impulse)
        : 0;
  const crossNeed = finiteNum(c.ema?.slow) + 1;
  const emaNeed = crossNeed > breakoutNeed ? crossNeed : breakoutNeed;
  const tf = c.trendFilter;
  let trendNeed = 0;
  if (tf?.enabled === true) {
    const rawK = Number(tf.slopeLookbackBars ?? 10);
    // Mirrors trendGate: the below side never runs the slope veto, so it needs no slope history.
    const rising = tf.requireRising === true && tf.side !== 'below';
    const k = rising ? (Number.isFinite(rawK) && rawK >= 1 ? rawK : 1) : 0;
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
  const withAtr = widest > atrNeed ? widest : atrNeed;
  const rsNeed = relativeStrengthNeed(c.relativeStrength);
  return withAtr > rsNeed ? withAtr : rsNeed;
};

export const momentum: Strategy<MomentumConfig, MomentumState, MomentumBundle> = {
  name: 'momentum',
  version: '1.0.0',
  displayName: 'Momentum',
  description:
    'Trend entry (on the EMA cross-up, while the fast EMA is above the slow, on a close above the recent range high, or after a heavy-volume up candle) with a trailing-stop / cross-down exit. Single long position, no grid.',
  capabilities: {
    candleIntervals: MOMENTUM_CANDLE_INTERVALS,
    // The entry signal (the EMA cross, the fast-above-slow state under `entryTrigger: 'trend'`, or the range breakout under `'breakout'`) reads CLOSED candles of `config.candleInterval`, and one entry per candle is enforced, so a flat symbol gets at most one entry per close of that interval.
    entryOnCandleClose: true,
    // The profit leg ratchets on 1-minute closes and the stop fires on the live price, so a held position can exit at any minute of a daily candle.
    exitsWithinCandle: true,
    needsUserDataStream: true,
    needsMiniTicker: true,
    // Reads the operator-override slot so a force-sell can reach the tick.
    bundleProviders: ['override'],
    // `trigger-sell` flattens a held position through the normal exit path, so the protective stop is cancelled and state flattened. `avg-entry-price` lets the operator hand the strategy coins already in the wallet: momentum holds one position per symbol and its position adapter adopts a seeded basis like any fill, so without it a holding bought elsewhere sits unmanaged with no stop. Momentum runs no grid and its tick consumes no manual-order or trigger-buy override, so those stay undeclared.
    operatorActions: ['trigger-sell', 'avg-entry-price'],
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
  lintConfig: lintMomentumConfig,
  // Only the relative-strength gate reads sibling symbols, so a profile without it pays no per-tick store read.
  needsProfileKvFor: (config) =>
    relativeStrengthSettings((config as { relativeStrength?: unknown }).relativeStrength).enabled,
  tick: computeTick,
};
