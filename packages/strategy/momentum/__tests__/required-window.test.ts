import { describe, expect, it } from 'vitest';
import { momentumRequiredWindow } from '../src/index.js';
import type { MomentumConfig } from '../src/index.js';

// requiredWindow reports the candle lookback a config needs so live and backtest
// size the window identically. It reads the config DEFENSIVELY (the live worker
// may pass it unparsed), so these feed plain objects, not parsed configs.
const cfg = (over: Record<string, unknown>): MomentumConfig => over as unknown as MomentumConfig;

describe('momentumRequiredWindow', () => {
  it('needs slow + 1 candles for the EMA cross when no trend filter', () => {
    expect(momentumRequiredWindow(cfg({ ema: { fast: 9, slow: 50 } }))).toBe(51);
  });

  it('honours a trend-filter period above the EMA need', () => {
    const c = cfg({
      ema: { fast: 9, slow: 50 },
      trendFilter: { enabled: true, period: 300, requireRising: false },
    });
    expect(momentumRequiredWindow(c)).toBe(300);
  });

  it('adds the slope lookback when the trend line must be rising', () => {
    const c = cfg({
      ema: { fast: 9, slow: 50 },
      trendFilter: { enabled: true, period: 300, requireRising: true, slopeLookbackBars: 10 },
    });
    expect(momentumRequiredWindow(c)).toBe(310);
  });

  it('floors the slope lookback at 1 when requireRising is on but the lookback is invalid or < 1', () => {
    // Non-finite slopeLookbackBars (unparsed garbage) → floor to 1.
    expect(
      momentumRequiredWindow(
        cfg({
          ema: { fast: 9, slow: 50 },
          trendFilter: { enabled: true, period: 300, requireRising: true, slopeLookbackBars: 'x' },
        }),
      ),
    ).toBe(301);
    // Finite but < 1 → floor to 1.
    expect(
      momentumRequiredWindow(
        cfg({
          ema: { fast: 9, slow: 50 },
          trendFilter: { enabled: true, period: 300, requireRising: true, slopeLookbackBars: 0 },
        }),
      ),
    ).toBe(301);
  });

  it('honours an enabled extension-guard period above the other needs', () => {
    // The extension gate reads `period` closes; the loaded window must cover it,
    // else the default-on gate fails closed on every tick and the strategy never
    // trades. period 300 (schema allows up to 400) exceeds the 200 window floor.
    const c = cfg({
      ema: { fast: 9, slow: 50 },
      entryExtension: { enabled: true, period: 300 },
    });
    expect(momentumRequiredWindow(c)).toBe(300);
  });

  it('coerces a finite-but-below-2 extension period to the 50 default', () => {
    const c = cfg({ ema: { fast: 9, slow: 20 }, entryExtension: { enabled: true, period: 1 } });
    expect(momentumRequiredWindow(c)).toBe(50);
  });

  it('ignores a disabled extension guard', () => {
    const c = cfg({ ema: { fast: 9, slow: 20 }, entryExtension: { enabled: false, period: 400 } });
    expect(momentumRequiredWindow(c)).toBe(21);
  });

  it('ignores a disabled trend filter', () => {
    const c = cfg({
      ema: { fast: 9, slow: 20 },
      trendFilter: { enabled: false, period: 400 },
    });
    expect(momentumRequiredWindow(c)).toBe(21);
  });

  it('coerces an omitted or invalid trend-filter period to the 200 default', () => {
    // A partial per-symbol override may enable the filter without a period. The
    // window must size to the gate's 200 default, not 0, else it would be short
    // of what the gate reads. Omitted (undefined) and finite-but-<2 both -> 200.
    expect(
      momentumRequiredWindow(cfg({ ema: { fast: 9, slow: 20 }, trendFilter: { enabled: true } })),
    ).toBe(200);
    expect(
      momentumRequiredWindow(
        cfg({ ema: { fast: 9, slow: 20 }, trendFilter: { enabled: true, period: 1 } }),
      ),
    ).toBe(200);
  });

  it('coerces an unparsed (string) config and never throws on missing fields', () => {
    expect(momentumRequiredWindow(cfg({ ema: { slow: '50' } }))).toBe(51);
    expect(momentumRequiredWindow(cfg({}))).toBe(1); // slow absent → 0 + 1
  });
});
