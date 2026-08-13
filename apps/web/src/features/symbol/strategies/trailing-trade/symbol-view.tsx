// Trailing-trade's StrategyView: the grid-aware signal panel and the grid
// ladder side panel. The chart's ladder lines and the config preview are now
// generic (derived from the strategy's PreviewModel), so this view carries only
// the two bespoke live panels. The advanced-drawer grid actions are gated off
// the strategy's operatorActions, not this view.

import type { StrategyView, StrategyViewProps } from '@/features/symbol/strategies/types';
import { GridLadderPanel } from './grid-ladder.js';
import { SymbolSignalPanel } from './signal-panel.js';

export const trailingTradeView: StrategyView = {
  strategyName: 'trailing-trade',
  SignalPanel: ({ profileId, symbol, state, currentPrice }: StrategyViewProps) => (
    <SymbolSignalPanel
      profileId={profileId}
      symbol={symbol}
      strategy={state.strategy}
      holding={state.avgEntryPrice}
      currentPrice={currentPrice}
      exitBlocker={state.exitBlocker}
    />
  ),
  SidePanel: ({ state, currentPrice }: StrategyViewProps) => (
    <GridLadderPanel state={state} currentPrice={currentPrice} />
  ),
};
