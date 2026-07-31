import { describe, expect, it } from 'vitest';
import { regimeWindowAsOf } from '../../src/backtest/backtest-runner.js';
import type { Candle } from '@app/strategy-core';

// Daily candle `i` closes at the end of day i; its close value is String(i) so
// assertions read the included indices directly. `day(i)` is deterministic, so
// tests reference it directly instead of indexing the array (avoids non-null `!`).
const day = (i: number): Candle => ({
  openTimeMs: i * 86_400_000,
  closeTimeMs: i * 86_400_000 + 86_399_999,
  open: '1',
  high: '1',
  low: '1',
  close: String(i),
  volume: '1',
  isClosed: true,
});

describe('regimeWindowAsOf', () => {
  it('returns only candles closed at or before asOfMs (no lookahead)', () => {
    const daily = Array.from({ length: 10 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const asOf = day(4).closeTimeMs;
    const w = regimeWindowAsOf(daily, asOf, cursor, 'BTC');
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2', '3', '4']);
    expect(w.every((c) => c.closeTimeMs <= asOf)).toBe(true);
  });

  it('excludes a still-forming candle (asOf one ms before its close)', () => {
    const daily = Array.from({ length: 6 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const w = regimeWindowAsOf(daily, day(3).closeTimeMs - 1, cursor, 'BTC');
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2']);
  });

  it('advances forward-only across monotonic asOf calls', () => {
    const daily = Array.from({ length: 6 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    regimeWindowAsOf(daily, day(1).closeTimeMs, cursor, 'BTC');
    const w = regimeWindowAsOf(daily, day(4).closeTimeMs, cursor, 'BTC');
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2', '3', '4']);
    expect(cursor.get('BTC')).toBe(5);
  });

  it('caps the window to the trailing 250 candles', () => {
    const daily = Array.from({ length: 300 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const w = regimeWindowAsOf(daily, day(299).closeTimeMs, cursor, 'BTC');
    expect(w).toHaveLength(250);
    expect(w.map((c) => c.close)).toEqual(Array.from({ length: 250 }, (_, i) => String(50 + i)));
  });

  it('returns an empty window before the first daily candle closes', () => {
    const daily = Array.from({ length: 5 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    expect(regimeWindowAsOf(daily, day(0).openTimeMs, cursor, 'BTC')).toHaveLength(0);
  });
});
