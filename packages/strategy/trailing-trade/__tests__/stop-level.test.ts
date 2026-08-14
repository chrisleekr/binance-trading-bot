// The one resolution point for trailing-trade's loss-side stop, and the sell
// gate that consumes it. Both are covered here because the clamp's whole claim
// is that the in-process exit and the resting order read ONE number: testing the
// resolver alone would leave the wiring unproven, and testing the gate alone
// would leave the arithmetic unpinned.

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import { evaluateSellGate } from '../src/branches/sell-gate.js';
import { resolveTTStopLevel } from '../src/stop-level.js';
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
