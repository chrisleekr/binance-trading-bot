import { describe, expect, it } from 'vitest';

import { attributeBlocker } from '@/features/backtest/lib/decision-breakdown';

// attributeBlocker now resolves a blocker's lever from a PASSED attribution map
// (the strategy's own reasonAttribution), not a module-level CONFIG_ATTRIBUTION
// hardcoded in apps/web (invariant #1). New signature:
//   attributeBlocker(code, attributionMap, config)
type ReasonAttributionMap = Record<
  string,
  { setting: string; paths?: readonly string[]; note?: string }
>;

const TT_ATTR: ReasonAttributionMap = {
  'indicator-rsi': { setting: 'RSI(14) buy ceiling', paths: ['buy.indicatorGate.rsiMaxBuy'] },
  'technicals-sell': {
    setting: 'Technical-rating gate',
    note: 'reads the market, not a setting you tune',
  },
};

describe('attributeBlocker(code, attributionMap, config)', () => {
  it('resolves setting/path/value from the PASSED map, not a module-level map', () => {
    const map: ReasonAttributionMap = {
      tt_custom_veto: { setting: 'Custom', paths: ['buy.fooBar'] },
    };
    const attr = attributeBlocker('tt_custom_veto', map, { buy: { fooBar: '7' } });
    expect(attr?.setting).toBe('Custom');
    expect(attr?.path).toBe('buy.fooBar');
    expect(attr?.value).toBe('7');
  });

  it('returns null for a code absent from the passed map (no lever)', () => {
    const map: ReasonAttributionMap = { 'something-else': { setting: 'Else' } };
    expect(
      attributeBlocker('indicator-rsi', map, { buy: { indicatorGate: { rsiMaxBuy: '30' } } }),
    ).toBeNull();
  });

  it('reports a note-only entry without a path', () => {
    const attr = attributeBlocker('technicals-sell', TT_ATTR, {});
    expect(attr?.path).toBeNull();
    expect(attr?.detail).toMatch(/reads the market/);
  });
});
