import { Decimal } from '@app/money';
import { accountEquity, decOrNull } from '@app/strategy-core';
import type { AccountSnapshot, Candle } from '@app/strategy-core';
import { coerceDec } from './config-coerce.js';
import type { MomentumConfig } from './schema.js';
import { initialStopDistanceFraction } from './trailing-stop.js';

/** Every reason an entry was not sized. A const tuple rather than a bare union so the attribution and state-schema drift guards can enumerate it; the tick logs the tag so the no-silent-failure invariant holds. */
export const ENTRY_SIZING_SKIPS = [
  'sizing-unconfigured',
  'cap-reached',
  'risk-sizing-unavailable',
] as const;

/** Why an entry was not sized. */
export type EntrySizingSkip = (typeof ENTRY_SIZING_SKIPS)[number];

/** What the prospective entry would look like, which is what the risk cap needs to turn a stop distance into a budget: the fill price and the closed-candle window the stop would be measured against. */
export interface EntryContext {
  readonly price: string;
  readonly candles: readonly Candle[];
}

/** Fraction of equity risked per trade, as a Decimal in (0, 1), else the 1% default. `coerceDec` already floors at the fallback for absent, malformed and non-positive input, so only the upper bound is left to check: a value at or above 1 would risk the whole account on one stop. Falling back here where an unusable stop distance instead refuses is deliberate, not an oversight: this is a numerator scalar whose worst case stays bounded by the `entrySizing` ceiling the cap is minimised against, so a substituted value can never size ABOVE the pre-cap budget, while the distance is a divisor whose bad value is unusable arithmetic with no bounded substitute. */
const riskPct = (raw: unknown): Decimal => {
  const d = coerceDec(raw, { fallback: '0.01' });
  return d.lt(1) ? d : new Decimal('0.01');
};

/** Resolved entry budget (quote-asset, decimal-string) or a typed skip. */
export type EntryBudget = { readonly budget: string } | { readonly skip: EntrySizingSkip };

/**
 * Quote budget for the next entry, after percentage resolution, the optional
 * risk cap, the free-cash clamp, and the reserve cap. A single
 * `min(desired, riskCap, freeCash, headroom)`:
 *   - desired   = a fixed amount, or `percent × equity`.
 *   - freeCash  = quote you can actually spend now.
 *   - headroom  = `cap% × equity − deployed`; the cap downsizes the entry to fit
 *     rather than vetoing it (single-order entry, so shrinking is coherent).
 *
 * Returns a typed skip — not a zero budget — only when a specific reason is worth
 * surfacing:
 *   - `sizing-unconfigured`: entrySizing absent/invalid. The live worker reads
 *     stored config unparsed, so a config saved before this field existed lands
 *     here; hold until re-saved (fail-safe, no guess).
 *   - `cap-reached`: already at/over the reserve cap (headroom ≤ 0).
 *   - `risk-sizing-unavailable`: risk sizing is on but the initial stop distance
 *     could not be resolved (see initialStopDistanceFraction). Fail closed —
 *     sizing off some other distance would size the position against a stop that
 *     is not the one about to rest under it.
 * A merely small budget (tiny headroom, percent of near-zero equity, no free
 * cash) is returned as a budget and rejected downstream by computeEntryQuantity
 * as min-notional, which carries its own reason.
 *
 * When `riskSizing` is on, `desired` is additionally capped at
 * `riskPct × equity ÷ initialStopDistance`, so an entry the cap binds stands to
 * lose `riskPct` of the account if its stop fires AT THE ENTRY-TIME DISTANCE,
 * however wide that distance is. Caveats, each one-directional. The list is not
 * exhaustive, and cannot be: slippage past a limit, and a gap that opens straight
 * through the level, are unmodellable by any entry-time sizing.
 *   - the clamps below can shrink the budget further, never widen it, so the realised risk of a clamped entry is under `riskPct`, not over.
 *   - the resting stop is re-derived every tick, so volatility expanding after entry widens the distance past the one this size was set against.
 *   - the modelled loss assumes a fill AT the stop price. That bound holds only while `protectiveStop.enabled` is true, which is the state a profile created from `defaultMomentumConfig` starts in even though the schema LEAF defaults to false, so it is the operative case for a wizard-built profile and not for a stored config saved before the block existed. When it holds, the resting order is a STOP_LOSS_LIMIT whose limit sits `limitOffsetPercentage` BELOW the trigger (0.98 by default, so 2% under), so a tripped stop is honoured down to `1 − (1 − d) × limitOffsetPercentage`, where `d` is the RESOLVED stop distance — `trailingStopPct` on the fixed leg, `multiple × ATR ÷ price` on the ATR leg this cap exists for, which is not a config constant at all. Worked at the fixed 5% / 0.98 defaults the worst honoured fill loses 6.9%, about 38% more than `riskPct` provisioned for; a 33% ATR distance at the same offset is honoured only down to 34.3%.
 *   - with `protectiveStop` disabled — a pre-block stored config, or one the operator turned off, rather than the state a new profile is seeded in — nothing rests at the exchange, and the exit is an in-process MARKET sell. No limit bounds it, so the figure above does not apply and the overshoot is whatever the market moved between two ticks.
 *   - a band refusal changes WHICH order rests, and neither substitute carries the ATR distance the size was measured from. Under `onBandBlock: 'native-trail'` the exchange-native trail is sized off the FIXED `trailingStopPct` (see momentumStopBandSettings), which the ATR leg overrides in force but not here, so the resting trail is not bounded to be the tighter of the two. Under the `notify` default nothing is substituted at all, so the modelled loss holds only while the worker is up.
 * The cap only ever SHRINKS: `entrySizing` stays the ceiling, and a stop tight
 * enough for the cap to exceed it leaves the budget untouched.
 *
 * @param config - Momentum config, read unparsed: every sizing leaf may be absent or malformed.
 * @param account - Wallet snapshot; supplies both the free quote cash and, with the deployed total, the equity every percentage resolves against.
 * @param quoteAsset - The symbol's quote asset, naming which balance line is spendable cash.
 * @param entry - The prospective fill price and closed-candle window the risk cap measures the initial stop distance from. Read only when `riskSizing` is on.
 * @returns The budget as a quote-asset decimal string, or a typed skip naming which lever held the entry.
 */
