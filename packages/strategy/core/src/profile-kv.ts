import type { Strategy } from './contract.js';

/**
 * Whether a tick of this strategy under this config reads the profile's cross-symbol KV store. The one gate both the live worker and the backtest runner use, so a strategy that opts in by config sees the same store in both worlds.
 *
 * @param strategy - The strategy about to tick.
 * @param config - The profile's config for this tick, possibly unparsed.
 * @returns True when the static capability or the strategy's config predicate asks for the store.
 */
export const readsProfileKv = <Config>(
  strategy: Pick<Strategy<Config>, 'capabilities' | 'needsProfileKvFor'>,
  config: Config,
): boolean =>
  strategy.capabilities.needsProfileKv === true || strategy.needsProfileKvFor?.(config) === true;
