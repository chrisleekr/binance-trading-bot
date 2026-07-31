import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { windowReachesLastClosedBar } from '../../src/backtest/backtest-runner.js';

const HOUR = 3_600_000;
// A clock far past every test window, so historical ranges are bounded by toMs,
// not by the last-closed-bar. Near-now cases override nowMs explicitly.
const FAR_FUTURE = 100_000 * HOUR;

function candle(openTimeMs: number): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR - 1,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    isClosed: true,
  };
}

/** `n` hourly candles starting at `startMs`. */
function series(n: number, startMs = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(startMs + i * HOUR));
}

describe('windowReachesLastClosedBar', () => {
  it('caches a complete historical window (opens 0..99h over toMs=100h)', () => {
    // toMs is exclusive: the last expected bar opens at 99h, and series(100)
    // reaches it. A naive floor(toMs) would demand a 100h bar and reject this.
    expect(windowReachesLastClosedBar(series(100), 0, 100 * HOUR, FAR_FUTURE, HOUR)).toBe(true);
  });

  it('refuses a tail-truncated window (backfill stopped at 49h of a 100h window)', () => {
    expect(windowReachesLastClosedBar(series(50), 0, 100 * HOUR, FAR_FUTURE, HOUR)).toBe(false);
  });

  it('tolerates an interior hole when the tail still reaches the window end', () => {
    // Genuine absence mid-window (illiquid/halt): after a normal backfill these
    // are unfetchable, so caching is correct — refusing would re-backfill every
    // trial. The tail (99h) is present, so the window caches.
    const withHole = series(100).filter((c) => c.openTimeMs !== 50 * HOUR);
    expect(windowReachesLastClosedBar(withHole, 0, 100 * HOUR, FAR_FUTURE, HOUR)).toBe(true);
  });

  it('tolerates a healthy near-now window whose only gap is the forming tail', () => {
    // now sits mid-way through the bar opening at 100h (closes 101h), so the
    // last closed bar opens at 99h. Window asks up to 101h but the 100h bar is
    // still forming and never stored; the present 0..99h must still cache.
    const now = 100 * HOUR + 30 * 60_000;
    expect(windowReachesLastClosedBar(series(100), 0, 101 * HOUR, now, HOUR)).toBe(true);
  });

  it('refuses a near-now window missing a closed bar before the forming tail', () => {
    // Same clock, but the 99h closed bar is absent — a real shortfall, not the
    // forming tail. Must not cache so a later trial can refetch.
    const now = 100 * HOUR + 30 * 60_000;
    expect(windowReachesLastClosedBar(series(99), 0, 101 * HOUR, now, HOUR)).toBe(false);
  });

  it('refuses an empty window', () => {
    expect(windowReachesLastClosedBar([], 0, 100 * HOUR, FAR_FUTURE, HOUR)).toBe(false);
  });

  it('ignores warm-up candles loaded before the window when judging the tail', () => {
    // Warm-up history before fromMs plus a complete in-window tail to 99h.
    const withWarmup = series(300, -200 * HOUR);
    expect(windowReachesLastClosedBar(withWarmup, -200 * HOUR, 100 * HOUR, FAR_FUTURE, HOUR)).toBe(
      true,
    );
  });

  it('caches freely when the window holds no expected closed bar yet', () => {
    // now precedes the window: the last closed bar is before the window start,
    // so there is nothing to require.
    const now = 5 * HOUR;
    expect(windowReachesLastClosedBar([], 100 * HOUR, 200 * HOUR, now, HOUR)).toBe(true);
  });

  it('handles an unaligned toMs (last expected bar opens at the slot below it)', () => {
    // toMs at 100h30m → last expected open is 100h; series to 100h reaches it.
    expect(
      windowReachesLastClosedBar(series(101), 0, 100 * HOUR + 30 * 60_000, FAR_FUTURE, HOUR),
    ).toBe(true);
    // ...but series only to 99h does not.
    expect(
      windowReachesLastClosedBar(series(100), 0, 100 * HOUR + 30 * 60_000, FAR_FUTURE, HOUR),
    ).toBe(false);
  });
});
