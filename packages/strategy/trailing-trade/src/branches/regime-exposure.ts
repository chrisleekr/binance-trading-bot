import type { MarketSnapshot } from '@app/strategy-core';
import { Decimal } from '@app/money';
import type { TTConfig, TTRegime } from '../schema.js';
import { classifyRegime } from './regime.js';

const ONE = new Decimal(1);
const ZERO = new Decimal(0);

export interface RegimeExposure {
  /** Multiplier applied to the no-grid first-entry size, in [0, 1]. */
  readonly scalar: Decimal;
  /** The classified regime, or `disabled` when the feature is off. */
  readonly regime: 'disabled' | 'bull' | 'bear' | 'neutral' | 'unavailable';
}

/**
 * First-entry exposure scalar from the daily regime — OPT-IN.
 *
 * Disabled (the default) returns `1` WITHOUT reading any candle, so the entry
 * budget is left untouched and replay stays byte-identical. Enabled:
 *   - `bull`        → 1   (full size — deploy into a confirmed uptrend)
 *   - `neutral`     → `neutralScalar` (a reduced fraction while the trend is mixed)
 *   - `bear`        → 0   (no entry — sit in cash; the one lever a spot-long bot has)
 *   - `unavailable` → 1   (fail-open: an uncomputable regime never blocks, matching
 *                          the regime exit's fail-safe stance)
 *
 * Pure and stateless: reads only the daily window the tick already carries.
 */
export const regimeExposure = (config: TTConfig, market: MarketSnapshot): RegimeExposure => {
  // Cast to optional: the live worker passes the raw stored config (no schema
  // defaults), so a config saved before this field existed has no `regime` or
  // `exposure`. Disabled / absent → 1, untouched budget, byte-identical replay.
  const regimeCfg = config.regime as TTRegime | undefined;
  if (regimeCfg?.exposure?.enabled !== true) return { scalar: ONE, regime: 'disabled' };
  const { regime } = classifyRegime(market, {
    ma: regimeCfg.ma,
    period: regimeCfg.period,
    confirmBars: regimeCfg.confirmBars,
  });
  switch (regime) {
    case 'bear':
      return { scalar: ZERO, regime };
    case 'neutral':
      return { scalar: new Decimal(regimeCfg.exposure.neutralScalar), regime };
    case 'bull':
    case 'unavailable':
      return { scalar: ONE, regime };
  }
};
