import { describe, expect, it } from 'vitest';

import {
  MAX_TECHNICALS_INTERVALS,
  TechnicalsBundleConfigSchema,
  TechnicalsBundleSchema,
} from '../src/technicals.js';

const row = (interval: string, overrides: Record<string, boolean> = {}) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  ...overrides,
});

describe('TechnicalsBundleConfigSchema.useOnlyWithinMin default (issue #649 C3/E11)', () => {
  // Widen the buy-gate freshness window default from 2 to 5 minutes so a new
  // profile's Technicals signal is not treated as expired between the ~1-min
  // compute cadence and normal tick jitter (maxAgeMs 120000 → 300000). Existing
  // profiles are unaffected until the live config bump. RED until Phase B.
  it('defaults to 5 minutes', () => {
    expect(TechnicalsBundleConfigSchema.parse({}).useOnlyWithinMin).toBe(5);
  });
});

describe('TechnicalsBundleConfigSchema intervals max-3 cap', () => {
  it(`accepts ${MAX_TECHNICALS_INTERVALS} distinct intervals`, () => {
    const result = TechnicalsBundleConfigSchema.safeParse({
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [row('1m'), row('5m'), row('1h')],
    });
    expect(result.success).toBe(true);
  });

  it(`rejects ${MAX_TECHNICALS_INTERVALS + 1} intervals with a max-cap message`, () => {
    const result = TechnicalsBundleConfigSchema.safeParse({
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [row('1m'), row('5m'), row('1h'), row('4h')],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.issues.some((i) => /up to 3 intervals/i.test(i.message))).toBe(true);
  });
});

describe('TechnicalsBundleConfigSchema intervals uniqueness', () => {
  it('rejects an intervals[] with two rows on the same interval', () => {
    const result = TechnicalsBundleConfigSchema.safeParse({
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '5m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
        {
          interval: '5m',
          whenStrongBuy: false,
          whenBuy: false,
          whenSell: true,
          whenStrongSell: false,
          whenNeutral: false,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const dup = result.error.issues.find((i) => i.path.join('.') === 'intervals.1.interval');
    expect(dup).toBeDefined();
    expect(dup?.message).toMatch(/duplicate interval/i);
  });

  it('accepts an intervals[] with distinct intervals', () => {
    const result = TechnicalsBundleConfigSchema.safeParse({
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [
        {
          interval: '5m',
          whenStrongBuy: true,
          whenBuy: true,
          whenSell: false,
          whenStrongSell: false,
          whenNeutral: false,
        },
        {
          interval: '1h',
          whenStrongBuy: true,
          whenBuy: false,
          whenSell: false,
          whenStrongSell: true,
          whenNeutral: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty intervals[] (Technicals opt-out)', () => {
    const result = TechnicalsBundleConfigSchema.safeParse({
      useOnlyWithinMin: 2,
      ifExpires: 'do-not-buy',
      intervals: [],
    });
    expect(result.success).toBe(true);
  });
});

/**
 * The `TechnicalsBundleSchema.superRefine` invariant — `signals` and
 * `config.intervals` must be the same length and pair index-for-index
 * by interval. Without this guard a producer could ship signals for the
 * wrong interval and the buy gate would silently consult the wrong row.
 * No test covered this before iter9; locked down here.
 */
describe('TechnicalsBundleSchema 1:1 signals↔config.intervals invariant', () => {
  const config = (intervals: string[]) => ({
    useOnlyWithinMin: 2,
    ifExpires: 'do-not-buy' as const,
    intervals: intervals.map((i) => row(i)),
  });
  const signal = (interval: string) => ({
    interval,
    signal: { symbol: 'BTCUSDT', recommendation: 'BUY' as const, receivedAtMs: 1_700_000_000_000 },
  });
  const nullSignal = (interval: string) => ({ interval, signal: null });

  it('accepts a single-interval bundle whose signal pairs by interval', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config(['1h']),
      signals: [signal('1h')],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a multi-interval bundle when signals pair in order', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config(['1m', '5m', '1h']),
      signals: [signal('1m'), nullSignal('5m'), signal('1h')],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bundle whose signals length differs from config.intervals', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config(['1m', '5m']),
      signals: [signal('1m')],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const len = result.error.issues.find((i) => i.path.join('.') === 'signals');
    expect(len?.message).toMatch(/1:1 with config\.intervals/);
  });

  it('rejects when a signal interval at index N does not match config.intervals[N].interval', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config(['1m', '5m']),
      signals: [signal('1m'), signal('1h')], // misaligned at index 1
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const mismatch = result.error.issues.find((i) => i.path.join('.') === 'signals.1.interval');
    expect(mismatch?.message).toMatch(/must equal config\.intervals\[1\]\.interval/);
  });

  it('accepts an empty bundle (opt-out: zero intervals, zero signals)', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config([]),
      signals: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bundle with intervals but no signals', () => {
    const result = TechnicalsBundleSchema.safeParse({
      config: config(['1m']),
      signals: [],
    });
    expect(result.success).toBe(false);
  });
});
