import { describe, expect, it } from 'vitest';
import type { TechnicalsSignal } from '@app/contracts';
import { LruSignalCache } from '../../src/backtest/signal-cache.js';

// The cache is value-opaque (it never inspects the signal), so a tagged stub
// stands in for a real TechnicalsSignal.
const signal = (tag: string): TechnicalsSignal => ({ tag }) as unknown as TechnicalsSignal;
const tagOf = (r: TechnicalsSignal | undefined): string | undefined =>
  (r as unknown as { tag: string } | undefined)?.tag;

describe('LruSignalCache', () => {
  it('stores and returns values by key', () => {
    const c = new LruSignalCache(10);
    c.set('a', signal('A'));
    expect(tagOf(c.get('a'))).toBe('A');
    expect(c.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once the bound is reached', () => {
    const c = new LruSignalCache(2);
    c.set('a', signal('A'));
    c.set('b', signal('B'));
    c.set('c', signal('C')); // overflows: 'a' is oldest and evicted
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(tagOf(c.get('b'))).toBe('B');
    expect(tagOf(c.get('c'))).toBe('C');
  });

  it('a read marks recency, so the read key survives the next eviction', () => {
    const c = new LruSignalCache(2);
    c.set('a', signal('A'));
    c.set('b', signal('B'));
    c.get('a'); // 'a' is now most-recent; 'b' becomes the eviction target
    c.set('c', signal('C'));
    expect(tagOf(c.get('a'))).toBe('A');
    expect(c.get('b')).toBeUndefined();
  });

  it('overwriting an existing key updates in place without growing or evicting', () => {
    const c = new LruSignalCache(2);
    c.set('a', signal('A'));
    c.set('b', signal('B'));
    c.set('a', signal('A2'));
    expect(c.size).toBe(2);
    expect(tagOf(c.get('a'))).toBe('A2');
    expect(tagOf(c.get('b'))).toBe('B');
  });
});
