import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import { obvLeadNeed, obvLeadReading, obvLeadSettings } from '../src/obv-lead.js';

const candle = (i: number, prev: number, close: number, volume: number): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: (i + 1) * 3_600_000,
  open: String(prev),
  high: String(Math.max(prev, close)),
  low: String(Math.min(prev, close)),
  close: String(close),
  volume: String(volume),
  isClosed: true,
});

// Five up candles to a 110 high on volume 1 (OBV +5), then a 14-candle slide of 1 per candle on volume 0.1 (OBV +3.6), then one up candle of `lastClose` on `lastVolume`. With lookback 20 the range is exactly these 21 candles.
const series = (lastClose: number, lastVolume: number): Candle[] => {
  const out: Candle[] = [candle(0, 100, 100, 1)];
  let prev = 100;
  for (let k = 1; k <= 5; k++) out.push(candle(k, prev, (prev += 2), 1));
  for (let k = 6; k <= 19; k++) out.push(candle(k, prev, (prev -= 1), 0.1));
  out.push(candle(20, prev, lastClose, lastVolume));
  return out;
};

const cfg = { lookback: 20 };

// Independent float oracle: the harness formulas that selected the rule (hyp.mjs obv, chopOf), written without the plugin's helpers.
const oracle = (b: readonly Candle[], n: number) => {
  const c = b.map((x) => Number(x.close));
  const h = b.map((x) => Number(x.high));
  const l = b.map((x) => Number(x.low));
  const v = b.map((x) => Number(x.volume));
  const o = [0];
  for (let j = 1; j < b.length; j++)
    o.push(o[j - 1]! + (c[j]! > c[j - 1]! ? v[j]! : c[j]! < c[j - 1]! ? -v[j]! : 0));
  const i = b.length - 1;
  const oh = Math.max(...o.slice(i - n, i));
  const ch = Math.max(...c.slice(i - n, i));
  let s = 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - 13; j <= i; j++) {
    s += Math.max(h[j]! - l[j]!, Math.abs(h[j]! - c[j - 1]!), Math.abs(l[j]! - c[j - 1]!));
    hi = Math.max(hi, h[j]!);
    lo = Math.min(lo, l[j]!);
  }
  const chop = (100 * Math.log10(s / (hi - lo))) / Math.log10(14);
  return { obvNewHigh: o[i]! > oh, priceUnder: c[i]! < ch, chop };
};

describe('obvLeadReading', () => {
  it('fires when OBV makes a new high while the close is still under its high in a directional market', () => {
    const b = series(97, 10);
    const r = obvLeadReading(b, cfg)!;
    const o = oracle(b, 20);
    expect(o).toMatchObject({ obvNewHigh: true, priceUnder: true });
    expect(o.chop).toBeLessThan(50);
    expect(r.fired).toBe(true);
    expect(r.obvNewHigh).toBe(true);
    // Prior close high 110 over a close of 97.
    expect(r.priceToHigh.toFixed(6)).toBe((110 / 97 - 1).toFixed(6));
    expect(r.choppiness.toNumber()).toBeCloseTo(o.chop, 9);
  });

  it('does not fire while OBV is under its prior high', () => {
    // OBV 3.6 + 1.3 = 4.9 against the prior high of 5.
    const r = obvLeadReading(series(97, 1.3), cfg)!;
    expect(r.obvNewHigh).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('treats an OBV equal to its prior high as no new high', () => {
    // OBV 3.6 + 1.4 = 5.0, exactly the prior high: the comparison is strict.
    expect(obvLeadReading(series(97, 1.4), cfg)!.obvNewHigh).toBe(false);
  });

  it('does not fire once price has reached its own high, where OBV no longer leads', () => {
    const r = obvLeadReading(series(110, 10), cfg)!;
    expect(r.obvNewHigh).toBe(true);
    expect(r.priceToHigh.isZero()).toBe(true);
    expect(r.fired).toBe(false);
    // Above the prior high the distance goes negative: the judged close is not part of its own range.
    expect(obvLeadReading(series(111, 10), cfg)!.priceToHigh.toFixed(6)).toBe(
      (110 / 111 - 1).toFixed(6),
    );
  });

  it('does not fire when the market is choppier than maxChoppiness', () => {
    const r = obvLeadReading(series(97, 10), { ...cfg, maxChoppiness: '1' })!;
    expect(r.obvNewHigh).toBe(true);
    expect(r.priceToHigh.gt(0)).toBe(true);
    expect(r.fired).toBe(false);
  });

  it('leaves OBV unchanged on an unchanged close', () => {
    // After the 13.6 high, an unchanged close on volume 1000 must add nothing, so a later rise on a sliver of volume still makes a new high. Subtracting the 1000 would bury it.
    const b = [...series(97, 10), candle(21, 97, 97, 1000), candle(22, 97, 97.5, 0.0001)];
    expect(obvLeadReading(b.slice(0, 22), cfg)!.obvNewHigh).toBe(false);
    expect(obvLeadReading(b, cfg)!.obvNewHigh).toBe(true);
  });

  it('returns null while the window is shorter than lookback plus one', () => {
    expect(obvLeadReading(series(97, 10).slice(1), cfg)).toBeNull();
  });

  // A 300-candle walk with volume tied to direction, judged at every candle: the plugin and the oracle must agree on each leg.
  it('agrees with the float oracle on every candle of a seeded walk', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const b: Candle[] = [candle(0, 100, 100, 1)];
    let prev = 100;
    for (let i = 1; i < 300; i++) {
      const next = Math.round((prev + (rnd() - 0.5) * 2) * 100) / 100;
      b.push(candle(i, prev, next, Math.round((0.5 + rnd() * (next > prev ? 3 : 1)) * 100) / 100));
      prev = next;
    }
    let fired = 0;
    for (let i = 21; i <= b.length; i++) {
      const w = b.slice(0, i);
      const r = obvLeadReading(w, cfg)!;
      const o = oracle(w, 20);
      expect(r.obvNewHigh).toBe(o.obvNewHigh);
      expect(r.priceToHigh.gt(0)).toBe(o.priceUnder);
      expect(r.fired).toBe(o.obvNewHigh && o.priceUnder && o.chop < 50);
      if (r.fired) fired++;
    }
    // The walk must exercise the firing branch, or the agreement above proves nothing about it.
    expect(fired).toBeGreaterThan(0);
  });
});

describe('obvLeadSettings', () => {
  it('defaults to the researched 168-candle range and choppiness 50', () => {
    expect(obvLeadSettings(undefined)).toMatchObject({ lookback: 168 });
    expect(obvLeadSettings(undefined).maxChoppiness.toString()).toBe('50');
  });

  it('falls back on a lookback shorter than the choppiness window or a non-positive ceiling', () => {
    const s = obvLeadSettings({ lookback: 13, maxChoppiness: '-1' });
    expect(s.lookback).toBe(168);
    expect(s.maxChoppiness.toString()).toBe('50');
    expect(obvLeadSettings({ lookback: 14 }).lookback).toBe(14);
  });

  it('needs the lookback plus the judged candle', () => {
    expect(obvLeadNeed(undefined)).toBe(169);
    expect(obvLeadNeed({ lookback: 20 })).toBe(21);
  });
});
