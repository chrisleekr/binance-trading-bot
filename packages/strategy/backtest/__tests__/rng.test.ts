import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/rng.js';

describe('SeededRng', () => {
  it('is deterministic for a fixed seed', () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces a different stream for a different seed', () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    expect(a.next()).not.toEqual(b.next());
  });

  it('returns values in [0, 1)', () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('accepts a bigint seed', () => {
    const a = new SeededRng(123n);
    const b = new SeededRng(123n);
    expect(a.next()).toEqual(b.next());
  });
});
