// deriveRegimeExit — display-only mirror of the worker's evaluateRegimeExit.

import { describe, expect, it } from 'vitest';

import {
  deriveBullHold,
  deriveRegimeExit,
  REGIME_FRAMES,
} from '../src/features/symbol/strategies/trailing-trade/regime-status.js';

import type { CandleList } from '@app/contracts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 5); // a UTC midnight, so day boundaries line up

/**
 * Build daily candles oldest-first ending at `NOW`. The last entry opens at
 * NOW - DAY and closes exactly at NOW, so it is closed relative to `NOW`.
 * Pass `forming: true` to append one extra still-open bar opening at NOW.
 */
const candles = (closes: readonly number[], forming = false): CandleList => {
  const rows = closes.map((c, i) => {
    const openMs = NOW - (closes.length - i) * DAY;
    return {
      time: new Date(openMs).toISOString(),
      open: String(c),
      high: String(c),
      low: String(c),
      close: String(c),
      volume: '0',
    };
  });
  if (forming) {
    rows.push({
      time: new Date(NOW).toISOString(),
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      volume: '0',
    });
  }
  return rows;
};

// Map the legacy `{ enabled, ma, period, confirmBars }` shape the tests author
// onto the unified `regime` block (`onBear.exitToCash` is the cash-rotation
// toggle).
const cfg = (re: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (re === undefined) return {};
  const { enabled, ...rest } = re;
  return { regime: { ...rest, onBear: { exitToCash: enabled === true } } };
};

describe('deriveRegimeExit', () => {
  it('is disabled when regimeExit is absent or off', () => {
    expect(deriveRegimeExit(cfg(undefined), candles([1, 2, 3]), NOW).kind).toBe('disabled');
    expect(deriveRegimeExit(cfg({ enabled: false }), candles([1, 2, 3]), NOW).kind).toBe(
      'disabled',
    );
    expect(deriveRegimeExit(null, candles([1, 2, 3]), NOW).kind).toBe('disabled');
  });

  it('is unavailable until there are enough closed daily candles', () => {
    const config = cfg({ enabled: true, ma: 'sma', period: 5, confirmBars: 2 });
    const status = deriveRegimeExit(config, candles([100, 100, 100]), NOW);
    expect(status).toEqual({ kind: 'unavailable', have: 3, need: 5 });
  });

  it('reports bear when every confirm bar closes below the MA (sma)', () => {
    const config = cfg({ enabled: true, ma: 'sma', period: 5, confirmBars: 2 });
    // last 5 = [100,100,100,50,40] → mean 78; recent 2 = [50,40] both < 78.
    const status = deriveRegimeExit(config, candles([100, 100, 100, 100, 50, 40]), NOW);
    expect(status.kind).toBe('bear');
    if (status.kind !== 'bear') throw new Error('expected bear');
    expect(status.below).toBe(2);
    expect(status.confirmBars).toBe(2);
    expect(status.ma).toBeCloseTo(78, 6);
  });

  it('counts a partial confirmation as watching (the countdown)', () => {
    const config = cfg({ enabled: true, ma: 'sma', period: 5, confirmBars: 2 });
    // last 5 = [100,100,100,40,100] → mean 88; recent 2 = [40,100] → one below.
    const status = deriveRegimeExit(config, candles([100, 100, 100, 100, 40, 100]), NOW);
    expect(status.kind).toBe('watching');
    if (status.kind !== 'watching') throw new Error('expected watching');
    expect(status.below).toBe(1);
  });

  it('reports a healthy watch (below 0) when recent closes hold above the MA', () => {
    const config = cfg({ enabled: true, ma: 'sma', period: 3, confirmBars: 2 });
    const status = deriveRegimeExit(config, candles([100, 100, 100, 100]), NOW);
    expect(status.kind).toBe('watching');
    if (status.kind !== 'watching') throw new Error('expected watching');
    expect(status.below).toBe(0);
  });

  it('drops the still-forming daily bar from the confirmation', () => {
    const config = cfg({ enabled: true, ma: 'sma', period: 5, confirmBars: 2 });
    // 5 closed closes all 100 → below 0. The forming bar (close 1) must NOT
    // count, or it would pull the recent window below the line.
    const status = deriveRegimeExit(config, candles([100, 100, 100, 100, 100], true), NOW);
    expect(status.kind).toBe('watching');
    if (status.kind !== 'watching') throw new Error('expected watching');
    expect(status.below).toBe(0);
  });

  it('computes an EMA line that converges between the window min and max', () => {
    const config = cfg({ enabled: true, ma: 'ema', period: 3, confirmBars: 1 });
    const status = deriveRegimeExit(config, candles([10, 20, 30, 40, 50]), NOW);
    expect(status.kind).toBe('watching');
    if (status.kind !== 'watching') throw new Error('expected watching');
    expect(status.maType).toBe('ema');
    expect(status.ma).toBeGreaterThan(10);
    expect(status.ma).toBeLessThan(50);
    expect(status.below).toBe(0); // last close 50 is above the EMA
  });

  it('reaches bear through the EMA path and pins the EMA value', () => {
    // EMA seed = SMA(10,20,30) = 20; step 5 -> (5-20)*0.5+20 = 12.5;
    // step 4 -> (4-12.5)*0.5+12.5 = 8.25. Recent 2 = [5,4], both < 8.25 -> bear.
    const config = cfg({ enabled: true, ma: 'ema', period: 3, confirmBars: 2 });
    const status = deriveRegimeExit(config, candles([10, 20, 30, 5, 4]), NOW);
    expect(status.kind).toBe('bear');
    if (status.kind !== 'bear') throw new Error('expected bear');
    expect(status.maType).toBe('ema');
    expect(status.ma).toBeCloseTo(8.25, 6);
    expect(status.below).toBe(2);
  });

  it('clamps a stored 0 period/confirmBars to >= 1 instead of a false bear', () => {
    // Raw stored config can hold 0 (the web bypasses schema validation). A 0
    // confirmBars must not slice an empty window and report bear; a 0 period must
    // not NaN the moving average. Both clamp to 1.
    const config = cfg({ enabled: true, ma: 'sma', period: 0, confirmBars: 0 });
    const status = deriveRegimeExit(config, candles([10, 20, 30, 40, 50]), NOW);
    expect(status.kind).toBe('watching'); // MA = last close 50; recent [50] not below
    if (status.kind !== 'watching') throw new Error('expected watching');
    expect(status.below).toBe(0);
  });
});

