import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { createApiStrategyRegistry } from '../../src/strategies/registry.js';

/**
 * The api registry consumes `AnyStrategy` directly — there is no `toPlugin`
 * cast that could silently drop a field (the drop that hid momentum's
 * operatorActions from the descriptor). This test is the regression net: every
 * descriptor must carry the strategy's operatorActions verbatim.
 */
describe('api strategy registry describeAll', () => {
  it('carries each strategy operatorActions verbatim onto its descriptor', () => {
    const registry = buildStrategyRegistry();
    const strategies = registry.list();
    const descriptors = createApiStrategyRegistry(registry).describeAll();
    expect(descriptors).toHaveLength(strategies.length);
    for (const s of strategies) {
      const d = descriptors.find((x) => x.name === s.name && x.version === s.version);
      expect(d, `descriptor for ${s.name}@${s.version}`).toBeDefined();
      expect(d?.operatorActions).toEqual([...s.capabilities.operatorActions]);
    }
  });

  it('keeps the optional force-sell guard fields visible in the serialised TT config schema', () => {
    // The force-sell guards moved from `.default(0)` to `.optional()` plus a
    // bundle `.transform()`. `z.toJSONSchema(..., { io: 'input' })` is what keeps
    // a transform-bearing schema emitting its input fields; a future zod bump
    // that regressed that handling would silently drop the two inputs from the
    // config form with no other test noticing. Pin the render contract here.
    const descriptors = createApiStrategyRegistry(buildStrategyRegistry()).describeAll();
    const tt = descriptors.find((d) => d.name === 'trailing-trade');
    expect(tt, 'trailing-trade descriptor').toBeDefined();
    const serialised = JSON.stringify(tt?.configSchema);
    expect(serialised).toContain('forceSellConfirmMinutes');
    expect(serialised).toContain('forceSellReentryCooldownMinutes');
  });

  it('resolves a stored profile by name, not name@version (issue #407)', () => {
    // The fork this issue removes keyed lookup on `name@version`, so a profile
    // pinned to a since-bumped version resolved to null and 422'd operator
    // controls. The facade now delegates to the core name-only resolver.
    const facade = createApiStrategyRegistry(buildStrategyRegistry());
    const tt = facade.get('trailing-trade');
    expect(tt, 'trailing-trade is registered').toBeDefined();

    // A deliberately-stale stored version still resolves to the live plugin.
    const drifted = facade.describeForProfile('trailing-trade', '0.0.1-stale');
    expect(drifted.status).toBe('migratable');
    if (drifted.status === 'migratable') {
      expect(drifted.strategy).toBe(tt);
      expect(drifted.liveVersion).toBe(tt?.version);
      expect(drifted.storedVersion).toBe('0.0.1-stale');
    }

    // The current version resolves as `current`; an unknown name as `unknown`.
    expect(facade.describeForProfile('trailing-trade', tt?.version ?? '').status).toBe('current');
    expect(facade.describeForProfile('no-such-strategy', '1.0.0')).toEqual({
      status: 'unknown',
      name: 'no-such-strategy',
    });
  });
});

/**
 * Invariant #1 guard: the operator-action gate must read the generic
 * capabilities set, never branch on a concrete strategy identity. A
 * `strategyName === 'trailing-trade'` style literal would re-introduce the
 * per-strategy coupling the closed-token set exists to remove. Source-scan in
 * the spirit of packages/db's ast-check test.
 */
describe('manual-orders gate stays strategy-agnostic', () => {
  it('never branches on a concrete strategy name', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/lib/manual-orders.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/strategyName\s*===/);
    expect(src).not.toMatch(/===\s*['"](trailing-trade|momentum)['"]/);
  });
});
