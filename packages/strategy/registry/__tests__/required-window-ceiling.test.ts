// A config's window demand must fit what one candle request can supply.
//
// `resolveCandleWindow` CAPS a strategy's `requiredWindow` at `MAX_CANDLE_WINDOW`, so a config asking for more does not get more — it gets the ceiling, and whatever the plugin does with a window shorter than it asked for. Each schema is therefore responsible for bounding its own window-driving leaves so the maximum a config can express still fits. This asserts that for every registered strategy at once.
//
// Completeness holds over strategies, not over leaves. The sorted-name equality below catches a whole new plugin, but `CASES` is a hand-written table, so a new window-driving leaf added to an EXISTING strategy folds into that strategy's `requiredWindow` and is never measured here. Adding one means adding it to `CASES`; nothing mechanical will notice its absence.
//
// Lives here rather than in either strategy package because `@app/strategy-registry` is the one workspace that already depends on all three plugins.
//
// The max+1 rejection is what keeps this honest: without it the table below could name any value at all and the ceiling assertion would pass vacuously, proving nothing about what an operator can actually save.

import { MAX_CANDLE_WINDOW } from '@app/strategy-core';
import { describe, expect, it } from 'vitest';

import { buildStrategyRegistry } from '../src/index.js';

/** One window-driving config leaf: its dotted path and the largest value its schema accepts. Written as literals, never derived from `MAX_CANDLE_WINDOW`, so the table measures the schemas rather than restating the ceiling — a schema that stops tracking the ceiling then fails the max+1 case instead of moving with it. */
interface WindowLeaf {
  readonly path: string;
  readonly max: number;
  /** Set when this leaf's term cannot be the widest under any schema-valid config, so maxing it alone leaves the demand unchanged. Such a leaf is exempt from the per-leaf contribution check below, and the reason it is structurally dominated belongs beside the flag. */
  readonly dominated?: true;
}

/**
 * Per strategy: the leaves that drive `requiredWindow`, plus whatever must be set for those leaves to count at all (a gate the strategy reads only while enabled contributes nothing to the window while it is off, so maxing its period without enabling it would measure the wrong config).
 */
interface WindowCase {
  readonly enable: Readonly<Record<string, unknown>>;
  readonly leaves: readonly WindowLeaf[];
}

const CASES: Readonly<Record<string, WindowCase>> = {
  'trailing-trade': {
    enable: {
      'buy.firstBuyTriggerBasis': 'lowest-price',
      'buy.meanReversionGate.entryZScoreMax': '-1',
    },
    leaves: [
      { path: 'buy.candleLimit', max: 999 },
      { path: 'buy.meanReversionGate.lookbackCandles', max: 400 },
    ],
  },
  momentum: {
    enable: {
      'trendFilter.enabled': true,
      'trendFilter.requireRising': true,
      'entryExtension.enabled': true,
      'atrTrailingStop.enabled': true,
    },
    leaves: [
      { path: 'ema.slow', max: 998 },
      { path: 'trendFilter.period', max: 400 },
      { path: 'trendFilter.slopeLookbackBars', max: 200 },
      { path: 'entryExtension.period', max: 400 },
      // ATR reads period + 1 candles, so this leaf tops out at a demand of 101 while the enabled trendFilter defaults already ask for 210. It is a correctness term rather than a load lever, and no schema-valid value of it can widen the window on its own.
      { path: 'atrTrailingStop.period', max: 100, dominated: true },
    ],
  },
  rebalance: {
    enable: { weightMode: 'momentum' },
    leaves: [{ path: 'momentum.lookbackCandles', max: 500 }],
  },
};

/** Clone `base` with `path` set to `value`, creating intermediate objects as needed. */
const withLeaf = (base: unknown, path: string, value: unknown): unknown => {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return value;
  const obj = (base ?? {}) as Record<string, unknown>;
  return {
    ...obj,
    [head]: rest.length === 0 ? value : withLeaf(obj[head], rest.join('.'), value),
  };
};

const applyAll = (base: unknown, entries: readonly (readonly [string, unknown])[]): unknown =>
  entries.reduce<unknown>((acc, [path, value]) => withLeaf(acc, path, value), base);

/** Read a dotted path out of a parsed config, or `undefined` when any segment along the way is missing. */
const readLeaf = (base: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((acc, seg) => (acc as Record<string, unknown> | undefined)?.[seg], base);

describe('requiredWindow stays inside the candle-window ceiling', () => {
  const strategies = buildStrategyRegistry().list();

  it('has a case for every registered strategy', () => {
    // A new plugin lands here rather than slipping through unmeasured.
    expect(strategies.map((s) => s.name).sort()).toEqual(Object.keys(CASES).sort());
  });

  describe.each(strategies.map((s) => [s.name, s] as const))('%s', (name, strategy) => {
    const testCase = CASES[name];
    if (testCase === undefined) throw new Error(`no window case declared for ${name}`);
    const enables = Object.entries(testCase.enable);

    it('fits the ceiling with every window leaf at its schema maximum', () => {
      const maxed = strategy.configSchema.parse(
        applyAll(
          applyAll(strategy.defaultConfig, enables),
          testCase.leaves.map((l) => [l.path, l.max] as const),
        ),
      );
      // Every config schema here is a non-strict `z.object`, so zod STRIPS an unrecognised key instead of rejecting it: a mistyped enable path parses clean, that gate's term is never measured, and the ceiling assertion below still passes. Reading the enables back off the parsed config is what turns that typo into a failure. The leaf maxima need no such read-back: a literal below the schema max is caught by the max+1 rejection below, and one above it throws at this parse.
      for (const [path, value] of enables) expect(readLeaf(maxed, path)).toEqual(value);
      const demand = strategy.requiredWindow?.(maxed) ?? 0;
      expect(demand).toBeLessThanOrEqual(MAX_CANDLE_WINDOW);
      // Guards the enabling leaves above: if none of them took effect the maxed config would demand no more than the default one, and the ceiling assertion would hold without measuring anything.
      expect(demand).toBeGreaterThan(strategy.requiredWindow?.(strategy.defaultConfig) ?? 0);
    });

    // `requiredWindow` folds its terms with `max`, so the widest leaf saturates the aggregate guard above and a term silently dropped from the fold would otherwise go unnoticed.
    it.each(
      testCase.leaves.filter((l) => l.dominated !== true).map((l) => [l.path, l.max] as const),
    )('folds %s into the window demand', (path, max) => {
      const baseline = strategy.configSchema.parse(applyAll(strategy.defaultConfig, enables));
      const one = strategy.configSchema.parse(
        applyAll(applyAll(strategy.defaultConfig, enables), [[path, max]]),
      );
      expect(strategy.requiredWindow?.(one) ?? 0).toBeGreaterThan(
        strategy.requiredWindow?.(baseline) ?? 0,
      );
    });

    it.each(testCase.leaves.map((l) => [l.path, l.max] as const))(
      'refuses %s above %i',
      (path, max) => {
        const overshoot = applyAll(applyAll(strategy.defaultConfig, enables), [[path, max + 1]]);
        expect(strategy.configSchema.safeParse(overshoot).success).toBe(false);
      },
    );
  });
});
