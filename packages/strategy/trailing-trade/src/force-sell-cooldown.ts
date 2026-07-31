// Re-entry cooldown shared across every first-entry path. A technicals
// force-sell stamps `forceSellCooldownUntilMs`; while the clock has not passed
// it, a fresh first entry on the symbol is suppressed so the strategy does not
// buy straight back into the downturn it just sold out of. The cooldown
// timestamp deliberately survives the position close, so it is the only state a
// flat profile carries from the prior cycle.

import { log, metric } from '@app/strategy-core';
import type { LogEntry, MetricEntry } from '@app/strategy-core';
import type { TTState } from './schema.js';

/** True while `now` is before the stamped re-entry deadline (cooldown active). */
export const forceSellCooldownActive = (state: TTState, now: number): boolean =>
  state.forceSellCooldownUntilMs !== null && now < state.forceSellCooldownUntilMs;

/**
 * Paired log + metric every first-entry path emits when it refuses a buy
 * because the re-entry cooldown is still active. One shape so the three call
 * sites (auto-trigger-buy timer, override trigger-buy, normal first entry) read
 * identically on the dashboard.
 */
export const forceSellCooldownBlock = (
  symbol: string,
  state: TTState,
): { readonly log: LogEntry; readonly metric: MetricEntry } => ({
  log: log('info', 'tt-force-sell-cooldown-blocked', {
    symbol,
    cooldownUntilMs: state.forceSellCooldownUntilMs,
  }),
  metric: metric('tt_force_sell_cooldown_blocked', { symbol }),
});
