import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { createApiStrategyRegistry } from '../../src/strategies/registry.js';

/**
 * The descriptor must carry the strategy's `reasonAttribution` verbatim so the
 * SPA names entry-blocker levers off the strategy's declaration, not a copy
 * hardcoded in apps/web (invariant #1). Strategies that declare no attribution
 * leave the field undefined.
 */
describe('api strategy registry reasonAttribution passthrough', () => {
  it('carries trailing-trade reasonAttribution onto its descriptor verbatim', () => {
    const registry = buildStrategyRegistry();
    const tt = registry.list().find((s) => s.name === 'trailing-trade');
    const descriptors = createApiStrategyRegistry(registry).describeAll();
    const d = descriptors.find((x) => x.name === 'trailing-trade');
    expect(d?.reasonAttribution).toBeDefined();
    expect(d?.reasonAttribution).toEqual((tt as { reasonAttribution?: unknown }).reasonAttribution);
  });

  it('carries momentum reasonAttribution onto its descriptor verbatim', () => {
    const registry = buildStrategyRegistry();
    const mo = registry.list().find((s) => s.name === 'momentum');
    const descriptors = createApiStrategyRegistry(registry).describeAll();
    const d = descriptors.find((x) => x.name === 'momentum');
    expect(d?.reasonAttribution).toBeDefined();
    expect(d?.reasonAttribution).toEqual((mo as { reasonAttribution?: unknown }).reasonAttribution);
  });

  it('omits reasonAttribution for strategies that declare none (rebalance)', () => {
    const descriptors = createApiStrategyRegistry(buildStrategyRegistry()).describeAll();
    expect(descriptors.find((d) => d.name === 'rebalance')?.reasonAttribution).toBeUndefined();
  });
});
