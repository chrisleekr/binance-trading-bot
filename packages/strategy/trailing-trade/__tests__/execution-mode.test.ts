// Maker (passive limit) entry mode: the resolver that turns the current price
// into a passive buy-limit price, the two entry decision builders that emit a
// LIMIT instead of a MARKET buy under maker mode, and the round-trip fee floor
// that follows the execution mode. Default `market` mode stays byte-identical to
// the prior taker-only behaviour (covered by the existing replay/fees suites);
// here we exercise the opt-in maker paths and every defensive guard.

import { describe, expect, it } from 'vitest';
import { resolveMakerEntryLimit } from '../src/execution.js';
import { buildFirstBuyDecision, buildGridBuyDecision } from '../src/decisions.js';
import { roundTripFeeFraction, effectiveForceSellMinProfitPercent } from '../src/fees.js';
import { trailingTrade } from '../src/index.js';
import type { TTConfig, TTState, TTBundle } from '../src/schema.js';
import type { Decision, TickInput } from '@app/strategy-core';

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

/** Schema-valid config with the given execution + fees slices applied. */
const config = (over: Record<string, unknown> = {}): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '15' } },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    ...over,
  }) as TTConfig;

const makeInput = (
  cfg: TTConfig,
  opts: { currentPrice?: string; tickSize?: string; minPrice?: string } = {},
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    config: cfg,
    market: {
      symbol: 'BTCUSDT',
      currentPrice: opts.currentPrice ?? '100',
      candlesByInterval: {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          ...FILTERS,
          ...(opts.tickSize ? { tickSize: opts.tickSize } : {}),
          ...(opts.minPrice ? { minPrice: opts.minPrice } : {}),
        },
      },
    },
    openOrders: [],
    profile: { id: 'p1' },
    bundle: { technicals: {}, override: null },
    account: { balances: {}, readable: true },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

const maker = (over: Record<string, unknown> = {}): TTConfig =>
  config({ execution: { entryMode: 'maker', ...over } });

const orderParams = (d: Decision): Record<string, unknown> => {
  if (d.type !== 'place-order') throw new Error(`expected place-order, got ${d.type}`);
  return d.params as unknown as Record<string, unknown>;
};

describe('resolveMakerEntryLimit', () => {
  it('returns undefined in the default market mode (keeps the MARKET order)', () => {
    expect(resolveMakerEntryLimit(makeInput(config()))).toBeUndefined();
  });

  it('rests at the current price (rounded to tick) with a zero offset', () => {
    expect(resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '0' })))).toBe('100.00');
  });

  it('rests below the price by the offset (50 bp on 100 => 99.50)', () => {
    expect(resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '50' })))).toBe('99.50');
  });

  it('rounds the passive price down to the symbol tick', () => {
    // 33 bp below 100 = 99.67; tick 0.05 rounds to 99.65.
    expect(
      resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '33' }), { tickSize: '0.05' })),
    ).toBe('99.65');
  });

  it('returns undefined when the current price cannot be parsed', () => {
    expect(resolveMakerEntryLimit(makeInput(maker(), { currentPrice: '' }))).toBeUndefined();
  });

  it('returns undefined when the tick size is zero or unparseable', () => {
    expect(resolveMakerEntryLimit(makeInput(maker(), { tickSize: '0' }))).toBeUndefined();
  });

  it('returns undefined when the offset is corrupt (raw config from the worker)', () => {
    const bad = {
      ...maker(),
      execution: { entryMode: 'maker', makerOffsetBps: 'abc' },
    } as TTConfig;
    expect(resolveMakerEntryLimit(makeInput(bad))).toBeUndefined();
  });

  it('returns undefined when a 100% offset would price the buy at zero', () => {
    expect(resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '10000' })))).toBeUndefined();
  });

  it('returns undefined when a sub-tick price rounds down to zero', () => {
    // 0.004 floored to a 0.01 tick is 0, which Binance would reject.
    expect(
      resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '0' }), { currentPrice: '0.004' })),
    ).toBeUndefined();
  });

  it('returns undefined when the rounded price is below the symbol minPrice', () => {
    expect(
      resolveMakerEntryLimit(makeInput(maker({ makerOffsetBps: '0' }), { minPrice: '150' })),
    ).toBeUndefined();
  });

  it('defaults a missing offset to zero (raw worker config without the field)', () => {
    // The worker may pass a config whose execution block predates makerOffsetBps.
    const raw = { ...maker(), execution: { entryMode: 'maker' } } as TTConfig;
    expect(resolveMakerEntryLimit(makeInput(raw))).toBe('100.00');
  });
});

