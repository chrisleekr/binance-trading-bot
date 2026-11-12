import { describe, expect, it } from 'vitest';
import { closedWindowAsOf } from '../../src/backtest/replay.js';
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

describe('closedWindowAsOf', () => {
  it('returns only candles closed at or before asOfMs (no lookahead)', () => {
    const daily = Array.from({ length: 10 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const asOf = day(4).closeTimeMs;
    const w = closedWindowAsOf(daily, asOf, cursor, 'BTC', 250);
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2', '3', '4']);
    expect(w.every((c) => c.closeTimeMs <= asOf)).toBe(true);
  });

  it('excludes a still-forming candle (asOf one ms before its close)', () => {
    const daily = Array.from({ length: 6 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const w = closedWindowAsOf(daily, day(3).closeTimeMs - 1, cursor, 'BTC', 250);
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2']);
  });

  it('advances forward-only across monotonic asOf calls', () => {
    const daily = Array.from({ length: 6 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    closedWindowAsOf(daily, day(1).closeTimeMs, cursor, 'BTC', 250);
    const w = closedWindowAsOf(daily, day(4).closeTimeMs, cursor, 'BTC', 250);
    expect(w.map((c) => c.close)).toEqual(['0', '1', '2', '3', '4']);
    expect(cursor.get('BTC')).toBe(5);
  });

  it('caps the window to the trailing 250 candles', () => {
    const daily = Array.from({ length: 300 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    const w = closedWindowAsOf(daily, day(299).closeTimeMs, cursor, 'BTC', 250);
    expect(w).toHaveLength(250);
    expect(w.map((c) => c.close)).toEqual(Array.from({ length: 250 }, (_, i) => String(50 + i)));
  });

  it('returns an empty window before the first daily candle closes', () => {
    const daily = Array.from({ length: 5 }, (_, i) => day(i));
    const cursor = new Map<string, number>();
    expect(closedWindowAsOf(daily, day(0).openTimeMs, cursor, 'BTC', 250)).toHaveLength(0);
  });
});
