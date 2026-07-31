// Technicals force-sell evaluator.
//
// Each configured Technicals interval can wire to one or more "force-sell
// trigger" recommendations: whenSell / whenStrongSell / whenNeutral. A held
// position whose current price is below the configured sell-trigger
// threshold AND clears the profit floor force-sells at market the moment any
// interval reports a matching recommendation. The profit guard (a configurable
// `minProfitPercent` floor, default 0 = any profit above cost) + "below
// trigger" guard keep the rule from ever selling at a loss — force-sell only
// steps ahead of the normal sell ladder when Technicals calls a downturn.
//
// Stale-signal handling on the sell branch is intentionally asymmetric with
// the buy branch: the sell branch ignores stale recommendations
// unconditionally, even when the buy-side `ifExpires` is `allow-anyway`.
// `ifExpires` is documented as buy-side-only at its schema describe() too.
// Asymmetry rationale and provenance live in
// docs/architecture/technicals.md.
//
// Pure function, no I/O. Strategies/tests build the inputs and read the
// tagged-union result.

import { forceSellTriggers, type TechnicalsBundle, type TechnicalsSignal } from '@app/contracts';
import { Decimal } from '@app/money';

type TVRecommendation = NonNullable<TechnicalsSignal>['recommendation'];

/**
 * Inputs the evaluator needs to decide. All decimals are string-typed so the
 * call site preserves the worker's wire encoding; the evaluator parses each
 * exactly once via decimal.js.
 */
export interface TvForceSellInput {
  readonly tv: TechnicalsBundle;
  readonly currentPrice: string;
  readonly avgEntryPrice: string | null;
  readonly triggerPrice: string;
  readonly nowMs: number;
  /**
   * Minimum gross profit (percent above average cost) required before the
   * force-sell may fire. '0' / absent / unparseable means no floor, i.e. any
   * profit clears (the prior behaviour). A positive value raises the profit
   * guard from `price > avgEntryPrice` to `price > avgEntryPrice × (1 + pct/100)`
   * so a technicals sell can only book a gain larger than the round-trip fee.
   */
  readonly minProfitPercent?: string;
}

/**
 * Tagged-union result. `ok: false` means "no force-sell"; `ok: true` carries
 * the offending interval + recommendation so the caller can log a precise
 * `tt-technicals-force-sell` context line.
 */
export type TvForceSellResult =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly interval: string;
      readonly recommendation: TVRecommendation;
      /**
       * Age of the matched signal at the moment force-sell fired
       * (`nowMs - signal.receivedAtMs`, clamped at 0 for clock skew). Lifted
       * onto the result so the audit log can render "signal Nm old" the
       * same way the buy-gate veto branch already does.
       */
      readonly ageMs: number;
    };

/**
 * Evaluate force-sell-on-Technicals. Returns `{ ok: true, … }` when:
 *
 * 1. A position is held (`avgEntryPrice` non-null), and
 * 2. The current price is below the configured sell-trigger price (the
 *    same trigger the normal grid-sell branch uses — force-sell only fires
 *    when the regular ladder hasn't already armed), and
 * 3. The current price clears the profit floor
 *    (`currentPrice > avgEntryPrice × (1 + minProfitPercent/100)`); with the
 *    default `minProfitPercent` of `0` this is simply `currentPrice >
 *    avgEntryPrice`. The rule never sells at a loss, and a positive floor also
 *    blocks a "win" smaller than the round-trip fee, and
 * 4. Any configured interval's signal recommendation is in that interval's
 *    force-sell trigger set, and
 * 5. The matched signal is fresh per `useOnlyWithinMin` — stale signals
 *    do NOT trigger force-sell regardless of `ifExpires`; the sell branch
 *    always ignores expired signals, and `ifExpires` is a buy-side stance only.
 */
export const evaluateTechnicalsForceSell = (input: TvForceSellInput): TvForceSellResult => {
  const { tv, currentPrice, avgEntryPrice, triggerPrice, nowMs } = input;
  if (avgEntryPrice === null) return { ok: false };
  if (tv.config.intervals.length === 0) return { ok: false };

  let price: Decimal;
  let lastBuy: Decimal;
  let trigger: Decimal;
  try {
    price = new Decimal(currentPrice);
    lastBuy = new Decimal(avgEntryPrice);
    trigger = new Decimal(triggerPrice);
  } catch {
    return { ok: false };
  }
  if (!price.isFinite() || !lastBuy.isFinite() || !trigger.isFinite()) return { ok: false };
  // Below-trigger guard: when current price is at or above the normal
  // sell-trigger price, the standard sell ladder is responsible — no
  // force-sell needed.
  if (price.gte(trigger)) return { ok: false };
  // Profit guard: never force-sell at a loss, and never below the configured
  // minimum-profit floor. floor = lastBuy × (1 + minProfitPercent/100). An
  // absent / '0' / unparseable floor collapses to `lastBuy`, so the guard is
  // exactly `price <= lastBuy` (the prior any-profit behaviour).
  let minProfitPct = new Decimal(0);
  if (input.minProfitPercent !== undefined && input.minProfitPercent !== '') {
    try {
      const parsed = new Decimal(input.minProfitPercent);
      if (parsed.isFinite() && parsed.gte(0)) minProfitPct = parsed;
    } catch {
      // Unparseable floor → treat as off (no floor); the schema validates the
      // stored value, this guards a hand-edited raw config row.
    }
  }
  const profitFloor = lastBuy.times(minProfitPct.div(100).plus(1));
  if (price.lte(profitFloor)) return { ok: false };

  const maxAgeMs = tv.config.useOnlyWithinMin * 60_000;
  const signalByInterval = new Map<string, TechnicalsSignal | null>(
    tv.signals.map((s) => [s.interval, s.signal] as const),
  );
  for (const row of tv.config.intervals) {
    const triggers = forceSellTriggers(row);
    if (triggers.size === 0) continue;
    const signal = signalByInterval.get(row.interval) ?? null;
    if (signal === null) continue;
    // Sell side ignores stale signals unconditionally — `ifExpires` is a
    // buy-side stance only.
    const rawAgeMs = nowMs - signal.receivedAtMs;
    const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
    if (ageMs > maxAgeMs) continue;
    if (triggers.has(signal.recommendation)) {
      return {
        ok: true,
        interval: row.interval,
        recommendation: signal.recommendation,
        ageMs,
      };
    }
  }
  return { ok: false };
};
