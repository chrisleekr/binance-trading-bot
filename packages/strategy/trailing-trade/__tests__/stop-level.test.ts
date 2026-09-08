// The one resolution point for trailing-trade's loss-side stop, and the sell
// gate that consumes it. Both are covered here because the clamp's whole claim
// is that the in-process exit and the resting order read ONE number: testing the
// resolver alone would leave the wiring unproven, and testing the gate alone
// would leave the arithmetic unpinned.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import { evaluateProtectiveStop } from '../src/branches/protective-stop.js';
import { evaluateSellGate } from '../src/branches/sell-gate.js';
import { assessHeldDownsideExit } from '../src/exit-blocker.js';
import { resolveTTStopLevel, ttStopSellPrice } from '../src/stop-level.js';
import type { TTBundle, TTConfig, TTState } from '../src/schema.js';
import type { TickInput } from '@app/strategy-core';

const BAND = {
  bidMultiplierUp: '1.1',
  bidMultiplierDown: '0.5',
  askMultiplierUp: '2',
  askMultiplierDown: '0.9',
  avgPriceMins: 5,
};

const CLAMP_ON = { enabled: true, onBandBlock: 'clamp' };

// entry 100 at `stopLossPercentage: 0.85` rests the stop at 85, while the band
// floor at a reference of 100 is `100 x 0.9 / 0.995 x 1.01`. The configured stop
// sits under it, so the clamp binds.
const ENTRY = new Decimal('100');
const STOP_PCT = new Decimal('0.85');
const FLOOR_AT_100 = '91.35678391959798995';

const resolve = (over: {
  readonly stopPct?: Decimal;
  readonly protectiveStop?: unknown;
  readonly reference?: string | null;
  readonly band?: unknown;
}) =>
  resolveTTStopLevel({
    avgEntry: ENTRY,
    stopPct: over.stopPct ?? STOP_PCT,
    protectiveStop: 'protectiveStop' in over ? over.protectiveStop : CLAMP_ON,
    bandContext: {
      reference: over.reference === undefined ? '100' : over.reference,
      band: ('band' in over ? over.band : BAND) as never,
    },
  });

describe('resolveTTStopLevel — the clamp', () => {
  it('raises the stop to the exchange floor and says so', () => {
    const out = resolve({});
    expect(out.stop.toString()).toBe(FLOOR_AT_100);
    expect(out.floorClamped).toBe(true);
  });

  it('leaves a stop the band already accepts exactly where the operator put it', () => {
    // 0.95 rests the stop at 95, above the 91.36 floor: raising it would tighten
    // protection the exchange never asked us to tighten.
    const out = resolve({ stopPct: new Decimal('0.95') });
    expect(out.stop.toString()).toBe('95');
    expect(out.floorClamped).toBe(false);
  });

  it('never lifts the stop to or above the market, whatever the band says', () => {
    // `askMultiplierDown` at the limit offset puts the raw floor at 101 — ABOVE
    // the reference. Resting a trigger there is a market sell wearing a stop's
    // name, so the clamp declines rather than tighten into an instant exit.
    const out = resolve({ band: { ...BAND, askMultiplierDown: '0.995' } });
    expect(out.stop.toString()).toBe('85');
    expect(out.floorClamped).toBe(false);
  });
});

describe('resolveTTStopLevel — identity on every ambiguity', () => {
  // Each of these is a reason the exchange floor cannot be evaluated. A missed
  // one does not clamp to a wrong level, it clamps to a level derived from a
  // value that never parsed, which is how a stop ends up resting at zero.
  const cases: readonly (readonly [string, Parameters<typeof resolve>[0]])[] = [
    ['no protectiveStop block at all (config predates the field)', { protectiveStop: undefined }],
    ['a protectiveStop that is not an object', { protectiveStop: 'yes' }],
    [
      'the exchange-side stop disabled',
      { protectiveStop: { enabled: false, onBandBlock: 'clamp' } },
    ],
    ['the operator on notify rather than clamp', { protectiveStop: { enabled: true } }],
    [
      'native-trail, which escapes the band instead of obeying it',
      { protectiveStop: { enabled: true, onBandBlock: 'native-trail' } },
    ],
    ['no band published for the symbol', { band: undefined }],
    ['a band that is not an object', { band: 'PERCENT_PRICE_BY_SIDE' }],
    ['an unparseable floor multiplier', { band: { ...BAND, askMultiplierDown: 'x' } }],
    ['no reference price to band against', { reference: null }],
    ['an unusable limit offset', { protectiveStop: { ...CLAMP_ON, limitOffsetPercentage: 'x' } }],
  ];

  for (const [name, over] of cases) {
    it(`leaves the configured stop alone with ${name}`, () => {
      const out = resolve(over);
      expect(out.stop.toString()).toBe('85');
      expect(out.floorClamped).toBe(false);
    });
  }
});

