// balance-value — per-row USD valuation from the backend-supplied per-asset
// usdPrice (issue #641). The value no longer derives from a symbol-price map;
// each balance row carries its own usdPrice written by the market-trend cron,
// so `balanceUsdValue` reads `balance.usdPrice` from its single argument.

import { describe, expect, it } from 'vitest';

import { balanceUsdValue, totalUsdValue } from '@/features/profile/lib/balance-value';

import { asDecimalString, type ProfileDashboardResponse } from '@app/contracts';

type AssetBalance = ProfileDashboardResponse['balances'][number];

const bal = (asset: string, free: string, locked: string, usdPrice: string | null): AssetBalance =>
  ({
    asset,
    free: asDecimalString(free),
    locked: asDecimalString(locked),
    usdPrice: usdPrice == null ? null : asDecimalString(usdPrice),
  }) as AssetBalance;

describe('balanceUsdValue', () => {
  it('values (free + locked) × usdPrice when the row carries a usdPrice', () => {
    expect(balanceUsdValue(bal('ETH', '1.5', '0.5', '2000'))).toBe(4000);
  });

  it('returns null when usdPrice is null', () => {
    expect(balanceUsdValue(bal('DOGE', '1000', '0', null))).toBeNull();
  });

  it('returns null when usdPrice is absent', () => {
    const noPrice = {
      asset: 'ENA',
      free: asDecimalString('5'),
      locked: asDecimalString('0'),
    } as AssetBalance;
    expect(balanceUsdValue(noPrice)).toBeNull();
  });
});

describe('totalUsdValue', () => {
  it('sums every priced balance and ignores unpriced ones', () => {
    const total = totalUsdValue([
      bal('BTC', '1', '0', '70000'),
      bal('USDT', '500', '0', '1'),
      bal('DOGE', '9999', '0', null),
    ]);
    expect(total).toBe(70500);
  });
});
