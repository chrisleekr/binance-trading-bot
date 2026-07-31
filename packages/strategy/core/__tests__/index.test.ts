import { describe, it, expect } from 'vitest';
import { IssueCode } from '../src/index.js';
import type { IndicatorSnapshot, Strategy } from '../src/index.js';

describe('@app/strategy-core surface', () => {
  it('exports IssueCode enum values', () => {
    expect(IssueCode.ConfigInvalid).toBe('config-invalid');
    expect(IssueCode.InvariantViolated).toBe('invariant-violated');
  });

  it('Strategy type accepts a minimal shape', () => {
    const _check = null as unknown as Strategy<{ x: number }, { y: number }>;
    expect(_check).toBeNull();
  });

  it('exports IndicatorSnapshot with decimal-string indicator fields', () => {
    const snap: IndicatorSnapshot = {
      windowSize: 200,
      lowestLow: '40000',
      highestHigh: '60000',
      sma20: '50000',
      ema20: null,
      rsi14: null,
      lastCandleCloseTimeMs: 1_700_000_000_000,
    };
    expect(snap.lowestLow).toBe('40000');
    expect(snap.rsi14).toBeNull();
  });
});
