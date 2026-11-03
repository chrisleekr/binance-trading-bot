import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import {
  exhaustionLevel,
  exhaustionNeed,
  exhaustionReading,
  exhaustionSettings,
} from '../src/exhaustion.js';

const candle = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: (i + 1) * 3_600_000,
  open: String(open),
  high: String(high),
  low: String(low),
  close: String(close),
  volume: '1',
  isClosed: true,
});

// 400 flat candles at 100 with a 1-wide range, then `drop` candles that fall 1 each except every fourth, which bounces 0.4: a mostly one-way slide. The bounces keep RSI and choppiness off 0, where a strict ceiling could not be pinned.
const slide = (drop: number): Candle[] => {
  const out = Array.from({ length: 400 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
  let prev = 100;
  for (let k = 0; k < drop; k++) {
    const next = k % 4 === 3 ? prev + 0.4 : prev - 1;
    out.push(candle(400 + k, prev, Math.max(prev, next), Math.min(prev, next), next));
    prev = next;
  }
  return out;
};

// Independent float oracle: the same formulas as the harness that selected the rule (hyp.mjs chopOf, rsiOf, sma), written without the plugin's helpers.
const oracle = (b: readonly Candle[]) => {
  const h = b.map((x) => Number(x.high));
  const l = b.map((x) => Number(x.low));
  const c = b.map((x) => Number(x.close));
  const i = b.length - 1;
  let s = 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - 13; j <= i; j++) {
    s += Math.max(h[j]! - l[j]!, Math.abs(h[j]! - c[j - 1]!), Math.abs(l[j]! - c[j - 1]!));
    hi = Math.max(hi, h[j]!);
    lo = Math.min(lo, l[j]!);
  }
  const chop = (100 * Math.log10(s / (hi - lo))) / Math.log10(14);
  let ag = 0;
  let al = 0;
  for (let j = 1; j < c.length; j++) {
    const d = c[j]! - c[j - 1]!;
    const g = Math.max(d, 0);
    const q = Math.max(-d, 0);
    if (j <= 14) {
      ag += g / 14;
      al += q / 14;
    } else {
      ag = (ag * 13 + g) / 14;
      al = (al * 13 + q) / 14;
    }
  }
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  const sma = c.slice(-400).reduce((a, x) => a + x, 0) / 400;
  return { chop, rsi, below: 1 - c[i]! / sma };
};

describe('exhaustionReading', () => {
  it('fires on a one-way slide far under the 400-candle average with RSI oversold, matching the research formulas', () => {
    const b = slide(20);
    const want = oracle(b);
    const r = exhaustionReading(b, {});
    expect(r?.fired).toBe(true);
    expect(r?.choppiness.toNumber()).toBeCloseTo(want.chop, 9);
    expect(r?.rsi.toNumber()).toBeCloseTo(want.rsi, 9);
    expect(r?.belowAverage.toNumber()).toBeCloseTo(want.below, 9);
    // The slide is steep enough that every leg clears its default with room, so the three refusals below each isolate one leg.
    expect(want.chop).toBeLessThan(30);
    expect(want.rsi).toBeLessThan(25);
    expect(want.below).toBeGreaterThan(0.05);
  });

  // Each ceiling set exactly to the measured value: the comparison is strict, so each leg alone must refuse.
  it('refuses when choppiness only equals the ceiling', () => {
    const b = slide(20);
    const chop = exhaustionReading(b, {})!.choppiness.toFixed();
    expect(exhaustionReading(b, { maxChoppiness: chop })?.fired).toBe(false);
  });

  it('refuses when the close is only exactly minBelowAverage under the average', () => {
    const b = slide(20);
    const below = exhaustionReading(b, {})!.belowAverage.toFixed();
    expect(exhaustionReading(b, { minBelowAverage: below })?.fired).toBe(false);
  });

  it('refuses when RSI only equals the ceiling', () => {
    const b = slide(20);
    const rsi = exhaustionReading(b, {})!.rsi.toFixed();
    expect(exhaustionReading(b, { maxRsi: rsi })?.fired).toBe(false);
  });

  // A short slide is still oversold and one-way but has not yet dropped 5% under the long average.
  it('refuses a slide that has not yet run far enough under the average', () => {
    const r = exhaustionReading(slide(5), {});
    expect(r?.belowAverage.toNumber()).toBeLessThan(0.05);
    expect(r?.fired).toBe(false);
  });

  it('returns null until the window holds the 400-candle average plus the judged candle', () => {
    expect(exhaustionNeed()).toBe(401);
    expect(exhaustionReading(slide(20).slice(-400), {})).toBeNull();
    expect(exhaustionReading(slide(20).slice(-401), {})).not.toBeNull();
  });
});

describe('exhaustionSettings', () => {
  it('falls back to the researched defaults for absent or malformed leaves', () => {
    const d = exhaustionSettings(undefined);
    expect([d.maxChoppiness.toFixed(), d.minBelowAverage.toFixed(), d.maxRsi.toFixed()]).toEqual([
      '30',
      '0.05',
      '25',
    ]);
    expect(exhaustionSettings({ maxRsi: 'x' }).maxRsi.toFixed()).toBe('25');
    expect(exhaustionSettings({ maxRsi: '20' }).maxRsi.toFixed()).toBe('20');
  });
});

describe('exhaustionLevel', () => {
  // 400 flat closes at 100: the level is 100 less 5%.
  it('projects the 400-candle average less minBelowAverage', () => {
    expect(exhaustionLevel(slide(0), {})?.toFixed()).toBe('95');
    expect(exhaustionLevel(slide(0), { minBelowAverage: '0.1' })?.toFixed()).toBe('90');
  });

  it('projects nothing while the window is shorter than the average', () => {
    expect(exhaustionLevel(slide(0).slice(-399), {})).toBeNull();
  });
});
