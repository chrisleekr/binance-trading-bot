// Entry-halt filters for the tick path.
//
// The daily-loss circuit breaker pauses new BUY risk while letting exits, cancels,
// and events flow. Pure/injected so the fail-open behaviour is unit-testable
// without the tick harness.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Decision } from '@app/strategy-core';

/** The decisions a halt filter let through, and the ones it dropped. */
export interface HaltFilterResult {
  readonly kept: readonly Decision[];
  readonly dropped: readonly Decision[];
}

/**
 * Split new-capital BUY place-orders away from SELLs, cancels, and events. Used by
 * the daily-loss circuit breaker: when a profile's realised loss for the UTC day
 * has breached its limit, new entries and grid adds are suppressed for the rest of
 * the day, but exits and protective stops still run (the breaker pauses new risk,
 * it never force-sells). Pure so it can be unit-tested without the tick harness.
 *
 * The dropped set is returned, not just discarded: an operator override whose
 * order lands in it must be told the breaker killed it, and the only way to know
 * which dropped order was the override's is to look at the orders themselves.
 */
export const suppressBuyEntries = (decisions: readonly Decision[]): HaltFilterResult => {
  const kept: Decision[] = [];
  const dropped: Decision[] = [];
  for (const d of decisions) {
    if (d.type === 'place-order' && d.intent.side === 'BUY') dropped.push(d);
    else kept.push(d);
  }
  return { kept, dropped };
};

/**
 * Suppress new BUY entries for a tick when a per-profile halt flag is present.
 * Backs the daily-loss breaker — the only breaker that pauses buys: it pauses new
 * risk while letting exits, cancels, and events flow. Fails OPEN — a Redis read
 * error returns the decisions unchanged so a flag-read failure can never block an
 * exit or protective stop. `activeMsg`/`errorMsg` name the breaker so the operator
 * log reads truthfully. Deps are injected so the fail-open path is unit-testable.
 */
const applyEntryHalt = async (
  redis: Pick<Redis, 'exists'>,
  haltKey: string,
  decisions: readonly Decision[],
  logger: Pick<Logger, 'warn'>,
  ctx: { readonly profileId: string; readonly symbol: string },
  activeMsg: string,
  errorMsg: string,
): Promise<HaltFilterResult> => {
  try {
    const halted = await redis.exists(haltKey);
    if (!halted) return { kept: decisions, dropped: [] };
    const filtered = suppressBuyEntries(decisions);
    if (filtered.dropped.length > 0) {
      logger.warn(
        { profileId: ctx.profileId, symbol: ctx.symbol, dropped: filtered.dropped.length },
        activeMsg,
      );
    }
    return filtered;
  } catch (err) {
    logger.warn({ profileId: ctx.profileId, symbol: ctx.symbol, err: err }, errorMsg);
    // Fail-open: nothing was suppressed, so nothing may be reported as suppressed.
    return { kept: decisions, dropped: [] };
  }
};

/**
 * Daily-loss circuit breaker: when the profile's `entryHaltDaily` flag is present
 * (today's realised loss hit its limit), suppress new BUY orders for the rest of
 * the UTC day.
 */
export const applyDailyHalt = (
  redis: Pick<Redis, 'exists'>,
  haltKey: string,
  decisions: readonly Decision[],
  logger: Pick<Logger, 'warn'>,
  ctx: { readonly profileId: string; readonly symbol: string },
): Promise<HaltFilterResult> =>
  applyEntryHalt(
    redis,
    haltKey,
    decisions,
    logger,
    ctx,
    'daily-loss breaker active — new BUY orders suppressed until next UTC day',
    'daily-loss breaker flag read failed — proceeding without halt',
  );
