import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { LruCandleCache } from '../../src/backtest/candle-cache.js';

// The cache is value-opaque (it never inspects the candles), so a tagged stub
// array stands in for a real loaded window.
const window = (tag: string): Candle[] => [{ tag } as unknown as Candle];
const tagOf = (w: Candle[] | undefined): string | undefined =>
  (w?.[0] as unknown as { tag: string } | undefined)?.tag;

describe('LruCandleCache', () => {
  it('stores and returns windows by key', () => {
    const c = new LruCandleCache(10);
    c.set('a', window('A'));
    expect(tagOf(c.get('a'))).toBe('A');
    expect(c.get('missing')).toBeUndefined();
  });

  it('returns the same array reference (shared read-only window, no copy)', () => {
    const c = new LruCandleCache(10);
    const w = window('A');
    c.set('a', w);
    expect(c.get('a')).toBe(w);
  });

  it('evicts the least-recently-used entry once the bound is reached', () => {
    const c = new LruCandleCache(2);
    c.set('a', window('A'));
    c.set('b', window('B'));
    c.set('c', window('C')); // overflows: 'a' is oldest and evicted
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(tagOf(c.get('b'))).toBe('B');
    expect(tagOf(c.get('c'))).toBe('C');
  });

  it('a read marks recency, so the read key survives the next eviction', () => {
    const c = new LruCandleCache(2);
    c.set('a', window('A'));
    c.set('b', window('B'));
    c.get('a'); // 'a' is now most-recent; 'b' becomes the eviction target
    c.set('c', window('C'));
    expect(tagOf(c.get('a'))).toBe('A');
    expect(c.get('b')).toBeUndefined();
  });

  it('overwriting an existing key updates in place without growing or evicting', () => {
    const c = new LruCandleCache(2);
    c.set('a', window('A'));
    c.set('b', window('B'));
    c.set('a', window('A2'));
    expect(c.size).toBe(2);
    expect(tagOf(c.get('a'))).toBe('A2');
    expect(tagOf(c.get('b'))).toBe('B');
  });
});
