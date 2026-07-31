import { describe, expect, it } from 'vitest';
import { ttRequiredWindow } from '../src/index.js';
import type { TTConfig } from '../src/index.js';

// requiredWindow reports the candle lookback a config needs so live and backtest
// size the window identically. Reads the config defensively (the live worker may
// pass it unparsed), so these feed plain objects.
const cfg = (buy: Record<string, unknown>): TTConfig => ({ buy }) as unknown as TTConfig;

describe('ttRequiredWindow', () => {
  it('needs candleLimit candles only for the lowest-price first-buy basis', () => {
    expect(ttRequiredWindow(cfg({ firstBuyTriggerBasis: 'lowest-price', candleLimit: 500 }))).toBe(
      500,
    );
    // 'immediate' never scans the window, so candleLimit is irrelevant.
    expect(ttRequiredWindow(cfg({ firstBuyTriggerBasis: 'immediate', candleLimit: 500 }))).toBe(0);
  });

  it('needs lookbackCandles when the mean-reversion gate is enabled', () => {
    const enabled = cfg({ meanReversionGate: { entryZScoreMax: '-1', lookbackCandles: 300 } });
    expect(ttRequiredWindow(enabled)).toBe(300);
    // Empty entryZScoreMax disables the gate, so its lookback is not required.
    const disabled = cfg({ meanReversionGate: { entryZScoreMax: '', lookbackCandles: 300 } });
    expect(ttRequiredWindow(disabled)).toBe(0);
  });

  it('takes the max across both window-scanning knobs', () => {
    const c = cfg({
      firstBuyTriggerBasis: 'lowest-price',
      candleLimit: 120,
      meanReversionGate: { entryZScoreMax: '-1.5', lookbackCandles: 350 },
    });
    expect(ttRequiredWindow(c)).toBe(350);
  });

  it('coerces a non-finite candleLimit to 0 (unparsed garbage never throws)', () => {
    // lowest-price basis selected, but candleLimit is unparsed garbage → 0, so
    // nothing is required from the window.
    expect(ttRequiredWindow(cfg({ firstBuyTriggerBasis: 'lowest-price', candleLimit: 'x' }))).toBe(
      0,
    );
  });

  it('keeps the larger candleLimit when the mean-reversion lookback is smaller', () => {
    const c = cfg({
      firstBuyTriggerBasis: 'lowest-price',
      candleLimit: 500,
      meanReversionGate: { entryZScoreMax: '-1', lookbackCandles: 100 },
    });
    expect(ttRequiredWindow(c)).toBe(500);
  });

  it('returns 0 for a config that scans no window (caller floors at the default)', () => {
    expect(ttRequiredWindow(cfg({}))).toBe(0);
  });
});
