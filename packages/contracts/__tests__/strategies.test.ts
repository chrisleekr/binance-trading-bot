import { describe, expect, it } from 'vitest';
import { StrategyDescriptor } from '../src/strategies.js';

// A minimal, schema-conformant descriptor body the tests extend. The
// config/override schemas only need an object root to clear the descriptor's
// JSON-Schema refinement.
const baseDescriptor = (): Record<string, unknown> => ({
  name: 'trailing-trade',
  version: '2.0.0',
  displayName: 'Trailing Trade',
  description: 'desc',
  configSchema: { type: 'object', properties: {} },
  overrideConfigSchema: { type: 'object', properties: {} },
  defaultConfig: {},
  operatorActions: [],
});

// The reason-code → config-path attribution the strategy now owns (lifted out of
// apps/web). Optional on the descriptor: a strategy with no attribution omits it.
const REASON_ATTRIBUTION = {
  tt_risk_cap_veto: {
    setting: 'Exposure cap',
    paths: ['buy.maxSymbolExposureQuote', 'buy.accountCap'],
  },
  'indicator-rsi': { setting: 'RSI(14) buy ceiling', paths: ['buy.indicatorGate.rsiMaxBuy'] },
  'technicals-sell': {
    setting: 'Technical-rating gate',
    note: 'reads the market, not a setting you tune',
  },
};

describe('StrategyDescriptor reasonAttribution', () => {
  it('parses a descriptor carrying a reasonAttribution map and preserves it', () => {
    const parsed = StrategyDescriptor.parse({
      ...baseDescriptor(),
      reasonAttribution: REASON_ATTRIBUTION,
    });
    expect(parsed.reasonAttribution).toEqual(REASON_ATTRIBUTION);
  });

  it('parses a descriptor with no reasonAttribution (the field is optional)', () => {
    const parsed = StrategyDescriptor.parse(baseDescriptor());
    expect(parsed.reasonAttribution).toBeUndefined();
  });

  it('accepts an entry with only a setting (paths and note both optional)', () => {
    const parsed = StrategyDescriptor.parse({
      ...baseDescriptor(),
      reasonAttribution: { 'some-code': { setting: 'Just a setting' } },
    });
    expect(parsed.reasonAttribution?.['some-code']).toEqual({ setting: 'Just a setting' });
  });

  it('preserves an entry gloss + kind and accepts a gloss/kind-only entry (setting optional)', () => {
    const map = {
      'technicals-sell': {
        setting: 'Technical-rating gate',
        note: 'reads the market',
        gloss: 'Technical rating was bearish (Sell / Strong-Sell)',
        kind: 'market' as const,
      },
      // A pure gloss/kind entry: no setting, no lever. This is the warm-up shape.
      'indicator-unavailable': { gloss: 'Indicators were still warming up', kind: 'data' as const },
    };
    const parsed = StrategyDescriptor.parse({ ...baseDescriptor(), reasonAttribution: map });
    expect(parsed.reasonAttribution).toEqual(map);
  });

  // An illustrative momentum-shaped entry-blocker map: the nine real reason
  // codes with abbreviated glosses, exercising all four ReasonKind values. A
  // hardcoded fixture, not an import (contracts is a dependency of the strategy
  // packages, so it cannot import one back), and not a verbatim copy of the live
  // map. Its job is to lock that the generic descriptor accepts every momentum
  // reason + kind, so #595 needs no contracts change; the live glosses/kinds are
  // asserted in the momentum package's own attribution test.
  it('round-trips a momentum-shaped reasonAttribution map with all nine codes', () => {
    const momentumMap = {
      'already-entered-this-candle': { gloss: 'Already entered on this candle', kind: 'data' },
      'insufficient-history': { gloss: 'Not enough candles yet', kind: 'data' },
      'below-trend': { gloss: 'Price is below the trend line', kind: 'market' },
      'falling-trend': { gloss: 'Trend line is still falling', kind: 'market' },
      'sizing-unconfigured': { gloss: 'Entry sizing is not configured', kind: 'sizing' },
      'cap-reached': { gloss: 'Reserve cap reached', kind: 'config' },
      'min-qty': { gloss: "Order below Binance's minimum quantity", kind: 'sizing' },
      'min-notional': { gloss: "Order below Binance's minimum notional", kind: 'sizing' },
      'invalid-filters': { gloss: 'Symbol filter data was invalid', kind: 'data' },
    } as const;
    const parsed = StrategyDescriptor.parse({
      ...baseDescriptor(),
      name: 'momentum',
      reasonAttribution: momentumMap,
    });
    expect(parsed.reasonAttribution).toEqual(momentumMap);
    expect(Object.keys(parsed.reasonAttribution ?? {})).toHaveLength(9);
  });

  it('accepts every ReasonKind member and rejects an unknown kind', () => {
    for (const kind of ['market', 'config', 'sizing', 'data']) {
      const parsed = StrategyDescriptor.parse({
        ...baseDescriptor(),
        reasonAttribution: { c: { gloss: 'g', kind } },
      });
      expect(parsed.reasonAttribution?.['c']?.kind).toBe(kind);
    }
    expect(() =>
      StrategyDescriptor.parse({
        ...baseDescriptor(),
        reasonAttribution: { c: { gloss: 'g', kind: 'bogus' } },
      }),
    ).toThrow();
  });
});