describe('buildFirstBuyDecision execution mode', () => {
  it('emits a MARKET buy in the default market mode', () => {
    expect(orderParams(buildFirstBuyDecision(makeInput(config()), '0.1'))).toEqual({
      type: 'MARKET',
      quantity: '0.1',
    });
  });

  it('emits a passive LIMIT GTC buy in maker mode', () => {
    expect(
      orderParams(buildFirstBuyDecision(makeInput(maker({ makerOffsetBps: '20' })), '0.1')),
    ).toEqual({ type: 'LIMIT', quantity: '0.1', price: '99.80', timeInForce: 'GTC' });
  });
});

describe('buildGridBuyDecision execution mode', () => {
  it('emits a MARKET grid buy in the default market mode', () => {
    expect(orderParams(buildGridBuyDecision(makeInput(config()), '0.1', 0))).toEqual({
      type: 'MARKET',
      quantity: '0.1',
    });
  });

  it('emits a passive LIMIT GTC grid buy in maker mode', () => {
    expect(
      orderParams(buildGridBuyDecision(makeInput(maker({ makerOffsetBps: '20' })), '0.1', 1)),
    ).toEqual({ type: 'LIMIT', quantity: '0.1', price: '99.80', timeInForce: 'GTC' });
  });

  it('keeps a configured stop-limit grid level as STOP_LOSS_LIMIT even in maker mode', () => {
    const params = orderParams(
      buildGridBuyDecision(makeInput(maker({ makerOffsetBps: '20' })), '0.1', 1, {
        stopPrice: '101',
        price: '101.5',
      }),
    );
    expect(params).toEqual({
      type: 'STOP_LOSS_LIMIT',
      quantity: '0.1',
      price: '101.5',
      stopPrice: '101',
      timeInForce: 'GTC',
    });
  });
});

describe('roundTripFeeFraction follows the execution mode', () => {
  it('uses maker buy + taker sell in maker mode (7.5 + 10 bp => 0.00175)', () => {
    expect(
      roundTripFeeFraction(
        config({ execution: { entryMode: 'maker' }, fees: { makerBps: '7.5', takerBps: '10' } }),
      ).toFixed(),
    ).toBe('0.00175');
  });

  it('is zero in maker mode when both fees are unset (raw config from the worker)', () => {
    expect(roundTripFeeFraction(maker()).toFixed()).toBe('0');
  });

  it('is zero in maker mode when the fees block is absent (raw worker config)', () => {
    const raw = {
      execution: { entryMode: 'maker' },
      sell: { forceSellMinProfitPercent: '0' },
    } as TTConfig;
    expect(roundTripFeeFraction(raw).toFixed()).toBe('0');
  });

  it('treats corrupt maker and taker fees as zero in maker mode', () => {
    const raw = {
      execution: { entryMode: 'maker' },
      fees: { makerBps: 'abc', takerBps: 'xyz' },
      sell: { forceSellMinProfitPercent: '0' },
    } as TTConfig;
    expect(roundTripFeeFraction(raw).toFixed()).toBe('0');
  });

  it('treats a zero maker fee as just the taker sell leg (0 + 10 bp => 0.001)', () => {
    expect(
      roundTripFeeFraction(
        config({ execution: { entryMode: 'maker' }, fees: { makerBps: '0', takerBps: '10' } }),
      ).toFixed(),
    ).toBe('0.001');
  });

  it('treats a zero taker fee as just the maker buy leg (5 + 0 bp => 0.0005)', () => {
    expect(
      roundTripFeeFraction(
        config({ execution: { entryMode: 'maker' }, fees: { makerBps: '5', takerBps: '0' } }),
      ).toFixed(),
    ).toBe('0.0005');
  });

  it('floors the force-sell at the maker round trip (7.5 + 10 bp => 0.175 percent)', () => {
    expect(
      effectiveForceSellMinProfitPercent(
        config({ execution: { entryMode: 'maker' }, fees: { makerBps: '7.5', takerBps: '10' } }),
      ),
    ).toBe('0.175');
  });
});