const SYMBOL_INFO = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
    percentPriceBySide: BAND,
  },
} as const;

const candle = (close: string) => ({
  openTimeMs: 0,
  closeTimeMs: 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const input = (
  protectiveStop: unknown,
  currentPrice: string,
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: {
      sell: {
        stopLossPercentage: '0.85',
        // Every other exit off, so an emission can only have come from the hard
        // stop-loss and the clamp is the only thing under test.
        triggerPercentage: '',
        trailingStopPercentage: '0',
        atrTrailing: { enabled: false, period: 14, multiplier: '3' },
        discoveryTimeStopBars: 0,
        protectiveStop,
      },
      buy: {},
      candleInterval: '1h',
    },
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: { '1h': [candle(currentPrice)] },
      symbolInfo: SYMBOL_INFO,
    },
    openOrders: [],
    bundle: { technicals: {}, override: null },
    profile: { id: 'p1' },
    account: {
      balances: { BTC: { free: '1', locked: '0' }, USDT: { free: '1000', locked: '0' } },
      readable: true,
    },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const held = (): TTState =>
  ({
    avgEntryPrice: '100',
    heldQuantity: '1',
    highSinceBuy: null,
    breakEvenArmed: false,
  }) as unknown as TTState;

const stopConfig = (stopLossPercentage: string, protectiveStop?: unknown): TTConfig =>
  ({
    sell: {
      stopLossPercentage,
      ...(protectiveStop === undefined ? {} : { protectiveStop }),
    },
  }) as unknown as TTConfig;

const stopState = (avgEntryPrice?: string): TTState =>
  ({ ...(avgEntryPrice === undefined ? {} : { avgEntryPrice }) }) as unknown as TTState;

// `ttStopSellPrice` now prices the sell on the grid the order will carry, so the
// fixture has to state one a 0.0118 price can sit on. The shared SYMBOL_INFO's
// 0.01 tick belongs to a USDT pair whose prices run in the thousands; left here it
// would floor every level in this block to 0.01 or to zero, which says nothing
// about the arithmetic under test.
const STOP_MARKET = {
  ...input(undefined, '0.0118').market,
  symbolInfo: {
    ...SYMBOL_INFO,
    filters: { ...SYMBOL_INFO.filters, tickSize: '0.000001' },
  },
} as unknown as ReturnType<typeof input>['market'];

describe('ttStopSellPrice', () => {
  it('returns null when avgEntryPrice is missing', () => {
    expect(ttStopSellPrice(stopConfig('0.9'), stopState(), STOP_MARKET)).toBeNull();
  });

  it('returns the trigger when avgEntryPrice is set', () => {
    expect(ttStopSellPrice(stopConfig('0.9'), stopState('0.0118'), STOP_MARKET)?.toString()).toBe(
      '0.01062',
    );
  });

  for (const stopLossPercentage of ['', '0', '1.5']) {
    it(`returns null for stopLossPercentage ${JSON.stringify(stopLossPercentage)}`, () => {
      expect(
        ttStopSellPrice(stopConfig(stopLossPercentage), stopState('0.0118'), STOP_MARKET),
      ).toBeNull();
    });
  }

  it('applies a valid protective-stop offset to the trigger, on the grid', () => {
    // 0.01062 x 0.98 is 0.0104076, which is not a multiple of the 1e-6 tick. The
    // limit leg the arm rests floors it to 0.010407, and this rung has to name the
    // price the order carries rather than the exact product, or the two disagree
    // about the same position.
    expect(
      ttStopSellPrice(
        stopConfig('0.9', { enabled: true, limitOffsetPercentage: '0.98' }),
        stopState('0.0118'),
        STOP_MARKET,
      )?.toString(),
    ).toBe('0.010407');
  });

  for (const limitOffsetPercentage of ['abc', '0', '1.5']) {
    it(`uses the trigger for an enabled offset of ${JSON.stringify(limitOffsetPercentage)}`, () => {
      expect(
        ttStopSellPrice(
          stopConfig('0.9', { enabled: true, limitOffsetPercentage }),
          stopState('0.0118'),
          STOP_MARKET,
        )?.toString(),
      ).toBe('0.01062');
    });
  }

  it('uses the trigger when an enabled protective-stop offset is missing', () => {
    expect(
      ttStopSellPrice(
        stopConfig('0.9', { enabled: true }),
        stopState('0.0118'),
        STOP_MARKET,
      )?.toString(),
    ).toBe('0.01062');
  });

  it('uses the trigger when the protective stop is disabled', () => {
    expect(
      ttStopSellPrice(
        stopConfig('0.9', { enabled: false, limitOffsetPercentage: '0.98' }),
        stopState('0.0118'),
        STOP_MARKET,
      )?.toString(),
    ).toBe('0.01062');
  });

  it('returns null when the product underflows decimal.js to exact zero', () => {
    // An entry at decimal.js's minimum exponent is finite and positive, so it passes every input guard, yet its product with a fraction below 1 clamps to 0. A zero sell price would let the exit-blocker floor read as sellable at nothing.
    const atMinExponent = `1e${new Decimal(Decimal.minE).toFixed()}`;
    expect(new Decimal(atMinExponent).gt(0)).toBe(true);
    expect(ttStopSellPrice(stopConfig('0.9'), stopState(atMinExponent), STOP_MARKET)).toBeNull();
  });
});

describe('the sell gate reads the resolved level, clamp included', () => {
  it('does not exit early just because the band raised the resting stop', () => {
    // The one direction a clamp could break the position outright. It only ever
    // RAISES the trigger, and the level it raises to is a fraction of the SAME
    // price the gate compares against — so `clampStopToExchangeFloor` keeping the
    // floor strictly under the reference is what stands between "the stop now
    // rests where Binance accepts it" and "every held position market-sells on
    // the next tick". Pinned here because the arithmetic that guarantees it
    // (`askMultiplierDown / limitOffset x margin < 1`) holds for today's bands
    // and not by construction.
    const clamped = evaluateSellGate(input(CLAMP_ON, '100'), held());
    expect(clamped.kind).toBe('noop');
  });

  it('still exits at the configured stop, which is where the clamp goes inert', () => {
    // At a price of 85 the floor is 77.65, under the configured stop, so the
    // clamp returns it untouched — the two modes must agree exactly here, and a
    // clamp that moved this boundary would be selling at a level the operator
    // never chose.
    for (const ps of [CLAMP_ON, { enabled: true }, undefined]) {
      const out = evaluateSellGate(input(ps, '85'), held());
      expect(out.kind).toBe('emit');
      if (out.kind !== 'emit') throw new Error('expected the stop-loss to emit');
      expect(out.metricName).toBe('tt_grid_stop_loss_emit');
    }
  });
});

// The exit rung and the protective-stop arm ask the same question about the same
// position — is the quantity this stop would sell worth Binance's minimum? — and
// derived the price differently, so on a coarse grid they answered it opposite
// ways: the rung reported a sound downside exit while the arm refused to place
// one and rested nothing. A BTC-quoted coin makes the gap visible because a
// single 1e-8 tick is roughly 0.4% of a 0.0000025 price.
describe('the exit rung and the protective-stop arm price one position identically', () => {
  const COARSE_FILTERS = {
    minNotional: '0.0001',
    tickSize: '0.00000001',
    stepSize: '0.1',
    minQty: '0.1',
    maxQty: '9000000',
    minPrice: '0.00000001',
    maxPrice: '1000',
  } as const;

  const COARSE_CONFIG = {
    sell: {
      stopLossPercentage: '0.9',
      protectiveStop: { enabled: true, limitOffsetPercentage: '0.995' },
    },
  } as unknown as TTConfig;

  // Trigger 0.00000251 x 0.9 = 0.000002259, which floors to 0.00000225 on the
  // grid; its 0.995 limit leg 0.0000022387500 floors to 0.00000223. The
  // unquantised product is 0.000002247705, about 0.8% higher — enough to make 44.5
  // held look worth 0.000100022 rather than the 0.000099235 the exchange sees.
  const ARM_LIMIT = '0.00000223';

  const coarseState = (heldQuantity: string): TTState =>
    ({ avgEntryPrice: '0.00000251', heldQuantity }) as unknown as TTState;

  const coarseInput = (heldQuantity: string): TickInput<TTConfig, TTState, TTBundle> =>
    ({
      config: COARSE_CONFIG,
      market: {
        symbol: 'ZECBTC',
        currentPrice: '0.0000025',
        candlesByInterval: { '1h': [candle('0.0000025')] },
        symbolInfo: {
          symbol: 'ZECBTC',
          baseAsset: 'ZEC',
          quoteAsset: 'BTC',
          status: 'TRADING',
          filters: COARSE_FILTERS,
        },
      },
      openOrders: [],
      bundle: { technicals: {}, override: null },
      profile: { id: 'p1' },
      account: {
        balances: {
          ZEC: { asset: 'ZEC', free: new Decimal(heldQuantity), locked: new Decimal('0') },
        },
        readable: true,
      },
    }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

  it('names the price the arm actually rests', () => {
    // Read off the order the arm emits, not recomputed here: the claim is that the
    // rung quotes the bytes the exchange will receive.
    const armed = evaluateProtectiveStop(coarseInput('45'), coarseState('45'));
    expect(armed.decisions).toHaveLength(1);
    expect(armed.decisions[0]).toMatchObject({
      type: 'place-order',
      params: { type: 'STOP_LOSS_LIMIT', stopPrice: '0.00000225', price: ARM_LIMIT },
    });
    expect(
      ttStopSellPrice(COARSE_CONFIG, coarseState('45'), coarseInput('45').market)?.toFixed(),
    ).toBe(ARM_LIMIT);
  });

  it('gives 44.5 held the same feasibility verdict the arm gives it', () => {
    // 44.5 x 0.00000223 is 0.000099235, under the 0.0001 minimum: the arm rests
    // nothing and says why. Priced at the unquantised 0.000002247705 the same
    // holding is worth 0.000100022 and the rung called the downside exit sound.
    const refused = evaluateProtectiveStop(coarseInput('44.5'), coarseState('44.5'));
    expect(refused.decisions).toEqual([]);
    expect(refused.blocker?.reason).toBe('base-below-exchange-minimum');

    const rung = assessHeldDownsideExit(
      COARSE_CONFIG,
      coarseState('44.5'),
      coarseInput('44.5').market,
    );
    expect(rung.stopInfeasible).toMatchObject({
      heldQuantity: '44.5',
      stopPrice: ARM_LIMIT,
      minNotional: '0.0001',
    });

    // And the two still agree one step up, where the arm does place: a rung that
    // only ever refused would agree here by being uselessly strict.
    expect(
      assessHeldDownsideExit(COARSE_CONFIG, coarseState('45'), coarseInput('45').market)
        .stopInfeasible,
    ).toBeNull();
  });

  it('floors both quantisations rather than rounding to the nearest tick', () => {
    // The trigger sits at 225.9 ticks and the limit leg at 223.875, so rounding to
    // the nearest tick would price them at 0.00000226 and 0.00000224. Every tick of
    // extra price buys the position notional it does not have, which is the exact
    // direction that lets this rung claim sellable what the arm refuses.
    const price = ttStopSellPrice(COARSE_CONFIG, coarseState('45'), coarseInput('45').market);
    expect(price?.toFixed()).toBe(ARM_LIMIT);
    expect(price?.lt(new Decimal('0.00000224'))).toBe(true);
  });

  it('claims no sell price on a symbol whose grid does not parse', () => {
    // The arm builds no level at all when the tick is unusable, so it rests
    // nothing. A price quoted here would be a price no order can carry.
    const gridless = {
      ...coarseInput('45').market,
      symbolInfo: {
        ...coarseInput('45').market.symbolInfo,
        filters: { ...COARSE_FILTERS, tickSize: '0' },
      },
    } as unknown as ReturnType<typeof coarseInput>['market'];
    expect(ttStopSellPrice(COARSE_CONFIG, coarseState('45'), gridless)).toBeNull();
  });
});
