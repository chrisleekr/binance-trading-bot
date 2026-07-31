import { buildStrategyRegistry } from '@app/strategy-registry';
import { createApiStrategyRegistry, type ApiStrategyRegistry } from './strategies/registry.js';

// The api facade wraps the shared core registry instance and delegates every
// lookup to it, so the operator-action capabilities the api gates on cannot
// drift from what the worker enforces — both resolve a strategy name the same
// way. The facade adds only the SPA descriptor serialisation.
/** Process-scoped strategy set; shared bootstrap with apps/worker via @app/strategy-registry. */
export const strategies: ApiStrategyRegistry = createApiStrategyRegistry(buildStrategyRegistry());
