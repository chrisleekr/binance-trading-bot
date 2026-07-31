import { isHeldPosition } from '@app/contracts';

import type { ProfileScope } from '../_scoped.js';
import * as avgEntryPrices from '../avg-entry-prices.js';
import * as orders from '../orders.js';

/**
 * Open-exposure counts for a profile: how many live orders rest on the book and
 * how many symbols still hold a position. The delete-profile guard reads this to
 * refuse a destructive wipe while real money is committed, so the operator
 * cancels/sells first instead of stranding orders on Binance with no local
 * record.
 *
 * Counted profile-wide (no `profile_symbols` join), unlike the home rollup: a
 * resting order or held position on a symbol discovery already rotated out is
 * exactly the case the guard must catch, and the symbol-scoped rollup would miss
 * it. A position is the shared `isHeldPosition` predicate (recorded avg-entry
 * price + strictly positive held quantity), so an entry-price-only marker row
 * does not falsely block the delete.
 */
export const countOpenExposure = async (
  scope: ProfileScope,
): Promise<{ openOrderCount: number; openPositionCount: number }> => {
  const [live, lbps] = await Promise.all([
    orders.listLiveForProfile(scope),
    avgEntryPrices.listForProfile(scope),
  ]);
  const openPositionCount = lbps.filter((l) => isHeldPosition(l.avgEntryPrice, l.quantity)).length;
  return { openOrderCount: live.length, openPositionCount };
};
