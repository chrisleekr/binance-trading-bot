import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { AccountSnapshot, Candle, Clock, OrderParams, OrderSide } from '@app/strategy-core';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import type { FillInput, FillPhase } from '../src/types.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const clock: Clock = { nowMs: () => 1_000 };

function bar(low: string, high: string, open = low, close = high): Candle {
  return { openTimeMs: 0, closeTimeMs: 999, open, high, low, close, volume: '1', isClosed: true };
}

/** Bar with an explicit base volume, for the volume-participation-cap tests. */
function barVol(volume: string, low: string, high: string, open = low, close = high): Candle {
  return { openTimeMs: 0, closeTimeMs: 999, open, high, low, close, volume, isClosed: true };
}

function account(usdt: string, btc = '0'): AccountSnapshot {
  return {
    balances: {
      USDT: { asset: 'USDT', free: new Decimal(usdt), locked: new Decimal(0) },
      BTC: { asset: 'BTC', free: new Decimal(btc), locked: new Decimal(0) },
    },
  };
}

function input(args: {
  side: OrderSide;
  params: OrderParams;
  detail: Candle[];
  phase?: FillPhase;
  acct?: AccountSnapshot;
  symbolInfo?: typeof SYMBOL_INFO;
}): FillInput {
  const last = args.detail[0] ?? bar('100', '100');
  return {
    intent: { symbol: SYMBOL, side: args.side, reason: 'manual', clientOrderId: 'c1' },
    params: args.params,
    market: { lastPrice: new Decimal(last.close), lastCandle: last, detailCandles: args.detail },
    account: args.acct ?? account('100000', '10'),
    symbolInfo: args.symbolInfo ?? SYMBOL_INFO,
    clock,
    phase: args.phase ?? 'resting',
  };
}

const model = new OhlcvFillModel({ makerBps: 10, takerBps: 20, slippageBps: 50 });