export const resolveEntryBudget = (
  config: MomentumConfig,
  account: AccountSnapshot,
  quoteAsset: string,
  entry: EntryContext,
): EntryBudget => {
  const sizing = config.entrySizing;
  const equity = accountEquity(account, quoteAsset);

  let desired: Decimal | null;
  if (sizing?.mode === 'fixed') {
    desired = decOrNull(sizing.amount);
  } else if (sizing?.mode === 'percentOfAccount') {
    const pct = decOrNull(sizing.percent);
    desired = pct === null ? null : pct.mul(equity);
  } else {
    desired = null;
  }
  if (desired === null) return { skip: 'sizing-unconfigured' };

  // Applied here, before the free-cash and reserve-cap clamps below, so those two
  // still bind afterwards: the risk cap is one more term in the same min, never a
  // replacement for the others.
  // The placement also fixes which reason a profile that is BOTH fully deployed and on a
  // warming-up symbol is told, since this returns before the `cap-reached` check can. That
  // ordering is deliberate and matches `sizing-unconfigured` above: "cannot size at all"
  // outranks "sized, but no headroom", because the first says the requested number does not
  // exist while the second says a real number was computed and then refused. Only the
  // reported reason is at stake — all three are `min` operands, so the budget arithmetic
  // itself is order-independent.
  const risk = config.riskSizing;
  if (risk?.enabled === true) {
    const price = decOrNull(entry.price);
    const dist = price === null ? null : initialStopDistanceFraction(config, entry.candles, price);
    if (dist === null) return { skip: 'risk-sizing-unavailable' };
    desired = Decimal.min(desired, riskPct(risk.riskPct).mul(equity).div(dist));
  }

  const bal = account.balances[quoteAsset];
  // Coerce before comparing so a numeric wire-format (string) balance that
  // reached sizing without revival can't throw the missing-.gt TypeError inside
  // a pure tick(); mirrors trailing-trade. A malformed non-numeric balance
  // still throws, by the strategy-core revival contract. Coercing an
  // already-revived Decimal is a value no-op.
  const free = bal ? new Decimal(bal.free) : new Decimal(0);
  const freeCash = free.gt(0) ? free : new Decimal(0);
  // Floor both operands at zero so the budget is never negative: today the
  // schema bounds (amount > 0, percent in (0,1], equity >= 0) keep `desired`
  // non-negative, but the floor makes the invariant local rather than a caller
  // contract — a negative budget would otherwise flow to a negative quantity.
  let budget = Decimal.min(Decimal.max(desired, new Decimal(0)), freeCash);

  const cap = config.accountCap;
  if (cap?.mode === 'percentOfAccount') {
    const capPct = decOrNull(cap.percent);
    if (capPct !== null) {
      const deployed = decOrNull(account.deployedQuoteAcrossProfiles) ?? new Decimal(0);
      const headroom = capPct.mul(equity).sub(deployed);
      if (headroom.lte(0)) return { skip: 'cap-reached' };
      budget = Decimal.min(budget, headroom);
    }
  }

  return { budget: budget.toString() };
};
