import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import { impulseLevel, impulseNeed, impulseReading } from '../src/impulse.js';

// Flat candles with a 1-wide range, so every true range and therefore ATR(14) is exactly 1, and volume 1 each, so the average volume is exactly 1.
const flat = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: '10',
    high: '10.5',
    low: '9.5',
    close: '10',
    volume: '1',
    isClosed: true,
  }));

const judged = (close: string, volume: string): Candle => ({
  openTimeMs: 15 * 3_600_000,
  closeTimeMs: 16 * 3_600_000,
  open: '10',
  high: close,
  low: '10',
  close,
  volume,
  isClosed: true,
});

const CFG = { volumeLookback: 3, volumeMultiple: '3', riseAtrMultiple: '2' };

describe('impulseReading', () => {
  // Both baselines must exclude the judged candle: counted in, its volume 4 would make the 3-candle average 2 and the ratio 2, and its own true range would lift the ATR, so either leak turns this into a miss.
  it('fires on a candle above volumeMultiple times the prior average and up more than riseAtrMultiple prior ATRs', () => {
    const r = impulseReading([...flat(15), judged('12.1', '4')], CFG);
    expect(r?.fired).toBe(true);
    expect(r?.volumeRatio.toFixed()).toBe('4');
    expect(r?.bodyAtr.toFixed()).toBe('2.1');
  });

  it('does not fire when the volume only equals the multiple', () => {
    expect(impulseReading([...flat(15), judged('12.1', '3')], CFG)?.fired).toBe(false);
  });

  it('does not fire when the rise only equals the ATR multiple', () => {
    expect(impulseReading([...flat(15), judged('12', '4')], CFG)?.fired).toBe(false);
  });

  it('does not fire on a heavy-volume DOWN candle', () => {
    expect(
      impulseReading([...flat(15), { ...judged('7.9', '4'), high: '10', low: '7.9' }], CFG)?.fired,
    ).toBe(false);
  });

  it('returns null until the window holds the volume lookback and the ATR warm-up plus the judged candle', () => {
    expect(impulseNeed(CFG)).toBe(16);
    expect(impulseNeed({ volumeLookback: 168 })).toBe(169);
    expect(impulseReading([...flat(14), judged('12.1', '4')], CFG)).toBeNull();
  });

  it('returns null when the baseline volume is zero rather than dividing by it', () => {
    const zero = flat(15).map((c) => ({ ...c, volume: '0' }));
    expect(impulseReading([...zero, judged('12.1', '4')], CFG)).toBeNull();
  });

  it('falls back to the researched defaults on an absent or malformed block', () => {
    expect(impulseNeed(undefined)).toBe(169);
    expect(impulseNeed({ volumeLookback: 'x' })).toBe(169);
    // Defaults 3x volume and 2 ATR: a 4x, 2.1 ATR candle fires on a 168-candle baseline.
    expect(impulseReading([...flat(168), judged('12.1', '4')], undefined)?.fired).toBe(true);
    expect(
      impulseReading([...flat(168), judged('12.1', '4')], { riseAtrMultiple: '-1' })?.fired,
    ).toBe(true);
  });
});

describe('impulseLevel', () => {
  it('projects the last close plus riseAtrMultiple ATRs', () => {
    expect(impulseLevel(flat(15), CFG)?.toFixed()).toBe('12');
  });

  it('is null while the window is too short for the ATR', () => {
    expect(impulseLevel(flat(14), CFG)).toBeNull();
  });
});
