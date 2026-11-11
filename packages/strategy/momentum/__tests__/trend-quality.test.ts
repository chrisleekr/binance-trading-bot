import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import {
  trendQualityLevel,
  trendQualityNeed,
  trendQualityReading,
  trendQualitySettings,
} from '../src/trend-quality.js';

const candles = (closes: readonly number[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: String(c),
    high: String(c),
    low: String(c),
    close: String(c),
    volume: '1',
    isClosed: true,
  }));

// Independent float oracle: the research harness rule, written with plain numbers and none of the plugin's helpers.
const fit = (closes: readonly number[]) => {
  const y = closes.map(Math.log);
  const n = y.length;
  const xm = (n - 1) / 2;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  y.forEach((v, x) => {
    sxx += (x - xm) ** 2;
    sxy += (x - xm) * (v - ym);
    syy += (v - ym) ** 2;
  });
  const slope = sxy / sxx;
  return {
    r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy),
    slope,
    fitted: ym + slope * (n - 1 - xm),
    last: y[n - 1]!,
  };
};
const oracleFires = (closes: readonly number[], i: number, n: number, minR2: number): boolean => {
  const a = fit(closes.slice(i - n + 1, i + 1));
  const b = fit(closes.slice(i - n, i));
  return a.r2 > minR2 && a.slope > 0 && a.last > a.fitted && !(b.r2 > minR2 && b.slope > 0);
};

// n = 5 cases, six closes each (the judged fit plus the previous bar's fit), measured with the oracle above at minRSquared 0.9.
const cfg = { lookback: 5 };
// Fresh straight climb (R2 0.943, previous bar 0.695) closing above its line.
const FIRE = [100, 99, 100, 101, 103, 106];
// Straight climb (R2 0.945, previous bar 0.600) but the last close is under the line.
const BELOW_LINE = [100, 97, 99, 102, 105, 105];
// Straight climb closing above its line, but the previous bar (R2 0.975) was already straight and rising.
const STALE = [100, 101, 102, 103, 105, 108];
// R2 0.994 and a close above the line, but the slope is negative.
const FALLING = [100, 101, 98, 96, 94, 92];
// Rising, closing above the line, but too ragged: R2 0.04.
const RAGGED = [100, 98, 101, 104, 102, 99];

describe('trendQualityReading', () => {
  it('fires on a fresh straight climb closing above its line, matching the float oracle', () => {
    const r = trendQualityReading(candles(FIRE), cfg)!;
    const a = fit(FIRE.slice(1));
    expect(r.fired).toBe(true);
    expect(r.armed).toBe(true);
    expect(r.previousArmed).toBe(false);
    expect(r.rSquared.toNumber()).toBeCloseTo(a.r2, 9);
    expect(r.slope.toNumber()).toBeCloseTo(a.slope, 9);
    expect(r.aboveLine.toNumber()).toBeCloseTo(a.last - a.fitted, 9);
  });

  it('matches the float oracle on a longer series with the default 48-close fit', () => {
    const closes = Array.from(
      { length: 120 },
      (_, i) => 100 * Math.exp(0.01 * i + 0.05 * Math.sin(i / 3)),
    );
    const r = trendQualityReading(candles(closes), undefined)!;
    const a = fit(closes.slice(-48));
    const b = fit(closes.slice(-49, -1));
    expect(r.rSquared.toNumber()).toBeCloseTo(a.r2, 9);
    expect(r.slope.toNumber()).toBeCloseTo(a.slope, 9);
    expect(r.aboveLine.toNumber()).toBeCloseTo(a.last - a.fitted, 9);
    expect(r.previousArmed).toBe(b.r2 > 0.9 && b.slope > 0);
    // A log-scale fit and a plain-price fit differ visibly on a series this steep, so this pins the log.
    const plain = closes.slice(-48);
    const xm = 23.5;
    const ym = plain.reduce((s, v) => s + v, 0) / 48;
    const sxy = plain.reduce((s, v, x) => s + (x - xm) * (v - ym), 0);
    expect(Math.abs(r.slope.toNumber() - sxy / 1128 / ym)).toBeGreaterThan(1e-5);
  });

  it('refuses when R-squared only equals the minimum', () => {
    const r2 = trendQualityReading(candles(FIRE), cfg)!.rSquared.toFixed();
    expect(trendQualityReading(candles(FIRE), { ...cfg, minRSquared: r2 })?.fired).toBe(false);
  });

  it('refuses a ragged rise, a falling line and a close under the line, each on one leg', () => {
    const ragged = trendQualityReading(candles(RAGGED), cfg)!;
    expect(ragged.slope.gt(0)).toBe(true);
    expect(ragged.aboveLine.lt(0)).toBe(true);
    expect([ragged.armed, ragged.fired]).toEqual([false, false]);
    const falling = trendQualityReading(candles(FALLING), cfg)!;
    expect(falling.rSquared.gt('0.9')).toBe(true);
    expect(falling.aboveLine.gt(0)).toBe(true);
    expect([falling.armed, falling.fired]).toEqual([false, false]);
    const below = trendQualityReading(candles(BELOW_LINE), cfg)!;
    expect([below.armed, below.previousArmed, below.fired]).toEqual([true, false, false]);
    expect(below.aboveLine.lt(0)).toBe(true);
  });

  it('refuses when the previous bar was already straight and rising, even above the line', () => {
    const r = trendQualityReading(candles(STALE), cfg)!;
    expect([r.armed, r.previousArmed]).toEqual([true, true]);
    expect(r.aboveLine.gt(0)).toBe(true);
    expect(r.fired).toBe(false);
  });

  // The previous bar's R2 set exactly to the minimum is not armed (strict), so a fresh fit still fires.
  it('treats a previous bar whose R-squared only equals the minimum as not armed', () => {
    const prevR2 = trendQualityReading(candles([1, ...FIRE.slice(0, -1)]), cfg)!.rSquared.toFixed();
    expect(trendQualityReading(candles(FIRE), { ...cfg, minRSquared: prevR2 })?.fired).toBe(true);
  });

  it('does not check the previous bar close against its own line', () => {
    // The previous bar (100, 102, 105, 108, 108) is straight and rising with its close under its line, and the judged bar closes above its own line. Still armed before, so the judged bar is not fresh.
    const r = trendQualityReading(candles([100, 102, 105, 108, 108, 112]), cfg)!;
    expect(r.aboveLine.gt(0)).toBe(true);
    expect([r.armed, r.previousArmed, r.fired]).toEqual([true, true, false]);
  });

  it('reads R-squared as 0 for equal closes', () => {
    const r = trendQualityReading(candles([5, 5, 5, 5, 5, 5]), cfg)!;
    expect(r.rSquared.toFixed()).toBe('0');
    expect(r.fired).toBe(false);
  });

  it('returns null until the window holds lookback plus one closes', () => {
    expect(trendQualityNeed(cfg)).toBe(6);
    expect(trendQualityReading(candles(FIRE.slice(1)), cfg)).toBeNull();
    expect(trendQualityReading(candles(FIRE), cfg)).not.toBeNull();
  });
});

