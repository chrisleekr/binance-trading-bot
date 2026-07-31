// Every replay-fixture bundle MUST satisfy its strategy's declared bundleSchema,
// because the tick boundary now parses the assembled bundle before tick() (both
// the live worker and the backtest engine). A bundle the tick genuinely accepts
// but the schema rejects would fail-close a legitimate tick, so the golden-replay
// corpus — the exact bundles the strategies consume — is the ground truth that
// the schema is not stricter than what fail-open assembly produces.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStrategyRegistry } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → registry → strategy: the sibling plugin packages hold the fixtures.
const strategyRoot = join(here, '..', '..');

// Each JSONL line is one recorded tick frame; `.input.bundle` is the assembled
// per-tick bundle the strategy saw.
const bundlesOf = (absPath: string): readonly unknown[] =>
  readFileSync(absPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { input: { bundle: unknown } }).input.bundle);

const ttDir = join(strategyRoot, 'trailing-trade', 'fixtures', 'replay', 'synthesised');
const momentumFile = join(strategyRoot, 'momentum', 'fixtures', 'replay', 'cross-cycle.jsonl');

type Case = readonly [strategyName: string, frameLabel: string, bundle: unknown];

const cases: Case[] = [];
for (const file of readdirSync(ttDir).filter((f) => f.endsWith('.jsonl'))) {
  bundlesOf(join(ttDir, file)).forEach((bundle, i) => {
    cases.push(['trailing-trade', `${file}#${i}`, bundle]);
  });
}
bundlesOf(momentumFile).forEach((bundle, i) => {
  cases.push(['momentum', `cross-cycle.jsonl#${i}`, bundle]);
});

const registry = buildStrategyRegistry();

describe('bundleSchema accepts every replay-fixture bundle', () => {
  it('collected frames for both strategies (non-vacuous)', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c[0] === 'trailing-trade')).toBe(true);
    expect(cases.some((c) => c[0] === 'momentum')).toBe(true);
  });

  it.each(cases)('%s parses fixture bundle %s against its bundleSchema', (name, _label, bundle) => {
    const strategy = registry.get(name);
    expect(strategy).toBeDefined();
    // A fixture bundle the tick genuinely accepted must also pass the declared
    // schema, or the schema is lying about what the strategy consumes.
    expect(() => strategy!.bundleSchema.parse(bundle)).not.toThrow();
  });
});

// Pins the fail-open ∧ gate contract: a fully-degraded bundle (every optional
// slot emptied by fail-open assembly) must still parse. A future schema
// tightening that would fail-close a degraded tick fails HERE, not in production.
describe('bundleSchema accepts a fully-degraded bundle', () => {
  it('trailing-trade: null override and every per-interval signal null', () => {
    const tt = registry.get('trailing-trade');
    expect(tt).toBeDefined();
    // Reuse a real fixture bundle so config and its 1:1 interval pairing stay
    // valid, then degrade every optional slot: null the override and each
    // signal, drop the entry hint.
    const source = cases.find((c) => c[0] === 'trailing-trade')?.[2] as {
      technicals: { config: unknown; signals: readonly { interval: string }[] };
    };
    const degraded = {
      technicals: {
        config: source.technicals.config,
        signals: source.technicals.signals.map((s) => ({ interval: s.interval, signal: null })),
      },
      override: null,
    };
    expect(() => tt!.bundleSchema.parse(degraded)).not.toThrow();
  });

  it('momentum: override null', () => {
    const momentum = registry.get('momentum');
    expect(momentum).toBeDefined();
    expect(() => momentum!.bundleSchema.parse({ override: null })).not.toThrow();
  });
});
