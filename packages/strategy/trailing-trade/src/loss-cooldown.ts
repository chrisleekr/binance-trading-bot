// Re-entry cooldown after a LOSS exit, shared across every first-entry path. A
// stop-loss (always a loss) and a force-sell / regime-exit taken below cost
// stamp `lastLossExitAt`; while the clock has not passed
// `lastLossExitAt + lossCooldownMinutes`, a fresh first entry on the symbol is
// suppressed so the strategy does not buy straight back into the dump it just
// realised a loss into. The stamp deliberately survives the position close, so a
// flat profile carries it from the prior cycle until the cooldown lapses.

import { log, metric } from '@app/strategy-core';
import type { LogEntry, MetricEntry } from '@app/strategy-core';
import type { TTConfig, TTState } from './schema.js';

/** True while `now` is before the loss-exit deadline (cooldown active). */
export const lossExitCooldownActive = (state: TTState, config: TTConfig, now: number): boolean =>
  state.lastLossExitAt !== null &&
  now < state.lastLossExitAt + config.buy.lossCooldownMinutes * 60_000;

/**
 * Paired log + metric every first-entry path emits when it refuses a buy
 * because the loss-exit cooldown is still active. One shape so the call sites
 * (auto-trigger-buy timer, normal first entry) read identically on the
 * dashboard, mirroring `forceSellCooldownBlock`.
 */
export const lossCooldownBlock = (
  symbol: string,
  state: TTState,
): { readonly log: LogEntry; readonly metric: MetricEntry } => ({
  log: log('info', 'tt-loss-cooldown-blocked', {
    symbol,
    lastLossExitAt: state.lastLossExitAt,
    lastLossExitReason: state.lastLossExitReason,
  }),
  metric: metric('tt_loss_cooldown_blocked', { symbol }),
});

/**
 * Whole minutes remaining on the loss-exit cooldown, rounded up so a fraction of
 * a minute still reads as "1 left". Used to fill the entry-blocker detail the
 * web gloss renders. Returns 0 when no cooldown is pending or it has lapsed.
 */
export const lossCooldownMinutesLeft = (state: TTState, config: TTConfig, now: number): number => {
  if (state.lastLossExitAt === null) return 0;
  const deadline = state.lastLossExitAt + config.buy.lossCooldownMinutes * 60_000;
  const remainingMs = deadline - now;
  if (remainingMs <= 0) return 0;
  // `Math` is banned in strategy code (the Math.random→injected-RNG rule), so
  // ceil-divide by hand: whole minutes, plus one when any remainder is left.
  const remainder = remainingMs % 60_000;
  const wholeMinutes = (remainingMs - remainder) / 60_000;
  return remainder > 0 ? wholeMinutes + 1 : wholeMinutes;
};
