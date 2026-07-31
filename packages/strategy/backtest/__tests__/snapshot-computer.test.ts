import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import { createSnapshotComputer } from '../src/snapshot-computer.js';
import { computeIndicatorSnapshot } from '../src/offline-market.js';

// Deterministic candle series (no Math.random — keep the test reproducible).
function gen(n: number): Candle[] {
  let price = 100;
  let s = 3;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const drift = (s / 0x7fffffff - 0.5) * 2;
    const open = price;
    price = Math.max(1, price * (1 + drift * 0.02));
    out.push({
      openTimeMs: i * 300000,
      closeTimeMs: i * 300000 + 299999,
      open: open.toFixed(2),
      high: (Math.max(open, price) * 1.005).toFixed(2),
      low: (Math.min(open, price) * 0.995).toFixed(2),
      close: price.toFixed(2),
      volume: '1000',
      isClosed: true,
    });
  }
  return out;
}

describe('createSnapshotComputer', () => {
  it('matches the full-window re-seed snapshot at every step (no slide)', () => {
    // While the window only grows, carrying state forward (seed once, then fold
    // the new candle) yields the byte-identical value the old per-tick re-seed
    // produced — the property that keeps the golden fixture unchanged.
    const candles = gen(120);
    const comp = createSnapshotComputer();
    for (let n = 1; n <= candles.length; n++) {
      const window = candles.slice(0, n);
      const carried = comp.step('BTCUSDT|5m', window);
      const reseed = computeIndicatorSnapshot(window);
      expect(carried).toEqual(reseed);
    }
    // 120 iterations each re-seed a full-window Decimal snapshot (O(n^2) over the
    // growing window); generous timeout so a loaded CI runner cannot flake it,
    // matching the scan test below (the default 5s is tight when every package's
    // vitest runs in parallel under turbo with v8 coverage).
  }, 20_000);

  it('returns null until the window reaches each indicator minimum', () => {
    const candles = gen(20);
    const comp = createSnapshotComputer();
    // 10 candles: too short for RSI(14) (needs 15) and SMA/EMA(20) (need 20).
    const short = comp.step('BTCUSDT|5m', candles.slice(0, 10));
    expect(short?.sma20).toBeNull();
    expect(short?.ema20).toBeNull();
    expect(short?.rsi14).toBeNull();
    // 16 candles: RSI(14) ready, SMA/EMA(20) still null.
    const mid = comp.step('BTCUSDT|5m', candles.slice(0, 16));
    expect(mid?.rsi14).not.toBeNull();
    expect(mid?.sma20).toBeNull();
  });

  it('does not double-fold an unchanged interval (aux-window caching)', () => {
    // An aux (e.g. daily) window unchanged across intra-interval ticks must
    // return the cached snapshot, not fold its last candle again — else the
    // carried indicators would drift from the live value.
    const candles = gen(40);
    const comp = createSnapshotComputer();
    const window = candles.slice(0, 30);
    const first = comp.step('BTCUSDT|1d', window);
    const second = comp.step('BTCUSDT|1d', window); // same last candle
    const third = comp.step('BTCUSDT|1d', window); // still same
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Now advance the interval by one candle; the value must equal a fresh
    // re-seed, proving the earlier repeats did not corrupt the carried state.
    const advanced = comp.step('BTCUSDT|1d', candles.slice(0, 31));
    expect(advanced).toEqual(computeIndicatorSnapshot(candles.slice(0, 31)));
  });

  it('keeps history past a tail drop (the carry-forward that re-baselines long runs)', () => {
    // The whole point of carrying state: the computer never truncates, so its
    // ema20/rsi14 keep ALL folded history. The old per-tick re-seed, by contrast,
    // saw only the engine's capped (slid) window — dropping the tail. Proven here
    // without a 1000-candle run: the carried value differs from a tail-truncated
    // re-seed and equals a full-history re-seed. sma20 is a true sliding ring, so
    // it does NOT diverge — only the recursive ema/rsi do.
    const candles = gen(60);
    const comp = createSnapshotComputer();
    for (let n = 1; n <= candles.length; n++) comp.step('K|5m', candles.slice(0, n));
    const carried = comp.step('K|5m', candles);
    const truncated = computeIndicatorSnapshot(candles.slice(-30)); // the "dropped tail"
    expect(carried?.ema20).not.toEqual(truncated?.ema20);
    expect(carried?.rsi14).not.toEqual(truncated?.rsi14);
    // And the carried value equals a full-history re-seed (the documented "matches live").
    expect(carried).toEqual(computeIndicatorSnapshot(candles));
  });

  it('folds lowestLow/highestHigh byte-identically to a full scan as the window slides', () => {
    // The carried EMA/RSI diverge from a re-seed once the window slides (they keep
    // all history); lowestLow/highestHigh do NOT — they are defined over the
    // current window only, so the monotonic deque must equal a fresh full scan of
    // that exact window at every step. Mirror the engine: push, then drop the
    // front past a cap, then snapshot the capped window.
    const candles = gen(200);
    const CAP = 20;
    const comp = createSnapshotComputer();
    const window: Candle[] = [];
    for (const c of candles) {
      window.push(c);
      if (window.length > CAP) window.shift();
      const snap = comp.step('K|5m', window);
      const oracle = computeIndicatorSnapshot(window); // lowestLow/highestHigh = full scan
      expect(snap?.lowestLow).toBe(oracle?.lowestLow);
      expect(snap?.highestHigh).toBe(oracle?.highestHigh);
    }
  });

  it('tracks the rolling extremum under a monotonic ramp (deque worst case)', () => {
    // A strictly rising low keeps the window min pinned at the front, so it is
    // evicted every tick once the window fills — the adversarial case for the min
    // deque (and the head-index reclaim). A strictly falling low then keeps the
    // max pinned. Both must still equal a full scan of the capped window.
    const mk = (i: number, low: number, high: number): Candle => ({
      openTimeMs: i * 300000,
      closeTimeMs: i * 300000 + 299999,
      open: low.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: low.toFixed(2),
      volume: '1000',
      isClosed: true,
    });
    const ramp: Candle[] = [];
    for (let i = 0; i < 60; i++) ramp.push(mk(i, 100 + i, 200 + i)); // rising
    for (let i = 60; i < 120; i++) ramp.push(mk(i, 300 - i, 100 - i + 60)); // falling
    const CAP = 15;
    const comp = createSnapshotComputer();
    const window: Candle[] = [];
    for (const c of ramp) {
      window.push(c);
      if (window.length > CAP) window.shift();
      const snap = comp.step('R|5m', window);
      const oracle = computeIndicatorSnapshot(window);
      expect(snap?.lowestLow).toBe(oracle?.lowestLow);
      expect(snap?.highestHigh).toBe(oracle?.highestHigh);
    }
  });

  it('stays byte-identical across a head-index reclaim (large cap, long ramp)', () => {
    // A strictly rising low evicts the front every tick, so the deque's dead
    // prefix grows until the head-index compaction reclaims it. A cap above the
    // reclaim threshold (32) forces that reclaim mid-run; parity to a full scan
    // must hold on both sides of it.
    const mk = (i: number, low: number, high: number): Candle => ({
      openTimeMs: i * 300000,
      closeTimeMs: i * 300000 + 299999,
      open: low.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: low.toFixed(2),
      volume: '1000',
      isClosed: true,
    });
    const ramp: Candle[] = [];
    for (let i = 0; i < 300; i++) ramp.push(mk(i, 100 + i, 500 - i)); // rising low, falling high
    const CAP = 80;
    const comp = createSnapshotComputer();
    const window: Candle[] = [];
    for (const c of ramp) {
      window.push(c);
      if (window.length > CAP) window.shift();
      const snap = comp.step('C|5m', window);
      const oracle = computeIndicatorSnapshot(window);
      expect(snap?.lowestLow).toBe(oracle?.lowestLow);
      expect(snap?.highestHigh).toBe(oracle?.highestHigh);
    }
    // 300 iterations each re-run a full-scan Decimal oracle over an 80-candle
    // window; generous timeout so a loaded CI runner cannot flake it (the default
    // 5s is tight when every package's vitest runs in parallel under turbo).
  }, 20_000);

  it('handles equal-value plateaus across a slide (the tie branch)', () => {
    // Real candles sit on flat-price plateaus where many candles share a low/high.
    // The deque pops the older equal entry and keeps the newer (the `>=`/`<=` tie
    // rule), which matters once the plateau is longer than the window: the value
    // must survive the slide. Compare to the full scan at every step.
    const flat = (i: number, low: string, high: string): Candle => ({
      openTimeMs: i * 300000,
      closeTimeMs: i * 300000 + 299999,
      open: low,
      high,
      low,
      close: low,
      volume: '1000',
      isClosed: true,
    });
    const series: Candle[] = [];
    let i = 0;
    for (; i < 30; i++) series.push(flat(i, '50.00', '60.00')); // plateau longer than CAP
    for (; i < 45; i++) series.push(flat(i, '55.00', '58.00')); // step up off the plateau
    for (; i < 60; i++) series.push(flat(i, '52.00', '70.00')); // new high, lower low
    const CAP = 10;
    const comp = createSnapshotComputer();
    const window: Candle[] = [];
    for (const c of series) {
      window.push(c);
      if (window.length > CAP) window.shift();
      const snap = comp.step('P|5m', window);
      const oracle = computeIndicatorSnapshot(window);
      expect(snap?.lowestLow).toBe(oracle?.lowestLow);
      expect(snap?.highestHigh).toBe(oracle?.highestHigh);
    }
  });

  it('keeps separate state per (symbol, interval) key', () => {
    const a = gen(60);
    const b = gen(60).map((c) => ({ ...c, close: (Number(c.close) * 1.5).toFixed(2) }));
    const comp = createSnapshotComputer();
    for (let n = 30; n <= 60; n++) {
      comp.step('AAA|5m', a.slice(0, n));
      comp.step('BBB|5m', b.slice(0, n));
    }
    // Each key tracks its own series, byte-identical to its own re-seed.
    expect(comp.step('AAA|5m', a)).toEqual(computeIndicatorSnapshot(a));
    expect(comp.step('BBB|5m', b)).toEqual(computeIndicatorSnapshot(b));
  });
});
