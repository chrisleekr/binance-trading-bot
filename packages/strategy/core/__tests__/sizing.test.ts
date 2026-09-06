import { describe, expect, it } from 'vitest';
import { ceilToStep, Decimal, roundToStep } from '@app/money';

import {
  applyEntryStopFloor,
  minSellableHeldQuantity,
  minSellableQuantityAtStop,
  parseFilters,
  sellableAtStop,
  type EntryStopFloor,
  type SizeFilters,
} from '../src/index.js';

const FILTERS: SizeFilters = {
  step: new Decimal('0.001'),
  minQty: new Decimal('0.001'),
  minNotional: new Decimal('0.0001'),
  tick: new Decimal('0.000001'),
};

const STOP = new Decimal('0.0118').mul('0.9').mul('0.98');
const STOP_FLOOR: EntryStopFloor = {
  distanceFraction: new Decimal('0.1'),
  limitOffset: new Decimal('0.98'),
};

describe('minSellableQuantityAtStop', () => {
  it('returns 0.011 for the ZECBTC filters at the stop price', () => {
    expect(minSellableQuantityAtStop(FILTERS, STOP)?.toFixed()).toBe('0.011');
  });

  it('applies the fee margin after the minimum-quantity arm wins', () => {
    const filters: SizeFilters = {
      step: new Decimal('0.001'),
      minQty: new Decimal('0.01'),
      minNotional: new Decimal('0.0001'),
    };
    const stop = new Decimal('1');
    const floor = minSellableQuantityAtStop(filters, stop);

    if (floor === null) throw new Error('expected a sellable quantity floor');

    expect(floor.toFixed()).toBe('0.012');
    expect(roundToStep(floor.mul('0.999'), filters.step).gte(filters.minQty)).toBe(true);
  });

  it('is null for a non-positive stop price', () => {
    expect(minSellableQuantityAtStop(FILTERS, new Decimal('0'))).toBeNull();
    expect(minSellableQuantityAtStop(FILTERS, new Decimal('-1'))).toBeNull();
    expect(minSellableHeldQuantity(FILTERS, new Decimal('0'))).toBeNull();
    expect(minSellableHeldQuantity(FILTERS, new Decimal('-1'))).toBeNull();
  });

  it('uses no entry fee margin for already-held base', () => {
    const stop = new Decimal('0.0104076');

    expect(minSellableHeldQuantity(FILTERS, stop)?.toFixed(3)).toBe('0.010');
    expect(minSellableQuantityAtStop(FILTERS, stop)?.toFixed(3)).toBe('0.011');
  });

  it("the floor survives the base-asset fee and the exit's round-down when one step is tiny", () => {
    const filters: SizeFilters = {
      step: new Decimal('0.00001'),
      minQty: new Decimal('0.00001'),
      minNotional: new Decimal('5'),
    };
    const stop = new Decimal('10');
    const floor = minSellableQuantityAtStop(filters, stop);

    if (floor === null) throw new Error('expected a sellable quantity floor');

    expect(floor.toFixed()).toBe('0.50052');
    const feeAdjustedNotional = roundToStep(floor.mul(new Decimal('0.999')), filters.step).mul(
      stop,
    );
    expect(feeAdjustedNotional.toFixed()).toBe('5.0001');
    expect(feeAdjustedNotional.gte(filters.minNotional)).toBe(true);

    const naiveFloor = ceilToStep(filters.minNotional.div(stop), filters.step).plus(filters.step);
    expect(naiveFloor.toFixed()).toBe('0.50001');
    const naiveNotional = roundToStep(naiveFloor.mul(new Decimal('0.999')), filters.step).mul(stop);
    expect(naiveNotional.toFixed()).toBe('4.995');
    expect(naiveNotional.lt(filters.minNotional)).toBe(true);
  });
});

describe('sellableAtStop', () => {
  it('is false for 0.00999 and true for 0.011', () => {
    expect(sellableAtStop(new Decimal('0.00999'), STOP, FILTERS)).toBe(false);
    expect(sellableAtStop(new Decimal('0.011'), STOP, FILTERS)).toBe(true);
  });
});

describe('applyEntryStopFloor', () => {
  it('applyEntryStopFloor leaves a quantity at or above the floor unchanged', () => {
    expect(
      applyEntryStopFloor(new Decimal('0.011'), new Decimal('0.0118'), FILTERS, STOP_FLOOR),
    ).toEqual({ quantity: new Decimal('0.011') });
  });

  it('applyEntryStopFloor refuses with entry-below-stop-notional below the floor', () => {
    expect(
      applyEntryStopFloor(new Decimal('0.010'), new Decimal('0.0118'), FILTERS, STOP_FLOOR),
    ).toEqual({ skip: 'entry-below-stop-notional' });
  });

  it('refuses when the derived stop price is zero or negative', () => {
    const quantity = new Decimal('0.010');
    expect(
      applyEntryStopFloor(quantity, new Decimal('0.0118'), FILTERS, {
        ...STOP_FLOOR,
        limitOffset: new Decimal('0'),
      }),
    ).toEqual({ skip: 'entry-below-stop-notional' });
    expect(
      applyEntryStopFloor(quantity, new Decimal('0.0118'), FILTERS, {
        ...STOP_FLOOR,
        limitOffset: new Decimal('-0.98'),
      }),
    ).toEqual({ skip: 'entry-below-stop-notional' });
  });

  it('is the identity for a null stop', () => {
    const quantity = new Decimal('0.010');
    expect(applyEntryStopFloor(quantity, new Decimal('0.0118'), FILTERS, null)).toEqual({
      quantity,
    });
  });

  it('refuses rather than guesses when the symbol carries no usable price grid', () => {
    // The arm builds no level at all on a symbol whose tick does not parse, so it rests nothing. Admitting the entry here would create the unguardable position this gate exists to prevent, which is why the missing grid fails closed instead of falling back to the unquantised product.
    const gridless: SizeFilters = { ...FILTERS, tick: undefined };
    expect(
      applyEntryStopFloor(new Decimal('0.011'), new Decimal('0.0118'), gridless, STOP_FLOOR),
    ).toEqual({ skip: 'entry-below-stop-notional' });
    expect(
      applyEntryStopFloor(
        new Decimal('0.011'),
        new Decimal('0.0118'),
        { ...FILTERS, tick: new Decimal('0') },
        STOP_FLOOR,
      ),
    ).toEqual({ skip: 'entry-below-stop-notional' });
  });
});

