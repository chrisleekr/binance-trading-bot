import { Decimal } from '@app/money';
import { accountEquity, decOrNull } from '@app/strategy-core';
import type { AccountSnapshot } from '@app/strategy-core';
import type { TTConfig } from './schema.js';

/** Why the no-grid entry was not sized; the tick logs the tag (no-silent-failure). */
export type EntrySizingSkip = 'sizing-unconfigured' | 'cap-reached';

/**
 * Hard ceiling on a single risk-based entry, as a fraction of equity. Risk-based
 * sizing scales the position by 1/stopDistance, so a tight stop would otherwise
 * size into the whole account; this caps any one entry at half of equity. Only
 * the risk-based path is clamped — the legacy deploy-percent fallback is not.
 */
const MAX_DEPLOY_FRACTION = new Decimal('0.5');

/** Resolved no-grid entry budget (quote-asset, decimal-string) or a typed skip. */
export type EntryBudget = { readonly budget: string } | { readonly skip: EntrySizingSkip };

/**
 * Resolve the account-wide cap to an absolute quote ceiling, or null when off /
 * absent / blank. A `percent` cap is `pct × equity`; an `amount` cap is the
 * amount. Shared by the no-grid entry downsize and the grid/pyramid veto
 * ({@link evaluateRiskCaps}) so both read one resolution rule.
 */
export const resolveAccountCapQuote = (
  cap: TTConfig['buy']['accountCap'],
  equity: Decimal,
): Decimal | null => {
  if (cap?.mode === 'amount') return decOrNull(cap.amount);
  if (cap?.mode === 'percent') {
    const pct = decOrNull(cap.percent);
    return pct === null ? null : pct.mul(equity);
  }
  return null;
};

/**
 * Stop distance as a fraction of the entry price, or null when no usable stop
 * will actually fire. Risk-based sizing leverages the position up by dividing by
 * this distance, on the premise that the stop caps the loss at `percent × equity`.
 * So it returns null unless BOTH the sell side is enabled — a disabled sell side
 * never runs the stop, leaving the full position at risk, so it must fall back to
 * the unleveraged deploy-percent (mirrors `risk-caps.ts`) — AND
 * `stopLossPercentage` is in (0, 1). A stop of 1 (at entry) or outside that range
 * gives a zero / meaningless distance and is rejected, which also avoids a
 * divide-by-zero. Read defensively: the live worker hands over raw config.
 */
export const stopDistanceFraction = (config: TTConfig): Decimal | null => {
  if (config.sell?.enabled !== true) return null;
  const stop = decOrNull(config.sell.stopLossPercentage);
  if (stop === null || !stop.gt(0) || !stop.lt(1)) return null;
  return new Decimal(1).sub(stop);
};

/**
 * Quote budget for the no-grid single entry: `min(desired, freeCash, headroom)`,
 * where desired is a fixed amount, or for a percent-of-account entry it is
 * `percent × equity ÷ stopDistance` (risk-based, capped at MAX_DEPLOY_FRACTION of
 * equity) when an active stop is set, else `percent × equity` (fallback); headroom
 * is the reserve-cap room (`capQuote − deployed`). The cap downsizes the single-order
 * entry to fit (grid rungs are vetoed instead — see risk-caps). Returns a typed
 * skip for `sizing-unconfigured` (absent/invalid entrySizing — the unparsed
 * live-config transition) and `cap-reached` (deployed at/over the cap); a merely
 * small budget flows through to computeFirstBuyQuantity (min-notional reason).
 */
export const resolveEntryBudget = (
  config: TTConfig,
  account: AccountSnapshot,
  quoteAsset: string,
  accountDeployedQuote = '0',
): EntryBudget => {
  const sizing = config.buy.entrySizing;
  const equity = accountEquity(account, quoteAsset);

  let desired: Decimal | null;
  // Tracks the risk-based path so only it gets the MAX_DEPLOY_FRACTION clamp; the
  // legacy deploy-percent fallback keeps its prior (uncapped) size.
  let riskBased = false;
  if (sizing?.mode === 'fixed') {
    desired = decOrNull(sizing.amount);
  } else if (sizing?.mode === 'percentOfAccount') {
    const pct = decOrNull(sizing.percent);
    if (pct === null) {
      desired = null;
    } else {
      const dist = stopDistanceFraction(config);
      if (dist === null) {
        // No usable stop → no defined risk; fall back to deploying `percent` of
        // equity (the pre-risk-sizing behaviour) so a profile without a stop
        // keeps trading rather than skipping.
        desired = pct.mul(equity);
      } else {
        // `percent` is the fraction of equity RISKED per trade: the position is
        // the risk budget divided by the stop distance, so the loss at the stop
        // equals `percent × equity`.
        desired = pct.mul(equity).div(dist);
        riskBased = true;
      }
    }
  } else {
    desired = null;
  }
  if (desired === null) return { skip: 'sizing-unconfigured' };

  // A fixed amount is the operator's explicit figure — taken as-is (historical
  // TT behaviour; the exchange validates affordability). A percent-of-equity
  // figure is derived, so it is clamped to spendable free cash to stay
  // meaningful when most of the account is already deployed.
  let budget = Decimal.max(desired, new Decimal(0));
  if (sizing.mode === 'percentOfAccount') {
    const bal = account.balances[quoteAsset];
    const free = bal ? new Decimal(bal.free) : new Decimal(0);
    const freeCash = free.gt(0) ? free : new Decimal(0);
    budget = Decimal.min(budget, freeCash);
    // A tight stop makes the risk-based size large; never let one entry exceed
    // MAX_DEPLOY_FRACTION of equity.
    if (riskBased) budget = Decimal.min(budget, equity.mul(MAX_DEPLOY_FRACTION));
  }

  const capQuote = resolveAccountCapQuote(config.buy.accountCap, equity);
  if (capQuote !== null) {
    const deployed = decOrNull(accountDeployedQuote) ?? new Decimal(0);
    const headroom = capQuote.sub(deployed);
    if (headroom.lte(0)) return { skip: 'cap-reached' };
    budget = Decimal.min(budget, headroom);
  }

  return { budget: budget.toString() };
};
