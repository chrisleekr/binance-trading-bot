import type { ClosedTradesPeriod, ClosedTradesResponse, DecimalString } from '@app/contracts';

import type { ProfileScope } from '../_scoped.js';
import * as tradeArchive from '../trade-archive.js';

/**
 * Period totals for the closed-trades widget. The `{from, to}` window is
 * computed by the request layer (timezone normalisation is a request-layer
 * concern) and passed in; this projection only sums `trade_archive` profit
 * over that window and echoes the period back for the client's label.
 *
 * @param scope - Ownership-proven profile scope.
 * @param args - `period`/`tz` are echoed back for the client's label; `from`/`to` bound the window; `quoteAsset` is the currency to count in, normally the profile's current one, so cycles closed under a previous quote are excluded rather than summed into a figure with no unit.
 * @returns The widget payload: the echoed period and the window's gross profit, profit percent, and trade count.
 */
export const getClosedTradesForPeriod = async (
  scope: ProfileScope,
  args: {
    period: ClosedTradesPeriod;
    tz: string;
    from: Date;
    to: Date;
    quoteAsset: string;
  },
): Promise<ClosedTradesResponse> => {
  const { totalProfit, totalProfitPercent, tradeCount } = await tradeArchive.sumProfitInRange(
    scope,
    args.quoteAsset,
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
