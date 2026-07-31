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
