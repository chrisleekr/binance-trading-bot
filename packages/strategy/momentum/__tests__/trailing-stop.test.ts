import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import type { Candle } from '@app/strategy-core';

import { atrTrailingStopPrice } from '../src/trailing-stop.js';
import { MomentumConfigSchema, type MomentumConfig } from '../src/index.js';

const mkCandles = (closes: readonly string[]): Candle[] =>
  closes.map((c, i) => ({
    openTimeMs: i * 3_600_000,
    closeTimeMs: (i + 1) * 3_600_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: '1',
    isClosed: true,
  }));

const cfg = (over: Record<string, unknown> = {}): MomentumConfig =>
  MomentumConfigSchema.parse({
    candleInterval: '1h',
    entrySizing: { mode: 'fixed', amount: '140' },
    ema: { fast: 2, slow: 3 },
    ...over,
  });

// Closes with high=low=close, so ATR reduces to the mean absolute close-to-close
// move: TRs 2,1,3,1,2 -> Wilder ATR(3) ≈ 1.7778.
const CANDLES = mkCandles(['10', '12', '11', '14', '13', '15']);
const HIGH = new Decimal('15');

describe('atrTrailingStopPrice', () => {
  it('returns null when the ATR mode is off or absent', () => {
    expect(atrTrailingStopPrice(cfg(), CANDLES, HIGH)).toBeNull();
    expect(
      atrTrailingStopPrice(cfg({ atrTrailingStop: { enabled: false } }), CANDLES, HIGH),
    ).toBeNull();
  });

  it('returns effectiveHigh minus multiple*ATR when enabled and computable', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '2' } });
    const expected = HIGH.minus(new Decimal('2').times(atr(CANDLES, 3)));
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)?.toString()).toBe(expected.toString());
  });

  it('returns null when the window is shorter than period+1 (caller falls back to fixed)', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 10 } });
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
  });

  it('returns null when the resulting stop is non-positive', () => {
    const config = cfg({ atrTrailingStop: { enabled: true, period: 3, multiple: '1000' } });
    expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
  });

  it('coerces unparsed period and multiple to their defaults', () => {
    const expected3 = HIGH.minus(new Decimal('3').times(atr(CANDLES, 3))).toString();
    // multiple omitted / malformed / non-positive -> 3.
    for (const multiple of [undefined, 'abc', '0']) {
      const config = {
        ...cfg(),
        atrTrailingStop: {
          enabled: true,
          period: 3,
          ...(multiple === undefined ? {} : { multiple }),
        },
      } as unknown as MomentumConfig;
      expect(atrTrailingStopPrice(config, CANDLES, HIGH)?.toString()).toBe(expected3);
    }
    // period omitted (-> 14), finite-but-<2 (-> 14), or unparseable NaN (-> 14):
    // the 6-candle window is too short for the default 14.
    for (const period of [undefined, 1, 'abc']) {
      const config = {
        ...cfg(),
        atrTrailingStop: {
          enabled: true,
          multiple: '2',
          ...(period === undefined ? {} : { period }),
        },
      } as unknown as MomentumConfig;
      expect(atrTrailingStopPrice(config, CANDLES, HIGH)).toBeNull();
    }
  });
});
