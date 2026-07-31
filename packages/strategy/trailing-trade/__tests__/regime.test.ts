import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@app/strategy-core';
import { classifyRegime, type RegimeParams } from '../src/branches/regime.js';

// Daily closed candles, oldest first. `forming` appends one still-open bar that
// the classifier must ignore (closes-only confirmation).
const dayCandles = (closes: string[], forming?: string) => {
  const rows = closes.map((c) => ({
    open: c,
    high: c,
    low: c,
    close: c,
    isClosed: true,
  }));
  if (forming !== undefined) {
    rows.push({ open: forming, high: forming, low: forming, close: forming, isClosed: false });
  }
  return rows;
};

const mkt = (closes: string[], forming?: string): MarketSnapshot =>
  ({
    symbol: 'BTCUSDT',
    currentPrice: '100',
    candlesByInterval: { '1d': dayCandles(closes, forming) },
  }) as unknown as MarketSnapshot;

const params = (over?: Partial<RegimeParams>): RegimeParams => ({
  ma: 'sma',
  period: 3,
  confirmBars: 2,
  ...over,
});

describe('classifyRegime', () => {
  it('is unavailable when the daily interval is absent', () => {
    const market = { candlesByInterval: {} } as unknown as MarketSnapshot;
    expect(classifyRegime(market, params()).regime).toBe('unavailable');
  });

  it('is unavailable until the MA lookback window exists', () => {
    const out = classifyRegime(mkt(['100', '100']), params({ period: 3 }));
    expect(out).toMatchObject({ regime: 'unavailable', context: { have: 2, need: 3 } });
  });

  it('is unavailable when fewer candles than confirmBars exist', () => {
    const out = classifyRegime(mkt(['100', '100', '100']), params({ period: 2, confirmBars: 5 }));
    expect(out).toMatchObject({ regime: 'unavailable', context: { need: 5 } });
  });

  it('confirms bear when every confirm-bar close is strictly below the MA (sma)', () => {
    // sma(last 3) = (100 + 90 + 88) / 3 = 92.67; last 2 closes 90, 88 both below.
    expect(classifyRegime(mkt(['100', '100', '100', '90', '88']), params()).regime).toBe('bear');
  });

  it('confirms bull when every confirm-bar close is strictly above the MA (sma)', () => {
    // sma(last 3) = (100 + 110 + 112) / 3 = 107.33; last 2 closes 110, 112 both above.
    expect(classifyRegime(mkt(['100', '100', '100', '110', '112']), params()).regime).toBe('bull');
  });

  it('is neutral when the confirmation window straddles the MA', () => {
    // sma(last 3) = (100 + 90 + 110) / 3 = 100; last 2 = [90, 110]: one below, one above.
    expect(classifyRegime(mkt(['100', '100', '100', '90', '110']), params()).regime).toBe(
      'neutral',
    );
  });

  it('is neutral when a confirmation close sits exactly on the MA (strict comparison)', () => {
    // sma(last 3) = (90 + 110 + 100) / 3 = 100; last 1 close = 100, equal — neither above nor below.
    expect(classifyRegime(mkt(['90', '110', '100']), params({ confirmBars: 1 })).regime).toBe(
      'neutral',
    );
  });

  it('supports an ema regime line', () => {
    expect(classifyRegime(mkt(['200', '200', '200', '1', '1']), params({ ma: 'ema' })).regime).toBe(
      'bear',
    );
  });

  it('ignores a still-forming daily candle (closes-only)', () => {
    // 5 closed closes all 100 → bull window absent (all equal → neutral); the
    // forming bar (close 1) must NOT pull the recent window to bear.
    const out = classifyRegime(mkt(['100', '100', '100', '100', '100'], '1'), params());
    expect(out.regime).toBe('neutral'); // all closes equal the flat MA
  });

  it('fails safe to unavailable on a malformed confirmation close', () => {
    const out = classifyRegime(mkt(['100', '100', '100', 'bad', '88']), params());
    expect(out).toMatchObject({ regime: 'unavailable', context: { missing: 'close' } });
  });

  it('fails safe to unavailable when the MA cannot be computed (malformed older close)', () => {
    const out = classifyRegime(mkt(['bad', '100', '100', '90', '88']), params({ period: 5 }));
    expect(out).toMatchObject({ regime: 'unavailable', context: { missing: 'compute' } });
  });
});
