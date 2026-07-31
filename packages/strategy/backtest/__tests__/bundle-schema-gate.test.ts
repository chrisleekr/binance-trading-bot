// The BACKTEST tick fails closed on a schema-invalid bundle: a bundle from
// `buildBundle` that violates the strategy's `bundleSchema` must be rejected
// BEFORE `strategy.tick` runs, so the engine throws the schema error instead of
// feeding a malformed bundle to the strategy. This mirrors the live tick
// boundary so the two assemblers stay symmetric.
//
// The probe declares a bundleSchema that rejects the engine's default `{}`
// bundle and its `tick` is a spy: `runBacktest` rejects on the first tick and
// `tick` is never called.

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { candleSource, flatCandles, idleStrategy, SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
};

describe('runBacktest — a schema-invalid bundle fails closed before strategy.tick', () => {
  it('throws at the tick boundary and never calls tick when buildBundle yields an invalid bundle', async () => {
    const tick = vi.fn(idleStrategy.tick);
    // Rejects the `{}` bundle the engine assembles: `mustBePresent` is required.
    const probe = {
      ...idleStrategy,
      bundleSchema: z.object({ mustBePresent: z.string() }),
      tick,
    } as unknown as typeof idleStrategy;

    await expect(
      runBacktest({
        ...baseOpts,
        strategy: probe,
        config: {},
        fillModel: new IdealFillModel(),
        dataSource: candleSource(flatCandles(3, '100')),
        // Explicit schema-invalid bundle (also the engine default): missing key.
        buildBundle: () => ({}),
      }),
      // Assert the SCHEMA error specifically, so an unrelated engine throw can't
      // false-pass this fail-closed gate.
    ).rejects.toThrow(z.ZodError);

    // The strategy never runs on an invalid bundle.
    expect(tick).not.toHaveBeenCalled();
  });
});
