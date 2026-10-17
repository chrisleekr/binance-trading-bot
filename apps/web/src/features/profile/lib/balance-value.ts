// Quote-asset valuation for the account balances panel — the estimated-value
// readout. Each balance row carries its own `usdPrice` (the market-trend cron's
// price map, attached by the profile-dashboard projection), so valuation no
// longer derives prices from the traded-symbol list. Display-only Number math:
// apps/web is barred from decimal.js and none of these values feed an order.

import type { ProfileDashboardResponse } from '@app/contracts';

type AssetBalance = ProfileDashboardResponse['balances'][number];

/**
 * Quote-asset value of a balance row (free + locked) from its own `usdPrice`,
 * or `null` when the asset is unpriced (null/absent price) or the arithmetic is
 * not finite.
 */
export function balanceUsdValue(balance: AssetBalance): number | null {
  const price = balance.usdPrice;
  if (price == null) return null;
  const value = (Number(balance.free) + Number(balance.locked)) * Number(price);
  return Number.isFinite(value) ? value : null;
}

/** Sum of every priced balance — the account's estimated value in the quote asset. */
export function totalUsdValue(balances: readonly AssetBalance[]): number {
  return balances.reduce((sum, b) => sum + (balanceUsdValue(b) ?? 0), 0);
}

/**
 * Whether a balance row holds nothing, free or locked.
 *
 * @param balance - One wallet balance row.
 * @returns True when both free and locked are zero.
 */
export function isZeroBalance(balance: AssetBalance): boolean {
  return Number(balance.free) === 0 && Number(balance.locked) === 0;
}

/**
 * How many held coins {@link totalUsdValue} leaves out for want of a price, so every surface showing that total can say it is partial.
 *
 * @param balances - The wallet's balance rows.
 * @returns The count of non-zero balances with no usable price.
 */
export function unpricedNonZeroCount(balances: readonly AssetBalance[]): number {
  return balances.filter((b) => !isZeroBalance(b) && balanceUsdValue(b) === null).length;
}
