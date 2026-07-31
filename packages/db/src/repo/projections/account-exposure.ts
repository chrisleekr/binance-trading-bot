import { isHeldPosition } from '@app/contracts';
import { eq, isNull, and } from 'drizzle-orm';

import { avgEntryPrices } from '../../schema/avg-entry-prices.js';
import { orders } from '../../schema/orders.js';
import { profiles } from '../../schema/profiles.js';
import type { AccountScope } from '../_scoped.js';

/**
 * Open-exposure counts for a whole account: live orders resting on the book and
 * symbols still holding a position, summed across EVERY profile under it. The
 * delete-account guard reads this before the cascade, which would otherwise
 * erase the local record of orders that keep sitting on Binance.
 *
 * Account-wide rather than a per-profile loop: an account with many profiles would
 * otherwise pay 2N round-trips on a route that already blocks on a destructive
 * write. The position predicate is the shared `isHeldPosition` (recorded avg-entry
 * price + strictly positive quantity), so this guard and the profile-level one
 * cannot drift apart.
 *
 * Orders are counted off `orders.account_id`, NOT through a `profiles` join: a
 * DETACHED order (profile_id NULL, left behind by a deleted profile) may still be
 * resting on Binance, and it is precisely the exposure this guard exists to
 * refuse deleting.
 */
export const countAccountOpenExposure = async (
  scope: AccountScope,
): Promise<{ openOrderCount: number; openPositionCount: number }> => {
  const [live, positions] = await Promise.all([
    scope.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.accountId, scope.accountId), isNull(orders.closedAt))),
    scope.db
      .select({
        avgEntryPrice: avgEntryPrices.avgEntryPrice,
        quantity: avgEntryPrices.quantity,
      })
      .from(avgEntryPrices)
      .innerJoin(profiles, eq(avgEntryPrices.profileId, profiles.id))
      .where(eq(profiles.accountId, scope.accountId)),
  ]);
  return {
    openOrderCount: live.length,
    openPositionCount: positions.filter((p) => isHeldPosition(p.avgEntryPrice, p.quantity)).length,
  };
};