// Seeded PRNG (mulberry32) so the walk is identical on every run and nothing impure runs in the test.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('trendQualityReading on a seeded random walk', () => {
  // The walk drifts for 30 bars at a time, so straight climbs form; a pure random walk would almost never fire.
  it('fires on exactly the bars the plain-float rule fires on', { timeout: 60_000 }, () => {
    const next = prng(5);
    const closes = [100];
    let drift = 0.03;
    for (let i = 1; i < 600; i++) {
      if (i % 30 === 0) drift = (next() - 0.4) * 0.06;
      closes.push(closes[i - 1]! * Math.exp(drift + 0.1 * (next() - 0.5)));
    }
    const n = 10;
    const settings = { lookback: n, minRSquared: '0.5' };
    const all = candles(closes);
    const got: number[] = [];
    const want: number[] = [];
    for (let i = n; i < closes.length; i++) {
      if (trendQualityReading(all.slice(0, i + 1), settings)?.fired === true) got.push(i);
      if (oracleFires(closes, i, n, 0.5)) want.push(i);
    }
    expect(want.length).toBeGreaterThanOrEqual(10);
    expect(got).toEqual(want);
  });
});

describe('trendQualitySettings', () => {
  it('falls back to the researched defaults for absent or malformed leaves', () => {
    const d = trendQualitySettings(undefined);
    expect([d.lookback, d.minRSquared.toFixed()]).toEqual([48, '0.9']);
    expect(trendQualitySettings({ lookback: 2, minRSquared: 'x' })).toMatchObject({ lookback: 48 });
    expect(trendQualitySettings({ minRSquared: 'x' }).minRSquared.toFixed()).toBe('0.9');
    const set = trendQualitySettings({ lookback: '24', minRSquared: '0.8' });
    expect([set.lookback, set.minRSquared.toFixed()]).toEqual([24, '0.8']);
  });
});

describe('trendQualityLevel', () => {
  // Closes grow 10% a candle, so they sit exactly on a line in log space and the line's last value is the last close.
  it('projects the fitted line at the last candle', () => {
    const geometric = Array.from({ length: 6 }, (_, i) => 100 * 1.1 ** i);
    expect(trendQualityLevel(candles(geometric), cfg)?.toNumber()).toBeCloseTo(100 * 1.1 ** 5, 6);
  });

  it('projects nothing while the window is shorter than the tick needs', () => {
    expect(trendQualityLevel(candles(FIRE.slice(1)), cfg)).toBeNull();
  });
});

describe('trendQualityReading memo', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i + (i % 3));

  it('returns the same reading for an equal window and a new one when a close differs', () => {
    const a = trendQualityReading(candles(closes), {});
    expect(trendQualityReading(candles([...closes]), {})).toBe(a);
    const changed = [...closes.slice(0, -1), closes[closes.length - 1]! + 5];
    expect(trendQualityReading(candles(changed), {})).not.toBe(a);
  });
});
