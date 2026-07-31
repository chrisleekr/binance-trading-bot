// StrategyView registry — resolves the symbol screen's view by strategy name,
// mirroring the backend strategy registry. Adding a strategy view = a new
// module + one entry here; an unknown strategy resolves to the generic
// fallback so the symbol screen never crashes or renders the wrong shape.

import { genericView } from './generic/symbol-view.js';
import { trailingTradeView } from './trailing-trade/symbol-view.js';
import type { StrategyView } from './types.js';

const VIEWS: Readonly<Record<string, StrategyView>> = {
  [trailingTradeView.strategyName]: trailingTradeView,
};

/** The view for `strategyName`, or the generic fallback when none is registered. */
export function getStrategyView(strategyName: string): StrategyView {
  return VIEWS[strategyName] ?? genericView;
}

/**
 * Strategies whose backtest trades a basket of symbols rather than one. Their
 * symbols come from the strategy config (a weighted `targets` list), not the
 * single-symbol picker, so the backtest route hides the picker for them and
 * derives `BacktestParams.symbols` from the submitted config. Adding a basket
 * strategy = one entry here that `basketSymbolsFromConfig` can read.
 */
export const BASKET_STRATEGIES: ReadonlySet<string> = new Set(['rebalance']);

/**
 * The symbols a basket-strategy backtest must load, read from the config's
 * `targets` array. Runtime-guarded because the form hands untyped values, and
 * de-duplicated so a repeated target never double-loads its market data.
 */
export function basketSymbolsFromConfig(config: Record<string, unknown>): string[] {
  const raw = config['targets'];
  if (!Array.isArray(raw)) return [];
  const symbols = raw
    .map((t) =>
      t !== null && typeof t === 'object' ? (t as { symbol?: unknown }).symbol : undefined,
    )
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return [...new Set(symbols)];
}
