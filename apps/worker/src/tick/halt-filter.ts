// Entry-halt filters for the tick path.
//
// The three entry breakers (daily loss limit, loss-streak guard, drawdown guard) pause new BUY risk while letting exits, cancels, and events flow. Pure/injected so the fail-open behaviour is unit-testable without the tick harness.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { EntryHaltKind } from '@app/contracts';
import type { Decision } from '@app/strategy-core';

/** The decisions a split let through, and the ones it dropped. */
export interface SuppressResult {
  readonly kept: readonly Decision[];
  readonly dropped: readonly Decision[];
}

/** A halt filter's outcome: the split, plus which breakers were active. `kinds` is empty whenever nothing was suppressed, including on a failed read. */
export interface HaltFilterResult extends SuppressResult {
  readonly kinds: readonly EntryHaltKind[];
}

/**
 * Split new-capital BUY place-orders away from SELLs, cancels, and events. Used by the entry breakers: when one has tripped, new entries and grid adds are suppressed for the duration of its pause, but exits and protective stops still run (a breaker pauses new risk, it never force-sells). Pure so it can be unit-tested without the tick harness.
 *
 * The dropped set is returned, not just discarded: an operator override whose
 * order lands in it must be told the breaker killed it, and the only way to know
 * which dropped order was the override's is to look at the orders themselves.
 *
 * A BUY `replace-order` is dropped on the same terms. The variant is not proof
 * that no new capital is committed: its successor's quantity and price are
 * unconstrained by the order it retires, so a replacement can commit strictly
 * more than what was resting. Suppressing it leaves that resting BUY live, which
 * matches what the breaker already does with every other resting order, since it
 * pauses new risk and never cancels what the profile committed before the breach.
 */
export const suppressBuyEntries = (decisions: readonly Decision[]): SuppressResult => {
  const kept: Decision[] = [];
  const dropped: Decision[] = [];
  for (const d of decisions) {
    if ((d.type === 'place-order' || d.type === 'replace-order') && d.intent.side === 'BUY')
      dropped.push(d);
    else kept.push(d);
  }
  return { kept, dropped };
};

/**
 * Suppress new BUY entries for a tick when ANY of the profile's entry-halt flags is present. One multi-key EXISTS keeps the hot path (nothing halted) at a single round trip; the per-key reads that name the active breakers run only once that count is non-zero, because only then does anyone need the names.
 *
 * Fails OPEN — a Redis read error returns the decisions unchanged so a flag-read failure can never block an exit or protective stop. On that path `kinds` and `dropped` are both empty, because nothing was suppressed and so nothing may be reported as suppressed: a phantom entry would settle an operator's override as breaker-rejected when the breaker never ran.
 *
 * @param redis - Redis handle, narrowed to `exists` so a test can inject a stub or a fault.
 * @param keys - The profile's halt key per breaker kind, read by key rather than by iteration: `kinds` is reported in `EntryHaltKind` declaration order, which is where the shared order every breaker-listing surface uses comes from, so this object's own property order is irrelevant.
 * @param decisions - This tick's strategy output, unfiltered.
 * @param logger - Warn sink for the operator-facing "buys suppressed" and "flag read failed" lines.
 * @param ctx - The profile and symbol the tick is for, for the log lines only.
 * @returns The kept and dropped decisions plus every breaker kind found active. `kept` is the caller's own array, not a copy, exactly when no breaker was named — nothing set, every flag expired between the two passes, or the read failed; once a breaker IS named the split rebuilds it, including in the case where there were no BUYs to drop. `dropped` is non-empty only when `kinds` is, so a suppressed order can always be attributed to a real breaker.
 */
export const applyEntryHalts = async (
  redis: Pick<Redis, 'exists'>,
  keys: Readonly<Record<EntryHaltKind, string>>,
  decisions: readonly Decision[],
  logger: Pick<Logger, 'warn'>,
  ctx: { readonly profileId: string; readonly symbol: string },
): Promise<HaltFilterResult> => {
  const entries = EntryHaltKind.options.map((kind) => [kind, keys[kind]] as const);
  try {
    const any = await redis.exists(...entries.map(([, k]) => k));
    if (any === 0) return { kept: decisions, dropped: [], kinds: [] };
    const flags = await Promise.all(entries.map(([, k]) => redis.exists(k)));
    const kinds = entries.filter((_, i) => (flags[i] ?? 0) > 0).map(([kind]) => kind);
    // Every flag expired between the probe and this pass. That is genuinely "no halt", not "a halt we cannot name": suppressing here would drop BUYs while reporting no active breaker, and the tick handler would then have to invent a kind to name in the operator's rejection reason for an override it killed.
    if (kinds.length === 0) return { kept: decisions, dropped: [], kinds: [] };
    const filtered = suppressBuyEntries(decisions);
    if (filtered.dropped.length > 0) {
      logger.warn(
        { profileId: ctx.profileId, symbol: ctx.symbol, kinds, dropped: filtered.dropped.length },
        'entry breaker active — new BUY orders suppressed',
      );
    }
    return { ...filtered, kinds };
  } catch (err) {
    logger.warn(
      { profileId: ctx.profileId, symbol: ctx.symbol, err: err },
      'entry breaker flag read failed — proceeding without halt',
    );
    return { kept: decisions, dropped: [], kinds: [] };
  }
};
