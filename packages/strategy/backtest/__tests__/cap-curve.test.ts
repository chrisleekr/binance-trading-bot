import { describe, expect, it } from 'vitest';
import { capCurve, MAX_CURVE_POINTS } from '../src/run.js';

describe('capCurve — stored equity/drawdown curve bound', () => {
  it('returns the array untouched (same reference, no copy) at or under the cap', () => {
    const small = Array.from({ length: 100 }, (_, i) => i);
    expect(capCurve(small)).toBe(small);
    const exact = Array.from({ length: MAX_CURVE_POINTS }, (_, i) => i);
    expect(capCurve(exact)).toBe(exact);
  });

  it('downsamples a large curve to exactly the cap, keeping the first and last point', () => {
    const big = Array.from({ length: 500_000 }, (_, i) => i);
    const out = capCurve(big);
    expect(out.length).toBe(MAX_CURVE_POINTS);
    expect(out[0]).toBe(0); // first always kept — the run's start
    expect(out[out.length - 1]).toBe(499_999); // last always kept — the final equity
    // Evenly spaced and monotonic (a stride sample of a monotonic input).
    expect(out.every((v, i) => i === 0 || v > (out[i - 1] as number))).toBe(true);
  });
});
