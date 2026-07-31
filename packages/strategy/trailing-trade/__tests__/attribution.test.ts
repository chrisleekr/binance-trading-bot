import { describe, expect, it } from 'vitest';
import { ttAttributeOrder } from '../src/attribution.js';
import {
  firstBuyClientOrderId,
  gridBuyClientOrderId,
  manualOrderClientOrderId,
  protectiveStopClientOrderId,
  pyramidBuyClientOrderId,
} from '../src/client-order-id.js';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';

const PROFILE = '11111111-1111-1111-1111-111111111111';
const SYMBOL = 'BTCUSDT';

// Build a parsed config with an explicit grid ladder; pyramid maxAdds keeps its
// schema default of 3, so adds 1..3 are enumerable and add 4 is out of range.
const configWithGrid = (levels: number): TTConfig =>
  TTConfigSchema.parse({
    symbol: SYMBOL,
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      // Level 0 is the entry buy (triggerPercentage must equal 1); promotions
      // buy below the average cost (strictly < 1).
      gridLevels: Array.from({ length: levels }, (_, i) => ({
        triggerPercentage: i === 0 ? '1' : (1 - i * 0.01).toFixed(2),
        maxPurchaseAmount: '15',
      })),
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

describe('ttAttributeOrder', () => {
  const config = configWithGrid(2);
  // Attribution GATES adoption, so the boolean under test is "can this profile
  // PROVE it placed the order"; the intent it returns is asserted separately.
  const suggests = (clientOrderId: string): boolean =>
    ttAttributeOrder({ clientOrderId, profileId: PROFILE, symbol: SYMBOL, config }) !== null;

  it('matches the first-buy id', () => {
    expect(suggests(firstBuyClientOrderId(PROFILE, SYMBOL))).toBe(true);
  });

  it('matches an in-range grid-level id', () => {
    expect(suggests(gridBuyClientOrderId(PROFILE, SYMBOL, 0))).toBe(true);
    expect(suggests(gridBuyClientOrderId(PROFILE, SYMBOL, 1))).toBe(true);
  });

  it('rejects a grid-level id past gridLevels.length', () => {
    // config has 2 levels (indexes 0,1); index 2 was never enumerable.
    expect(suggests(gridBuyClientOrderId(PROFILE, SYMBOL, 2))).toBe(false);
  });

  it('matches an in-range pyramid add id', () => {
    expect(suggests(pyramidBuyClientOrderId(PROFILE, SYMBOL, 1))).toBe(true);
    expect(suggests(pyramidBuyClientOrderId(PROFILE, SYMBOL, 3))).toBe(true);
  });

  it('rejects a pyramid add id past maxAdds', () => {
    // default maxAdds is 3; add 4 is out of range.
    expect(suggests(pyramidBuyClientOrderId(PROFILE, SYMBOL, 4))).toBe(false);
  });

  it('rejects an id built for a different profile', () => {
    const other = '22222222-2222-2222-2222-222222222222';
    expect(suggests(firstBuyClientOrderId(other, SYMBOL))).toBe(false);
    expect(suggests(gridBuyClientOrderId(other, SYMBOL, 0))).toBe(false);
  });

  it('rejects an id built for a different symbol', () => {
    expect(suggests(firstBuyClientOrderId(PROFILE, 'ETHUSDT'))).toBe(false);
  });

  it('rejects unattributable manual and sell ids', () => {
    // Manual folds a UUID, sells fold avgEntryPrice — neither is enumerable.
    expect(suggests(manualOrderClientOrderId('abcdef01-2345-6789-abcd-ef0123456789'))).toBe(false);
    expect(suggests(`tt-deadbeef-s`)).toBe(false);
  });

  it('rejects a foreign clientOrderId shape', () => {
    expect(suggests('mo-deadbeef-e')).toBe(false);
    expect(suggests('not-a-client-id')).toBe(false);
  });

  it('claims its own PROTECTIVE STOP — the id that must never be adopted elsewhere', () => {
    // The `-x` stop is keyed on (profile, symbol) alone, so it is the one id that
    // rests on the book for days and is therefore the one most likely to be
    // orphaned by a crash between placement and its local row. Handing it to a
    // different strategy locks the base asset against its real owner forever, so
    // proving TT claims it is what makes the derive-the-owner gate work at all.
    const attributed = ttAttributeOrder({
      clientOrderId: protectiveStopClientOrderId(PROFILE, SYMBOL),
      profileId: PROFILE,
      symbol: SYMBOL,
      config,
    });
    expect(attributed).toEqual({ intent: 'protective-stop' });

    // Same id, a different profile: not yours.
    expect(
      suggests(protectiveStopClientOrderId('22222222-2222-2222-2222-222222222222', SYMBOL)),
    ).toBe(false);
  });

  it('returns the strategy OWN slot name so the adopted row lands where it manages it', () => {
    const intentOf = (clientOrderId: string): string | undefined =>
      ttAttributeOrder({ clientOrderId, profileId: PROFILE, symbol: SYMBOL, config })?.intent;

    expect(intentOf(firstBuyClientOrderId(PROFILE, SYMBOL))).toBe('grid-buy');
    expect(intentOf(gridBuyClientOrderId(PROFILE, SYMBOL, 1))).toBe('grid-buy');
    expect(intentOf(pyramidBuyClientOrderId(PROFILE, SYMBOL, 2))).toBe('bull-pyramid');
  });

  it('matches only the first-buy when the grid ladder is empty', () => {
    const single = configWithGrid(0);
    const s = (id: string): boolean =>
      ttAttributeOrder({
        clientOrderId: id,
        profileId: PROFILE,
        symbol: SYMBOL,
        config: single,
      }) !== null;
    expect(s(firstBuyClientOrderId(PROFILE, SYMBOL))).toBe(true);
    expect(s(gridBuyClientOrderId(PROFILE, SYMBOL, 0))).toBe(false);
  });
});
