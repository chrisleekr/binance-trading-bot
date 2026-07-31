import { Decimal } from '@app/money';
import type { AnyStrategy, Candle, CandleInterval, SymbolInfo } from '@app/strategy-core';

/**
 * Per-symbol order-feasibility warnings for a backtest run: a config whose orders
 * size below the symbol's exchange minimum, or whose grid the starting balance
 * cannot fully fund, never places most of its buys, so the run's metrics are
 * meaningless. Surfaced as data-quality warnings (a manual run is already rejected
 * at create; a run enqueued outside that gate keeps running).
 *
 * Per-order minimums use the window's HIGHEST close — the worst case for the
 * base-asset minimum-quantity filter (qty = budget / price shrinks as price
 * rises). Funding uses the run's starting balance. Pure; returns one message per
 * `block` finding, symbol-prefixed. Empty for strategies without the check.
 */
export const orderFeasibilityWarnings = (
  strategy: AnyStrategy,
  config: unknown,
  symbolInfos: readonly SymbolInfo[],
  candlesByKey: ReadonlyMap<string, Candle[]>,
  strategyInterval: CandleInterval,
  initialQuoteBalance: string,
): string[] => {
  const check = strategy.checkOrderFeasibility;
  if (!check) return [];

  const out: string[] = [];
  for (const info of symbolInfos) {
    const bars = candlesByKey.get(`${info.symbol}|${strategyInterval}`);
    const first = bars?.[0];
    if (!bars || !first) continue;
    let maxClose = new Decimal(first.close);
    for (const bar of bars) {
      const close = new Decimal(bar.close);
      if (close.gt(maxClose)) maxClose = close;
    }
    for (const d of check({
      config,
      filters: info.filters,
      price: maxClose.toString(),
      availableQuote: initialQuoteBalance,
    })) {
      if (d.level === 'block') out.push(`${info.symbol}: ${d.message}`);
    }
  }
  return out;
};
