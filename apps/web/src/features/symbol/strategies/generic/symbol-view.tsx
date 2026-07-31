// Generic StrategyView — the fallback for any strategy without a bespoke view
// module. Renders only strategy-agnostic facts: whether a position is open and
// its entry (last-buy) price. No grid, rung, trailing, or stop-loss concepts,
// so a non-grid strategy (e.g. momentum) reads honestly instead of showing a
// grid-shaped panel full of zeros. Open orders, balances, technicals, and the
// chart are shared chrome rendered by the route, not here.

import { formatPrice } from '@/shared/lib/format';

import type { StrategyView, StrategyViewProps } from '@/features/symbol/strategies/types';

function GenericSignalPanel({ state }: StrategyViewProps): React.JSX.Element {
  const lbp = state.avgEntryPrice?.avgEntryPrice ?? null;
  const isHolding = lbp !== null;
  return (
    <section className="space-y-2" data-testid="symbol-signal-panel">
      <h2 className="text-fg text-sm font-semibold">Signal</h2>
      {isHolding ? (
        <div
          className="divide-border divide-y rounded-none border"
          data-testid="symbol-signal-generic-holding"
        >
          <div className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs">
            <span className="text-muted-fg">Position</span>
            <span className="font-medium">Holding</span>
          </div>
          <div className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs">
            <span className="text-muted-fg">Entry price</span>
            <span className="font-mono">{formatPrice(lbp)}</span>
          </div>
        </div>
      ) : (
        <p className="text-muted-fg text-xs" data-testid="symbol-signal-generic-flat">
          Flat — no open position. This strategy has no grid view; open orders and balances are
          shown below.
        </p>
      )}
    </section>
  );
}

export const genericView: StrategyView = {
  strategyName: '__generic__',
  SignalPanel: GenericSignalPanel,
};
