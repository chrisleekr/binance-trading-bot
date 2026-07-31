// TTOverrideConfigSchema is the per-symbol config override surface — a
// deep-partial of TTConfigSchema. Coverage lives here, separate from the
// full-config tests in index.test.ts.

import { describe, expect, it } from 'vitest';
import { TTForceBuyOverrideSchema, TTOverrideConfigSchema } from '../src/index.js';
import { TTConfigSchema } from '../src/schema.js';

describe('@app/strategy-trailing-trade withParsedDefault', () => {
  it('yields a fresh default object per parse so a mutation does not bleed across configs', () => {
    const a = TTForceBuyOverrideSchema.parse(undefined);
    const b = TTForceBuyOverrideSchema.parse(undefined);
    expect(a).not.toBe(b);
    a.checkTechnicals = false;
    expect(b.checkTechnicals).toBe(true);
  });

  it('derives the default from the schema field set (fully shaped, not a bare {})', () => {
    expect(TTForceBuyOverrideSchema.parse(undefined)).toEqual({ checkTechnicals: true });
  });
});

describe('@app/strategy-trailing-trade TTConfigSchema avgEntryPriceRemoveThreshold default', () => {
  // The avgEntryPrice rename (formerly lastBuyPriceRemoveThreshold) shipped
  // without a config migration, so a stored config can omit the new key.
  // A full-parse path (backtest-runner) must not throw on it; it
  // defaults to "" (disabled), matching the live tick which reads a missing
  // value as disabled.
  it('defaults a config that omits buy.avgEntryPriceRemoveThreshold to "" instead of throwing', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '50' } },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(parsed.buy.avgEntryPriceRemoveThreshold).toBe('');
  });

  it('still parses an explicit avgEntryPriceRemoveThreshold value unchanged', () => {
    const parsed = TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0.9',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    });
    expect(parsed.buy.avgEntryPriceRemoveThreshold).toBe('0.9');
  });
});

describe('@app/strategy-trailing-trade gridLevels stop/limit pairing', () => {
  const withLevel = (level: Record<string, unknown>) => ({
    symbol: 'BTCUSDT',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '50' }, gridLevels: [level] },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

  it('rejects a level with a stop price but no limit price', () => {
    expect(() =>
      TTConfigSchema.parse(
        withLevel({
          triggerPercentage: '1',
          maxPurchaseAmount: '15',
          stopPricePercentage: '1.01',
          limitPricePercentage: '',
        }),
      ),
    ).toThrow(/limitPricePercentage is required when stopPricePercentage is set/);
  });

  it('rejects a level with a limit price but no stop price', () => {
    expect(() =>
      TTConfigSchema.parse(
        withLevel({
          triggerPercentage: '1',
          maxPurchaseAmount: '15',
          stopPricePercentage: '',
          limitPricePercentage: '1.015',
        }),
      ),
    ).toThrow(/stopPricePercentage is required when limitPricePercentage is set/);
  });

  it('rejects a level whose limit price is below its stop price', () => {
    expect(() =>
      TTConfigSchema.parse(
        withLevel({
          triggerPercentage: '1',
          maxPurchaseAmount: '15',
          stopPricePercentage: '1.02',
          limitPricePercentage: '1.01',
        }),
      ),
    ).toThrow(/limitPricePercentage must be greater than or equal to stopPricePercentage/);
  });
});

describe('@app/strategy-trailing-trade TTOverrideConfigSchema', () => {
  it('accepts an empty override (everything inherits the profile config)', () => {
    expect(TTOverrideConfigSchema.parse({})).toEqual({});
  });

  it('accepts a partial override carrying only the changed keys', () => {
    const parsed = TTOverrideConfigSchema.parse({
      buy: { entrySizing: { mode: 'fixed', amount: '99' } },
    });
    expect((parsed.buy as { entrySizing: { amount: string } }).entrySizing.amount).toBe('99');
  });

  it('accepts a sell-only override', () => {
    expect(() =>
      TTOverrideConfigSchema.parse({ sell: { stopLossPercentage: '0.9' } }),
    ).not.toThrow();
  });

  it('still enforces leaf refinements when a field is present', () => {
    expect(() =>
      TTOverrideConfigSchema.parse({
        buy: { entrySizing: { mode: 'fixed', amount: 'not-a-number' } },
      }),
    ).toThrow(/amount must be a positive decimal/);
  });

  it('rejects candleInterval — it is profile-level, not per-symbol', () => {
    expect(() => TTOverrideConfigSchema.parse({ candleInterval: '5m' })).toThrow();
  });

  it('rejects symbol — it is the override row key, not an overridable field', () => {
    expect(() => TTOverrideConfigSchema.parse({ symbol: 'ETHUSDT' })).toThrow();
  });
});
