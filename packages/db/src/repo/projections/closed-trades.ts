import type { ClosedTradesPeriod, ClosedTradesResponse, DecimalString } from '@app/contracts';

import type { ProfileScope } from '../_scoped.js';
import * as tradeArchive from '../trade-archive.js';

/**
 * Period totals for the closed-trades widget. The `{from, to}` window is
 * computed by the request layer (timezone normalisation is a request-layer
 * concern) and passed in; this projection only sums `trade_archive` profit
 * over that window and echoes the period back for the client's label.
 */
export const getClosedTradesForPeriod = async (
  scope: ProfileScope,
  args: { period: ClosedTradesPeriod; tz: string; from: Date; to: Date },
): Promise<ClosedTradesResponse> => {
  const { totalProfit, totalProfitPercent, tradeCount } = await tradeArchive.sumProfitInRange(
    scope,
    args.from,
    args.to,
  );
  return {
    period: args.period,
    tz: args.tz,
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    totalProfit: totalProfit as DecimalString,
    totalProfitPercent: totalProfitPercent as DecimalString,
    tradeCount,
  };
};
