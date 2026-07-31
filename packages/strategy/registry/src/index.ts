import { createRegistry, type StrategyRegistry } from '@app/strategy-core';
import { trailingTrade } from '@app/strategy-trailing-trade';
import { momentum } from '@app/strategy-momentum';
import { rebalance } from '@app/strategy-rebalance';

/**
 * Single source of truth for the registered strategy plugin set. apps/api and
 * apps/worker each call this at boot so both processes hold identical
 * registrations without a custom lint rule policing two bootstrap files.
 */
export const buildStrategyRegistry = (): StrategyRegistry => {
  const registry = createRegistry();
  registry.register(trailingTrade);
  registry.register(momentum);
  registry.register(rebalance);
  return registry;
};

export { type StrategyRegistry } from '@app/strategy-core';
