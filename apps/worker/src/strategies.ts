import { buildStrategyRegistry, type StrategyRegistry } from '@app/strategy-registry';

/** Process-scoped strategy registry; shared bootstrap with apps/api via @app/strategy-registry. */
export const strategies: StrategyRegistry = buildStrategyRegistry();