describe('OhlcvFillModel', () => {
  it('rests on placement (never fills the candle the order was placed on)', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('90', '110')],
        phase: 'place',
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('fills a BUY LIMIT at the limit when a detail bar dips to it', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('95', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('100');
      expect(out.fills[0]?.feeBps).toBe(10); // maker
    }
  });

  it('keeps resting a BUY LIMIT that has not been reached', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('101', '110')],
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('does NOT fill a BUY LIMIT that only touches the limit (queue non-fill — trade-through required)', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('100', '110')], // low == limit: kissed, not traded through
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('does NOT fill a SELL LIMIT that only touches the limit', () => {
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'LIMIT', price: '110', quantity: '1' },
        detail: [bar('100', '110')], // high == limit: kissed, not traded through
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('skips a bar that only touches the BUY limit and fills on a later piercing bar', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('100', '110'), bar('95', '105')], // touch, then trade-through
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('100');
  });

  it('fills a SELL LIMIT when a detail bar rises to it', () => {
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'LIMIT', price: '110', quantity: '1' },
        detail: [bar('100', '115')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('110');
  });

  it('fills a MARKET BUY at the candle open plus slippage with taker fee', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'MARKET', quantity: '1' },
        detail: [bar('90', '110', '100', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('100.5'); // 100 * (1 + 50bps)
      expect(out.fills[0]?.feeBps).toBe(20); // taker
    }
  });

  it('fills a MARKET SELL at open minus slippage', () => {
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'MARKET', quantity: '1' },
        detail: [bar('90', '110', '100', '105')],
      }),
    );
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('99.5');
    else throw new Error('expected fill');
  });

  it('fills a SELL stop-limit at its limit once armed and the limit is crossed', () => {
    // The stop 90 arms when a bar's low reaches it; the limit 89 then fills the
    // first time a bar trades through it. A stop-limit fills AT its limit with no
    // slippage (a limit fills at its rate, not a market-style haircut), taker fee.
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('85', '95', '92')], // low 85 <= stop 90 (armed); high 95 > limit 89 (crossed)
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('89'); // the limit, no slippage
      expect(out.fills[0]?.feeBps).toBe(20); // taker
    }
  });

  it('keeps resting a SELL stop whose low has not reached the stop', () => {
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('91', '95', '93')], // low 91 > stop 90
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('keeps a SELL stop-limit resting when the bar gaps entirely below its limit', () => {
    // The stop 90 arms (low reaches it) but the limit sell at 89 cannot fill when
    // the whole bar trades below 89 — the position is NOT protected. Modelling
    // this as a guaranteed stop-market fill would hide the dominant tail risk.
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('75', '85', '80')], // low 75 <= stop (armed); high 85 < limit 89 (never crosses)
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('rejects a sub-minNotional order', () => {
    const strict = { ...SYMBOL_INFO, filters: { ...SYMBOL_INFO.filters, minNotional: '1000' } };
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '0.5' }, // notional 50 < 1000
        detail: [bar('90', '110')],
        symbolInfo: strict,
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'min-notional' });
  });

  it('rejects a BUY the quote balance cannot fully fund (-2010), not a partial', () => {
    // Binance rejects an underfunded order outright; it does not silently shrink
    // it. Only the volume cap turns a full order into a partial.
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '5' }, // wants 5 BTC = 500 USDT + fee
        detail: [bar('95', '105')],
        acct: account('200'), // only 200 USDT — cannot fund the full order
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'insufficient-balance' });
  });

  it('rejects a SELL larger than the held base', () => {
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'LIMIT', price: '110', quantity: '5' },
        detail: [bar('100', '115')],
        acct: account('0', '2'), // only 2 BTC held — cannot deliver 5
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'insufficient-balance' });
  });

  it('rejects a MARKET BUY the quote cannot fund at the fill price', () => {
    // A MARKET buy has no order price, so the -2010 check falls back to the fill
    // price (open + slippage). Fill ~100.5 for 1 BTC > 50 free → rejected whole,
    // exercising the orderPx-undefined branch of canFundAtOrderPrice.
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'MARKET', quantity: '1' },
        detail: [bar('95', '105', '100')], // open 100 → fill price ~100.5
        acct: account('50'), // 50 USDT — cannot fund
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'insufficient-balance' });
  });

  it('shrinks an all-in BUY to a partial under the spread haircut, not a rejection', () => {
    // Funded at the order price (100 * 1 = 100 <= 100 free) but the 50bps
    // half-spread lifts the fill to 100.5, so the last sliver cannot fill: the
    // order partials rather than rejecting as a false -2010. A live limit buy
    // fills at the limit, so a whole rejection here would be wrong.
    const spreadOnly = new OhlcvFillModel({
      makerBps: 0,
      takerBps: 0,
      slippageBps: 0,
      spreadBps: 100,
    });
    const out = spreadOnly.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('95', '105')],
        acct: account('100'), // exactly the order-price notional
      }),
    );
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') {
      expect(new Decimal(out.fills[0]?.qty ?? '0').lt(1)).toBe(true);
      expect(out.remainingQty.gt(0)).toBe(true);
    }
  });

  it('fills a BUY stop-limit at its limit once armed and the limit is crossed', () => {
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '110', price: '111', quantity: '1' },
        detail: [bar('100', '115', '100')], // high 115 >= stop 110 (armed); low 100 < limit 111 (crossed)
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('111'); // the limit, no slippage
      expect(out.fills[0]?.feeBps).toBe(20); // taker
    }
  });

  it('keeps a BUY stop-limit resting when the bar gaps entirely above its limit', () => {
    // A grid stop-limit arms (high reaches the stop) but its limit buy at 111
    // cannot fill when the whole bar trades above 111 — the entry is missed, not
    // booked at the gapped-up price a stop-market model would have filled.
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '110', price: '111', quantity: '1' },
        detail: [bar('118', '125', '120')], // high 125 >= stop (armed); low 118 > limit 111 (never crosses)
      }),
    );
    expect(out.kind).toBe('rest');
  });

  it('fills a stop-limit at its limit regardless of slippageBps (a limit fills at its rate)', () => {
    // Unlike a MARKET order, a triggered limit is not slippaged: a large
    // slippageBps must not move the fill off the limit price.
    const hiSlip = new OhlcvFillModel({ makerBps: 10, takerBps: 20, slippageBps: 500 });
    const out = hiSlip.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('75', '95', '80')], // armed (low<=90), crossed (high 95 > 89)
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('89');
  });

  it('arms from the FIRST bar that reaches the stop, then fills at the limit', () => {
    // bar[0] low 92 > stop 90 (no arm); bar[1] low 80 <= stop (arms) and high 90
    // > limit 89 (crosses). Proves firstStopBar picks bar[1], then the limit fills.
    const out = model.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('92', '95', '94'), bar('80', '90', '85')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('89');
  });

  it('rejects when the rounded quantity falls below minQty', () => {
    const strict = {
      ...SYMBOL_INFO,
      filters: { ...SYMBOL_INFO.filters, minQty: '1', stepSize: '1' },
    };
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '0.5' }, // floors to 0 at step 1
        detail: [bar('90', '110')],
        symbolInfo: strict,
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected' });
  });

  it('picks the first crossing detail bar (grid ordering)', () => {
    // limit 100; first bar does not reach, second does
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('101', '110'), bar('98', '102')],
      }),
    );
    expect(out.kind).toBe('filled');
  });
});

