import { assertClientOrderId, djb2Hex } from '@app/strategy-core';

/**
 * Deterministic clientOrderId for a rebalance trade. Folds the triggering
 * candle's close time + side so each candle's rebalance gets a distinct id while
 * a retried tick on the same candle coalesces at Binance rather than
 * double-placing. `rb` = rebalance.
 */
export const rebalanceClientOrderId = (
  profileId: string,
  symbol: string,
  candleCloseMs: number,
  side: 'BUY' | 'SELL',
): string =>
  assertClientOrderId(
    `rb-${djb2Hex(`${profileId}|${symbol}|${candleCloseMs}|${side}`)}-${side === 'BUY' ? 'b' : 's'}`,
  );
