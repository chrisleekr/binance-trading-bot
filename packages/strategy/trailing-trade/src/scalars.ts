import type { TickInput } from '@app/strategy-core';
import { hasOpenBuyForSymbol, hasOpenSellForSymbol } from './decisions.js';
import type { TTBundle, TTConfig, TTState } from './schema.js';

// Cross-branch reads hoisted once per tick. Only values consulted by more
// than one branch (or that a branch and the terminal snapshot share) live
// here; per-branch config knobs stay local to their branch. Keep this
// narrow — it is not a god-object for every field a branch happens to read.
export interface TickScalars {
  readonly now: number;
  readonly hasOpenBuy: boolean;
  readonly hasOpenSell: boolean;
}

export const buildScalars = (input: TickInput<TTConfig, TTState, TTBundle>): TickScalars => {
  const { market, openOrders, clock, profile } = input;
  return {
    now: clock.nowMs(),
    hasOpenBuy: hasOpenBuyForSymbol(openOrders, market.symbol),
    hasOpenSell: hasOpenSellForSymbol(openOrders, market.symbol, profile.id),
  };
};
