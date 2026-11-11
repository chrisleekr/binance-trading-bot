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

  // Exhaustion buys under the trend line, which trendGate refuses as below-trend on the above side, so such a profile saves cleanly and almost never buys.
  if (config.entryTrigger === 'exhaustion' && tf?.enabled === true && tf.side !== 'below') {
    out.push({
      level: 'warn',
      code: 'exhaustion-trend-filter-above',
      message:
        'The exhaustion trigger buys sell-offs under the trend line, and the trend filter on its "above" side refuses nearly all of them. Turn the trend filter off, or set its side to "below".',
      path: ['trendFilter', 'enabled'],
    });
  }

  if (config.belowTrendBreakout?.enabled === true) {
    // Under breakout the layer fires only when the trend gate answers below-trend, which needs the filter on its above side. Under the MA cluster trigger it reads the line itself; no other trigger reads it.
    const inert =
      config.entryTrigger !== 'maCluster' &&
      (config.entryTrigger !== 'breakout' || tf?.enabled !== true || tf.side === 'below');
    if (inert) {
      out.push({
        level: 'warn',
        code: 'below-trend-breakout-inert',
        message:
          'The below-trend breakout never buys with these settings. It needs the MA cluster trigger, or the breakout trigger with the trend filter turned on and its side set to "above".',
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

  // A native trailing order carries a distance, not a price, so the floor cannot rest on Binance; only the bot's own per-tick check enforces it. That covers the band-refusal fallback too, not just the native-trail mode.
  if (
    config.breakEvenLock?.enabled === true &&
    config.protectiveStop?.enabled === true &&
    (config.protectiveStop.mode === 'native-trail' ||
      config.protectiveStop.onBandBlock === 'native-trail')
  ) {
    out.push({
      level: 'info',
      code: 'break-even-lock-not-on-exchange',
      message:
        "The break-even lock cannot be placed on Binance as a native trailing stop, which has no fixed price. The bot enforces it on every check while it is running, but in native-trail mode the order resting at Binance never carries the lock, and with onBandBlock set to native-trail the fallback trailing order used when Binance's price band refuses the priced stop does not carry it either. Use the priced protective stop mode with onBandBlock set to notify or clamp to have the lock rest on Binance.",
      path: ['breakEvenLock', 'enabled'],
    });
  }

  return out;
};
