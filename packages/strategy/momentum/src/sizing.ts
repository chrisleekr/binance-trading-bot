import { Decimal } from '@app/money';
import { accountEquity, decOrNull } from '@app/strategy-core';
import type { AccountSnapshot } from '@app/strategy-core';
import type { MomentumConfig } from './schema.js';

/** Why an entry was not sized; the tick logs the tag so the no-silent-failure invariant holds. */
export type EntrySizingSkip = 'sizing-unconfigured' | 'cap-reached';

/** Resolved entry budget (quote-asset, decimal-string) or a typed skip. */
export type EntryBudget = { readonly budget: string } | { readonly skip: EntrySizingSkip };

/**
 * Quote budget for the next entry, after percentage resolution, the free-cash
 * clamp, and the reserve cap. A single `min(desired, freeCash, headroom)`:
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
 * A merely small budget (tiny headroom, percent of near-zero equity, no free
 * cash) is returned as a budget and rejected downstream by computeEntryQuantity
 * as min-notional, which carries its own reason.
 */
export const resolveEntryBudget = (
  config: MomentumConfig,
  account: AccountSnapshot,
  quoteAsset: string,
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