// A BTC-quoted coin on a 1e-8 grid: one tick is roughly 0.4% of the price, so the
// two floorings the arm applies move the sell price far enough to change the
// answer. The entry floor must ask its question at the arm's price, or it admits
// entries the arm then declines to guard.
describe('applyEntryStopFloor — the coarse-tick grid the arm will price on', () => {
  const COARSE: SizeFilters = {
    step: new Decimal('0.1'),
    minQty: new Decimal('0.1'),
    minNotional: new Decimal('0.0001'),
    tick: new Decimal('0.00000001'),
  };
  const ENTRY = new Decimal('0.00000251');
  const STOP: EntryStopFloor = {
    distanceFraction: new Decimal('0.1'),
    limitOffset: new Decimal('0.995'),
  };
  // Trigger 0.00000251 x 0.9 = 0.000002259 floors to 0.00000225, and its 0.995 limit leg 0.0000022387500 floors to this. The unquantised product is 0.000002247705, about 0.8% higher, and a higher price is a smaller sellable quantity.
  const ARM_PRICE = new Decimal('0.00000223');

  it('admits only an entry that is still sellable at the price the arm will send', () => {
    // 44.9 clears the floor derived from the unquantised product and misses the one derived from the grid price. That is the whole gap: the entry was admitted, then the arm refused it with base-below-exchange-minimum and rested nothing.
    expect(applyEntryStopFloor(new Decimal('44.9'), ENTRY, COARSE, STOP)).toEqual({
      skip: 'entry-below-stop-notional',
    });
    const admitted = new Decimal('45');
    expect(applyEntryStopFloor(admitted, ENTRY, COARSE, STOP)).toEqual({ quantity: admitted });

    // The position the arm will actually judge: the entry after the assumed base-asset fee and the exit's step round-down, priced at the grid-aligned limit leg the order carries.
    const surviving = (entry: Decimal) => roundToStep(entry.mul('0.999'), COARSE.step);
    expect(sellableAtStop(surviving(admitted), ARM_PRICE, COARSE)).toBe(true);
    expect(sellableAtStop(surviving(new Decimal('44.9')), ARM_PRICE, COARSE)).toBe(false);
  });

  it('floors both quantisations instead of rounding to the nearest tick', () => {
    // The trigger sits at 225.9 ticks and its limit leg at 223.875, so rounding to the nearest tick would price them at 0.00000226 and 0.00000224 instead. Every tick of extra price shrinks the quantity the floor demands: at the half-up price the floor is 44.8, so 44.8 is admitted, and at the price the order will actually carry it is 45 and 44.8 is not sellable at all.
    expect(minSellableQuantityAtStop(COARSE, new Decimal('0.00000224'))?.toFixed()).toBe('44.8');
    expect(minSellableQuantityAtStop(COARSE, ARM_PRICE)?.toFixed()).toBe('45');
    expect(applyEntryStopFloor(new Decimal('44.8'), ENTRY, COARSE, STOP)).toEqual({
      skip: 'entry-below-stop-notional',
    });
    expect(sellableAtStop(new Decimal('44.8'), ARM_PRICE, COARSE)).toBe(false);
  });

  it('reads the grid off the symbol filters the caller already parsed', () => {
    // Threading the tick through the parsed filter set is what lets both strategies' entry sizing ask the arm's question without a second parse of the symbol.
    const parsed = parseFilters({
      minNotional: '0.0001',
      tickSize: '0.00000001',
      stepSize: '0.1',
      minQty: '0.1',
      maxQty: '9000000',
      minPrice: '0.00000001',
      maxPrice: '1000',
    });
    expect(parsed?.tick?.toFixed()).toBe('0.00000001');
    // A grid that cannot be read is carried as absent rather than turned into an invalid-filters refusal, because a caller that prices nothing must still be able to size.
    expect(
      parseFilters({
        minNotional: '10',
        tickSize: 'x',
        stepSize: '1',
        minQty: '1',
        maxQty: '9',
        minPrice: '1',
        maxPrice: '9',
      })?.tick,
    ).toBeUndefined();
    // A grid of zero parses cleanly and is still unusable: quantising onto it would divide by zero, so it is carried as absent exactly like text that never parsed. Binance has published a zero tick on symbols that are not price-quantised, so this is a value the mapping really sees rather than a defensive branch.
    expect(
      parseFilters({
        minNotional: '10',
        tickSize: '0',
        stepSize: '1',
        minQty: '1',
        maxQty: '9',
        minPrice: '1',
        maxPrice: '9',
      })?.tick,
    ).toBeUndefined();
  });
});
