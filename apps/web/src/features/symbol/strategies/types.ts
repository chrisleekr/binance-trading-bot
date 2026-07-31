// StrategyView — the web's view contract, mirroring the backend plugin
// pattern for the symbol screen. Each strategy owns how its operational
// surfaces render; the symbol route resolves a view by `strategyName` through
// the registry and falls back to a generic view for any unknown strategy, so
// a non-trailing-trade strategy never renders grid garbage or crashes.
//
// Strategy view modules live under apps/web (not the strategy packages) so the
// packages stay React-free; invariant #1 only bars apps/api and apps/worker
// from importing strategy packages, and these modules import types only.

import type { SymbolStateResponse } from '@app/contracts';

export interface StrategyViewProps {
  readonly profileId: string;
  readonly symbol: string;
  readonly state: SymbolStateResponse;
  /** Latest close from the candle feed, or null before candles load. */
  readonly currentPrice: string | null;
}

export interface StrategyView {
  readonly strategyName: string;
  /** The "what is the bot about to do" signal readout (always present). */
  readonly SignalPanel: (props: StrategyViewProps) => React.JSX.Element;
  /**
   * Optional strategy-specific side panel (trailing-trade: the grid ladder).
   * Omitted when the strategy has no bespoke panel; the route renders nothing.
   */
  readonly SidePanel?: (props: StrategyViewProps) => React.JSX.Element;
}