describe('OhlcvFillModel half-spread haircut', () => {
  // spreadBps 100 → half-spread 50bps = 0.005. slippage isolated to 0 so the
  // spread effect is the only price move, including on the maker LIMIT path.
  const spread = new OhlcvFillModel({ makerBps: 10, takerBps: 20, slippageBps: 0, spreadBps: 100 });

  it('lifts a BUY LIMIT fill by the half-spread', () => {
    const out = spread.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [bar('95', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('100.5'); // 100 * (1 + 50bps)
      expect(out.fills[0]?.feeBps).toBe(10); // still maker — spread is not a fee
    }
  });

  it('cuts a SELL LIMIT fill by the half-spread', () => {
    const out = spread.fill(
      input({
        side: 'SELL',
        params: { type: 'LIMIT', price: '110', quantity: '1' },
        detail: [bar('100', '115')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('109.45'); // 110 * (1 - 50bps)
  });

  it('stacks the half-spread on top of slippage for a MARKET BUY', () => {
    // open 100 → slippage 50bps then spread 50bps: 100 * 1.005 * 1.005.
    const both = new OhlcvFillModel({
      makerBps: 10,
      takerBps: 20,
      slippageBps: 50,
      spreadBps: 100,
    });
    const out = both.fill(
      input({
        side: 'BUY',
        params: { type: 'MARKET', quantity: '1' },
        detail: [bar('90', '110', '100', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('101.0025');
  });

  it('subtracts both slippage and the half-spread on a MARKET SELL', () => {
    // open 100 → slippage 50bps then spread 50bps, both DOWN: 100 * 0.995 * 0.995.
    const both = new OhlcvFillModel({
      makerBps: 10,
      takerBps: 20,
      slippageBps: 50,
      spreadBps: 100,
    });
    const out = both.fill(
      input({
        side: 'SELL',
        params: { type: 'MARKET', quantity: '1' },
        detail: [bar('90', '110', '100', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.price.toString()).toBe('99.0025');
  });

  it('applies the half-spread to a stop-limit fill (at the limit, no slippage)', () => {
    // Armed and crossed; fills at the limit 89 cut by the 50bps half-spread:
    // 89 * 0.995 = 88.555. No slippage — a limit is not market-slippaged.
    const out = spread.fill(
      input({
        side: 'SELL',
        params: { type: 'STOP_LOSS_LIMIT', stopPrice: '90', price: '89', quantity: '1' },
        detail: [bar('75', '95', '80')], // armed (low<=90), crossed (high 95 > limit 89)
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') {
      expect(out.fills[0]?.price.toString()).toBe('88.555');
      expect(out.fills[0]?.feeBps).toBe(20); // taker
    }
  });
});

describe('OhlcvFillModel volume-participation cap', () => {
  // 25% of the filling bar's base volume per fill.
  const capped = new OhlcvFillModel({
    makerBps: 10,
    takerBps: 20,
    slippageBps: 0,
    volumeCapPct: 25,
  });

  it('partially fills when the order exceeds the bar-volume cap', () => {
    // bar volume 10, cap 25% → 2.5; order wants 5.
    const out = capped.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '5' },
        detail: [barVol('10', '95', '105')],
      }),
    );
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') {
      expect(out.fills[0]?.qty.toString()).toBe('2.5');
      expect(out.remainingQty.toString()).toBe('2.5');
    }
  });

  it('fills fully when the order sits under the cap', () => {
    // bar volume 10, cap 2.5; order wants 1 — cap does not bite.
    const out = capped.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [barVol('10', '95', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.qty.toString()).toBe('1');
  });

  it('rejects with liquidity on a zero-volume bar', () => {
    const out = capped.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '1' },
        detail: [barVol('0', '95', '105')],
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'liquidity' });
  });

  it('rejects with liquidity (not min-notional) when the cap shrinks below minNotional', () => {
    // cap 25% of volume 0.001 = 0.00025; at price 100 the notional is 0.025,
    // below a 1000 minNotional. The cap is the binding constraint → liquidity.
    const strict = { ...SYMBOL_INFO, filters: { ...SYMBOL_INFO.filters, minNotional: '1000' } };
    const out = capped.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '5' },
        detail: [barVol('0.001', '95', '105')],
        symbolInfo: strict,
      }),
    );
    expect(out).toMatchObject({ kind: 'rejected', reason: 'liquidity' });
  });

  it('leaves fills unchanged when no cap is configured', () => {
    // The default `model` has no volumeCapPct: a tiny-volume bar still fills full.
    const out = model.fill(
      input({
        side: 'BUY',
        params: { type: 'LIMIT', price: '100', quantity: '5' },
        detail: [barVol('0.001', '95', '105')],
      }),
    );
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.fills[0]?.qty.toString()).toBe('5');
  });

  it('caps a SELL the same way (held base is enough; volume is the binding limit)', () => {
    // account holds 10 BTC; bar volume 10, cap 2.5; order wants 5 → volume, not
    // balance, forces the partial.
    const out = capped.fill(
      input({
        side: 'SELL',
        params: { type: 'LIMIT', price: '110', quantity: '5' },
        detail: [barVol('10', '100', '115')],
      }),
    );
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') {
      expect(out.fills[0]?.qty.toString()).toBe('2.5');
      expect(out.remainingQty.toString()).toBe('2.5');
    }
  });

  it('caps a MARKET fill too, returning the remainder to work across later bars', () => {
    // The cap applies to a market order, not just resting limits: open 100,
    // volume 10, cap 2.5; market wants 5 → partial 2.5, the executor re-rests 2.5.
    const out = capped.fill(
      input({
        side: 'BUY',
        params: { type: 'MARKET', quantity: '5' },
        detail: [barVol('10', '90', '110', '100', '105')],
      }),
    );
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') {
      expect(out.fills[0]?.qty.toString()).toBe('2.5');
      expect(out.fills[0]?.price.toString()).toBe('100'); // open, no slippage/spread on this model
      expect(out.remainingQty.toString()).toBe('2.5');
    }
  });
});

describe('OhlcvFillModel — exchange-native trailing stop', () => {
  const params: OrderParams = { type: 'STOP_LOSS', quantity: '1', trailingDelta: 1551 };

  it('refuses to fill a STOP_LOSS rather than pricing it at zero', () => {
    // The trigger is exchange-side state — a high-water mark that starts when the
    // order reaches Binance — and this replay has no way to reproduce it. The
    // fill path derives a price from `price ?? stopPrice ?? '0'`, so a silent
    // pass would sell the whole position at zero and report the loss as strategy
    // performance.
    expect(() => model.fill(input({ side: 'SELL', params, detail: [bar('90', '110')] }))).toThrow(
      /STOP_LOSS/,
    );
  });

  it('refuses to reserve for one as well, so the failure cannot be reached half-way', () => {
    expect(() =>
      model.reserve({
        intent: { symbol: SYMBOL, side: 'SELL', reason: 'protective-stop', clientOrderId: 'c1' },
        params,
        symbolInfo: SYMBOL_INFO,
      }),
    ).toThrow(/not supported/);
  });
});
