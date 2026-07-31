// First-entry exposure scalar from the daily regime (opt-in). Disabled (default)
// and an uncomputable regime fail OPEN to 1 (untouched budget); a confirmed bear
// returns 0 (sit in cash), neutral returns the configured fraction.

import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@app/strategy-core';
import { regimeExposure } from '../src/branches/regime-exposure.js';
import { TTConfigSchema, type TTConfig } from '../src/index.js';

const dayCandles = (closes: string[]) =>
  closes.map((close, i) => ({
    openTimeMs: i * 86_400_000,
    closeTimeMs: i * 86_400_000 + 86_399_999,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  }));

const mkt = (closes: string[]): MarketSnapshot =>
  ({
    symbol: 'BTCUSDT',
    currentPrice: '100',
    candlesByInterval: { '1d': dayCandles(closes) },
  }) as unknown as MarketSnapshot;

// sma over period 3, confirmBars 2.
const cfg = (exposure?: { enabled: boolean; neutralScalar?: string }): TTConfig =>
  ({
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      ...(exposure
        ? {
            exposure: { enabled: exposure.enabled, neutralScalar: exposure.neutralScalar ?? '0.5' },
          }
        : {}),
    },
  }) as unknown as TTConfig;

// sma([1,5,6]) = 4, last 2 closes [5,6] both above → bull.
const BULL = ['1', '5', '6'];
// sma([6,2,1]) = 3, last 2 closes [2,1] both below → bear.
const BEAR = ['6', '2', '1'];
// sma([6,1,5]) = 4, last 2 closes [1,5] mixed → neutral.
const NEUTRAL = ['6', '1', '5'];

describe('regimeExposure', () => {
  it('returns 1 and "disabled" when the feature is off', () => {
    const out = regimeExposure(cfg({ enabled: false }), mkt(BULL));
    expect(out.regime).toBe('disabled');
    expect(out.scalar.eq(1)).toBe(true);
  });

  it('returns "disabled" for a config that predates the field (no regime / no exposure)', () => {
    expect(regimeExposure({} as unknown as TTConfig, mkt(BULL)).regime).toBe('disabled');
    expect(regimeExposure(cfg(undefined), mkt(BULL)).regime).toBe('disabled');
  });

  it('returns full size (1) on a confirmed bull', () => {
    const out = regimeExposure(cfg({ enabled: true }), mkt(BULL));
    expect(out.regime).toBe('bull');
    expect(out.scalar.eq(1)).toBe(true);
  });

  it('returns the neutral fraction on a neutral regime', () => {
    const out = regimeExposure(cfg({ enabled: true, neutralScalar: '0.4' }), mkt(NEUTRAL));
    expect(out.regime).toBe('neutral');
    expect(out.scalar.toString()).toBe('0.4');
  });

  it('returns 0 (sit in cash) on a confirmed bear', () => {
    const out = regimeExposure(cfg({ enabled: true }), mkt(BEAR));
    expect(out.regime).toBe('bear');
    expect(out.scalar.eq(0)).toBe(true);
  });

  it('fails open to 1 when the regime is uncomputable (too few daily candles)', () => {
    const out = regimeExposure(cfg({ enabled: true }), mkt(['100', '100']));
    expect(out.regime).toBe('unavailable');
    expect(out.scalar.eq(1)).toBe(true);
  });
});

describe('regime.exposure.neutralScalar bound', () => {
  // The reduced-size behaviour relies on the schema clamping neutralScalar to
  // [0, 1] — a value > 1 would size ABOVE full, the opposite of the intent.
  const parseWith = (neutralScalar: string) =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      regime: { ma: 'sma', period: 3, confirmBars: 2, exposure: { enabled: true, neutralScalar } },
    });

  it('accepts the bounds 0 and 1', () => {
    expect(() => parseWith('0')).not.toThrow();
    expect(() => parseWith('1')).not.toThrow();
  });

  it('rejects values outside [0, 1]', () => {
    expect(() => parseWith('1.5')).toThrow();
    expect(() => parseWith('-0.1')).toThrow();
  });
});