describe('REGIME_FRAMES', () => {
  it('requests several multiples of the period, capped, for EMA warm-up', () => {
    expect(REGIME_FRAMES(30, 3)).toBe(150); // 30 * 5
    expect(REGIME_FRAMES(200, 3)).toBe(500); // capped at the worker's daily ring
    expect(REGIME_FRAMES(2, 3)).toBe(10); // floor: period + confirmBars + 5
  });
});

// Map the test shape onto the unified `regime.onBull.hold` block.
const bullCfg = (
  h:
    | { enabled?: boolean; ma?: string; period?: number; confirmBars?: number; room?: string }
    | undefined,
): Record<string, unknown> => {
  if (h === undefined) return {};
  const { enabled, room = 'normal', ma = 'sma', period = 3, confirmBars = 2 } = h;
  return {
    regime: { ma, period, confirmBars, onBull: { hold: { enabled: enabled === true, room } } },
  };
};

describe('deriveBullHold', () => {
  it('is disabled when bull hold is absent or off', () => {
    expect(deriveBullHold({}, candles([10, 20, 30]), NOW)).toEqual({ kind: 'disabled' });
    expect(deriveBullHold(bullCfg({ enabled: false }), candles([10, 20, 30]), NOW)).toEqual({
      kind: 'disabled',
    });
  });

  it('is unavailable until the daily window fills (worker uses the normal trail too)', () => {
    const status = deriveBullHold(
      bullCfg({ enabled: true, period: 3, confirmBars: 2 }),
      candles([10, 20]),
      NOW,
    );
    expect(status).toMatchObject({ kind: 'unavailable', have: 2, need: 3 });
  });

  it('is holding when the last confirmBars daily closes are all above the line', () => {
    // sma(last 3) = (10+30+40)/3 = 26.67; last two closes 30, 40 both above.
    const status = deriveBullHold(
      bullCfg({ enabled: true, ma: 'sma', period: 3, confirmBars: 2, room: 'loose' }),
      candles([10, 10, 10, 30, 40]),
      NOW,
    );
    expect(status.kind).toBe('holding');
    if (status.kind !== 'holding') throw new Error('expected holding');
    expect(status.room).toBe('loose');
    expect(status.confirmBars).toBe(2);
  });

  it('is inactive when not every confirmation close is above the line', () => {
    // sma(last 3) = (10+40+20)/3 = 23.33; latest close 20 is below it.
    const status = deriveBullHold(
      bullCfg({ enabled: true, ma: 'sma', period: 3, confirmBars: 2 }),
      candles([10, 10, 10, 40, 20]),
      NOW,
    );
    expect(status.kind).toBe('inactive');
    if (status.kind !== 'inactive') throw new Error('expected inactive');
    expect(status.above).toBe(1);
  });

  it('falls back to room=normal on an unrecognised stored room value', () => {
    const status = deriveBullHold(
      bullCfg({ enabled: true, ma: 'sma', period: 3, confirmBars: 2, room: 'bogus' }),
      candles([10, 10, 10, 30, 40]),
      NOW,
    );
    expect(status.kind).toBe('holding');
    if (status.kind !== 'holding') throw new Error('expected holding');
    expect(status.room).toBe('normal');
  });

  it('ignores the still-forming daily bar (closes-only, mirrors the worker)', () => {
    const status = deriveBullHold(
      bullCfg({ enabled: true, ma: 'sma', period: 3, confirmBars: 2 }),
      candles([10, 10, 10, 30, 40], true),
      NOW,
    );
    expect(status.kind).toBe('holding');
  });
});
