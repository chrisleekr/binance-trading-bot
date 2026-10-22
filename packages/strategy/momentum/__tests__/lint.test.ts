import { describe, expect, it } from 'vitest';
import { MomentumConfigSchema, type MomentumConfig } from '../src/schema.js';
import { lintMomentumConfig } from '../src/lint.js';

// Minimal valid base config; tests override the blocks each rule reads.
const base = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    ...over,
  });

const codes = (c: MomentumConfig): string[] => lintMomentumConfig(c).map((d) => d.code);

// The one combination where the below-trend layer acts as configured.
const working = {
  entryTrigger: 'breakout',
  trendFilter: { enabled: true, period: 50 },
  atrTrailingStop: { enabled: true },
  belowTrendBreakout: { enabled: true },
};

describe('lintMomentumConfig', () => {
  it('is clean on a plain config and on a working below-trend layer', () => {
    expect(lintMomentumConfig(base())).toEqual([]);
    expect(lintMomentumConfig(base(working))).toEqual([]);
  });

  it('flags requireRising on a below-side trend filter', () => {
    const c = base({ trendFilter: { enabled: true, side: 'below', requireRising: true } });
    expect(codes(c)).toEqual(['require-rising-inert-below']);
    expect(codes(base({ trendFilter: { enabled: true, requireRising: true } }))).toEqual([]);
  });

  it.each([
    ['a non-breakout trigger', { entryTrigger: 'cross' }],
    ['the trend filter off', { trendFilter: { enabled: false } }],
    ['the trend filter on its below side', { trendFilter: { enabled: true, side: 'below' } }],
  ])('flags the below-trend layer as inert under %s', (_label, over) => {
    expect(codes(base({ ...working, ...over }))).toContain('below-trend-breakout-inert');
  });

  it('flags the layer ATR multiple when the ATR trailing stop is off', () => {
    const c = base({ ...working, atrTrailingStop: { enabled: false } });
    expect(lintMomentumConfig(c)).toEqual([
      expect.objectContaining({
        code: 'below-trend-atr-multiple-inert',
        path: ['belowTrendBreakout', 'atrMultiple'],
      }),
    ]);
  });

  it('stays quiet when the layer is off', () => {
    expect(
      lintMomentumConfig(
        base({ ...working, belowTrendBreakout: { enabled: false }, entryTrigger: 'cross' }),
      ),
    ).toEqual([]);
  });
});
