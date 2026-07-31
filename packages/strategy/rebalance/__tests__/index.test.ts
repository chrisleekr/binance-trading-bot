import { describe, expect, it } from 'vitest';
import { rebalance, rebalanceRequiredWindow, type RebalanceConfig } from '../src/index.js';

// The function reads config defensively (the live worker passes it unparsed), so
// a loosely-shaped object is the honest test input.
const cfg = (o: object) => o as unknown as RebalanceConfig;

describe('rebalanceRequiredWindow', () => {
  it('needs no candle window in fixed mode (reads no history)', () => {
    expect(rebalanceRequiredWindow(cfg({ weightMode: 'fixed' }))).toBe(0);
  });

  it('needs lookbackCandles + 1 in momentum mode (score compares last vs N ago)', () => {
    expect(
      rebalanceRequiredWindow(cfg({ weightMode: 'momentum', momentum: { lookbackCandles: 250 } })),
    ).toBe(251);
  });

  it('needs no window for a non-positive or missing lookback', () => {
    expect(
      rebalanceRequiredWindow(cfg({ weightMode: 'momentum', momentum: { lookbackCandles: 0 } })),
    ).toBe(0);
    expect(rebalanceRequiredWindow(cfg({ weightMode: 'momentum', momentum: {} }))).toBe(0);
  });

  it('is wired into the strategy so the loaded window honors the lookback', () => {
    expect(rebalance.requiredWindow).toBe(rebalanceRequiredWindow);
  });
});
