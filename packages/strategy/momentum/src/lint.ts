// Pure config lint for momentum. Flags settings the tick path silently ignores given the rest of the config; each rule mirrors a real branch in `tick.ts` or `trailing-stop.ts`. Advisory only: the schema stays the hard-rejection gate, and it cannot carry these cross-block rules because the contract requires an object-rooted config schema.

import type { ConfigDiagnostic } from '@app/strategy-core';
import type { MomentumConfig } from './schema.js';

/**
 * Lint a schema-valid momentum config for inert settings.
 *
 * @param config - A config that already passed `MomentumConfigSchema`.
 * @returns Advisory diagnostics; empty when nothing is inert.
 */
export const lintMomentumConfig = (config: MomentumConfig): readonly ConfigDiagnostic[] => {
  const out: ConfigDiagnostic[] = [];
  const tf = config.trendFilter;

  // trendGate skips the slope veto on the below side.
  if (tf?.enabled === true && tf.side === 'below' && tf.requireRising) {
    out.push({
      level: 'info',
      code: 'require-rising-inert-below',
      message:
        'The rising-slope check only applies when the trend filter buys above the line. The side is "below", so it is ignored.',
      path: ['trendFilter', 'requireRising'],
    });
  }

  if (config.belowTrendBreakout?.enabled === true) {
    // The layer reads its range only under the breakout trigger, and fires only when the trend gate answers below-trend, which needs the filter on its above side.
    if (config.entryTrigger !== 'breakout' || tf?.enabled !== true || tf.side === 'below') {
      out.push({
        level: 'warn',
        code: 'below-trend-breakout-inert',
        message:
          'The below-trend breakout never buys with these settings. It needs the breakout trigger and the trend filter turned on with its side set to "above".',
        path: ['belowTrendBreakout', 'enabled'],
      });
    } else if (config.atrTrailingStop?.enabled !== true) {
      // configForEntryLayer swaps only the ATR multiple, so with the ATR stop off the layer's positions trail at trailingStopPct.
      out.push({
        level: 'warn',
        code: 'below-trend-atr-multiple-inert',
        message:
          "Positions the below-trend breakout opens trail at the main trailing-stop percent, because the ATR trailing stop is off. Turn the ATR trailing stop on to use this layer's ATR multiple.",
        path: ['belowTrendBreakout', 'atrMultiple'],
      });
    }
  }

  return out;
};
