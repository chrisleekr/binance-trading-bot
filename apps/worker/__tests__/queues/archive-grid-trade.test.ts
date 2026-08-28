// The fee producer every archive writer shares. Two properties are pinned here because they are decided in this one module and read by three call sites.
//
// SERIALISATION: `fees` and `feesQuote` are jsonb/text the SPA and the notifiers interpolate verbatim, so a magnitude outside decimal.js's `toExpNeg`/`toExpPos` thresholds must not cross the boundary spelled as an exponent. The thresholds are -7 and 21, which a real BNB commission clears on the small side and a low-unit-price coin's cumulative quote fee clears on the large side.
//
// THIRD-ASSET VALUATION: a commission charged in neither the base nor the quote asset has no execution-time rate anywhere in `myTrades`, and today it is simply left unpriced. The per-symbol commission-rate endpoint is what makes it recoverable: the charge is reconstructed from the rates Binance itself applied, never valued at a current ticker, which would price a months-old fill at today's market.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { isPlainDecimalString } from '@app/money';
import type { BinanceRestClient, MyTradeDto } from '@app/binance';

import {
  createCommissionRateResolver,
  parseCommissionRates,
  resolveFeesFromTrades,
  resolveFeesFromTradesWithRates,
} from '../../src/queues/pipeline-handlers/archive-grid-trade.js';

const SYMBOL = 'BTCUSDT';
const BASE = 'BTC';
const QUOTE = 'USDT';

const myTrade = (o: {
  orderId: number;
  commission: string;
  commissionAsset: string;
  id?: number;
  price?: string;
  qty?: string;
  quoteQty?: string;
  isBuyer?: boolean;
  isMaker?: boolean;
}): MyTradeDto =>
  ({
    id: o.id ?? o.orderId * 10,
    orderId: o.orderId,
    symbol: SYMBOL,
    price: o.price ?? '100',
    qty: o.qty ?? '1',
    quoteQty: o.quoteQty ?? '100',
    commission: o.commission,
    commissionAsset: o.commissionAsset,
    time: 0,
    isBuyer: o.isBuyer ?? false,
    isMaker: o.isMaker ?? false,
  }) as MyTradeDto;

const expectedOrder = (
  orderId: number,
  overrides: Partial<{
    side: 'BUY' | 'SELL';
    executedQty: string;
    cummulativeQuoteQty: string;
    baseCommissionNetted: string | null;
  }> = {},
) => ({
  binanceOrderId: String(orderId),
  side: 'SELL' as const,
  executedQty: '1',
  cummulativeQuoteQty: '100',
  baseCommissionNetted: null,
  ...overrides,
});

type RateSet = { maker: string; taker: string; buyer: string; seller: string };
const ZERO_RATES: RateSet = { maker: '0', taker: '0', buyer: '0', seller: '0' };

/**
 * Builds a `GET /api/v3/account/commission` payload in Binance's own shape so the parser is exercised against the wire form rather than against an internal struct.
 *
 * @param over - Members to replace; the defaults charge a flat 0.1% on the taker and seller legs with a 25%-off BNB discount, which is the ordinary retail configuration.
 * @returns An untyped payload equivalent to what the endpoint returns.
 */
const commissionPayload = (
  over: Partial<{
    standardCommission: Partial<RateSet>;
    taxCommission: Partial<RateSet>;
    specialCommission: Partial<RateSet>;
    discount: Record<string, unknown>;
  }> = {},
): unknown => ({
  symbol: SYMBOL,
  standardCommission: { ...ZERO_RATES, taker: '0.001', ...over.standardCommission },
  taxCommission: { ...ZERO_RATES, ...over.taxCommission },
  specialCommission: { ...ZERO_RATES, ...over.specialCommission },
  discount: {
    enabledForAccount: true,
    enabledForSymbol: true,
    discountAsset: 'BNB',
    discount: '0.75',
    ...over.discount,
  },
});

/**
 * Parses a payload and fails the test rather than handing `null` on to an assertion that would then read as a passing "unpriced" case.
 *
 * @param raw - The commission payload under test.
 * @returns The parsed rates, never null.
 */
const mustParse = (raw: unknown): NonNullable<ReturnType<typeof parseCommissionRates>> => {
  const parsed = parseCommissionRates(raw);
  if (parsed === null) throw new Error('fixture did not parse as commission rates');
  return parsed;
};

const silentLogger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;

describe('archive fee serialisation stays in plain decimal notation', () => {
  it('writes a commission total below 1e-7 as plain text', () => {
    // The real shape: a 0.00000001 BNB commission is what a small fill on a discounted account actually produces, and `Decimal#toString()` spells it `1e-8`. The archive row is read straight into a table cell, where an exponent beside a column of fixed decimals reads as a corrupted value.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '0.00000001', commissionAsset: 'BNB' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      null,
    );
    expect(resolved.fees['BNB']).toBe('0.00000001');
    expect(isPlainDecimalString(resolved.fees['BNB'] ?? '')).toBe(true);
  });

  it('writes a quote subtotal at or above 1e21 as plain text', () => {
    // The other threshold, and reachable without absurd inputs on a sub-cent coin whose cumulative quote fees run into many digits. `toString()` yields `1e+21`.
    const huge = '1000000000000000000000';
    const resolved = resolveFeesFromTrades(
      [
        myTrade({
          orderId: 1,
          commission: huge,
          commissionAsset: QUOTE,
          quoteQty: '100',
        }),
      ],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      null,
    );
    expect(resolved.feesQuote).toBe(huge);
    expect(isPlainDecimalString(resolved.feesQuote)).toBe(true);
    expect(resolved.fees[QUOTE]).toBe(huge);
    expect(isPlainDecimalString(resolved.fees[QUOTE] ?? '')).toBe(true);
  });
});

describe('third-asset commission valuation by rate reconstruction', () => {
  it('multiplies the standard legs by the discount rather than subtracting it', () => {
    // The single most consequential reading in this feature. `rest-api.md`'s prose calls the field a rate the commission is "reduced by"; the commission FAQ's arithmetic multiplies by it, and the endpoint's own example ships `0.75`. The two readings differ threefold on a real fill, so the wrong one silently understates every archived net P/L on a BNB-paying account.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB', quoteQty: '100' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(commissionPayload()),
    );
    // 100 quote notional x 0.001 taker+seller x 0.75 discount.
    expect(resolved.feesQuote).toBe('0.075');
    // Pinned explicitly: `1 - discount` is the reading the endpoint prose invites, it is arithmetically well-formed, and nothing else in this suite would separate it from the correct one.
    expect(resolved.feesQuote).not.toBe('0.025');
    expect(resolved.unpricedTrades).toBe(0);
    // Priced, and still a reconstruction. The commission was recovered from a rate table read at archive time, and no property of the archive can date that table to the fill: the window bounds each order's LAST fill, while every tranche of that order is valued here, so a resting order that first filled days earlier sits inside an arbitrarily narrow window. `exact` is reserved for a total every commission evidenced itself.
    expect(resolved.feeBasis).toBe('estimated');
  });

  it('leaves the tax component undiscounted', () => {
    // The FAQ applies the discount to the standard commission alone. Folding tax into the discounted sum understates the charge on every jurisdiction that levies one, and the error is invisible because both spellings produce a plausible number.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB', quoteQty: '100' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(commissionPayload({ taxCommission: { taker: '0.0005' } })),
    );
    // 100 x (0.001 x 0.75) + 100 x 0.0005.
    expect(resolved.feesQuote).toBe('0.125');
    // What discounting the tax leg too would produce.
    expect(resolved.feesQuote).not.toBe('0.1125');
  });

  it('applies no discount when Binance charged in an asset other than the discount asset', () => {
    // The asset Binance actually charged in is direct evidence of whether the discount was taken on THIS fill. The `enabledForAccount`/`enabledForSymbol` flags are account state read now and can disagree with a fill recorded before the operator toggled them.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '5', commissionAsset: 'DOGE', quoteQty: '100' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(commissionPayload()),
    );
    expect(resolved.feesQuote).toBe('0.1');
  });

  it('selects the maker and buyer legs on a maker BUY', () => {
    // `isMaker` picks maker/taker and `isBuyer` picks buyer/seller, and the four legs carry different rates on a real account. There is deliberately no BUY/SELL branch in the arithmetic — a BUY's commission is denominated in base so its quote value is `qty x rate x price`, and `quoteQty = qty x price` — so this row is what proves the leg SELECTION happens even though the expression does not fork.
    const resolved = resolveFeesFromTrades(
      [
        myTrade({
          orderId: 1,
          commission: '0.001',
          commissionAsset: 'BNB',
          quoteQty: '100',
          isBuyer: true,
          isMaker: true,
        }),
      ],
      [expectedOrder(1, { side: 'BUY' })],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(
        commissionPayload({
          standardCommission: { maker: '0.0002', taker: '0.001', buyer: '0.0003', seller: '0' },
        }),
      ),
    );
    // 100 x (0.0002 maker + 0.0003 buyer) x 0.75.
    expect(resolved.feesQuote).toBe('0.0375');
    // The taker/seller legs, which is what a leg selection stuck on one pair would produce.
    expect(resolved.feesQuote).not.toBe('0.075');
  });

  it('refuses an all-zero rate table rather than valuing a real commission at nothing', () => {
    // The worst outcome this feature can produce, and it is reachable: the endpoint reports CURRENT rates while reconcile and backfill value HISTORIC fills, so an account moved to a zero-fee tier since the trade answers with zeroes. Valued anyway, the row would carry a positive BNB commission in `fees` beside a zero quote adjustment and be stamped complete — evidence contradicting itself, and permanent, because reconciliation only re-admits rows whose marker is false.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB', quoteQty: '100' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(
        commissionPayload({
          standardCommission: { ...ZERO_RATES },
          taxCommission: { ...ZERO_RATES },
          specialCommission: { ...ZERO_RATES },
        }),
      ),
    );
    expect(resolved.unpricedTrades).toBe(1);
    expect(resolved.feeBasis).toBe('unknown');
    expect(resolved.feesQuote).toBe('0');
    // The commission itself is still preserved; refusing to VALUE it is not refusing to record it.
    expect(resolved.fees['BNB']).toBe('0.001');
  });

  it.each([
    ['the fill states no maker flag', 'isMaker'],
    ['the fill states no quote notional', 'quoteQty'],
  ])('leaves the commission unpriced when %s, even with rates in hand', (_label, missing) => {
    // Rates ARE supplied here, so only the missing-field disjunct can decide the outcome. Without such a case that disjunct is never the reason for a refusal, and relaxing it to a default — `isMaker ?? false` values every such fill at the taker leg — would write a wrong money figure certified as exact while the suite stayed green.
    const trade = myTrade({
      orderId: 1,
      commission: '0.001',
      commissionAsset: 'BNB',
      quoteQty: '100',
    }) as unknown as Record<string, unknown>;
    delete trade[missing];
    const resolved = resolveFeesFromTrades(
      [trade],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      mustParse(commissionPayload()),
    );
    expect(resolved.unpricedTrades).toBe(1);
    expect(resolved.feeBasis).toBe('unknown');
    // Explicitly NOT the taker-leg figure a lenient default would have produced.
    expect(resolved.feesQuote).not.toBe('0.075');
    expect(resolved.feesQuote).toBe('0');
  });

  it('leaves the commission unpriced and the row incomplete when no rates resolved', () => {
    // Byte-for-byte today's behaviour, which is what makes an unsupported endpoint a no-op rather than a regression. Nothing substitutes a ticker: a current price would value a months-old fill at today's market and quietly fabricate the number the completeness marker exists to guarantee.
    const resolved = resolveFeesFromTrades(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      null,
    );
    expect(resolved.feesQuote).toBe('0');
    expect(resolved.unpricedTrades).toBe(1);
    expect(resolved.feeBasis).toBe('unknown');
    expect(resolved.fees['BNB']).toBe('0.001');
  });
});

describe('parseCommissionRates fails closed', () => {
  it.each([
    ['a null body', null],
    ['a non-object body', 42],
    [
      'no standardCommission',
      { ...(commissionPayload() as object), standardCommission: undefined },
    ],
    ['no taxCommission', { ...(commissionPayload() as object), taxCommission: undefined }],
    ['no specialCommission', { ...(commissionPayload() as object), specialCommission: undefined }],
    ['no discount block', { ...(commissionPayload() as object), discount: undefined }],
    [
      'a numeric rate instead of a string',
      commissionPayload({ standardCommission: { taker: 0.001 as unknown as string } }),
    ],
    ['an unparseable rate', commissionPayload({ standardCommission: { taker: 'not-a-number' } })],
    ['a negative rate', commissionPayload({ standardCommission: { taker: '-0.001' } })],
    ['an unparseable discount', commissionPayload({ discount: { discount: 'free' } })],
    // The percent spelling of 0.25. Accepted, it multiplies the standard legs twenty-five-fold and stamps the row complete on the result.
    ['a discount above 1', commissionPayload({ discount: { discount: '25' } })],
    // A commission larger than the whole trade is not a rate this code understands.
    ['a rate above 1', commissionPayload({ standardCommission: { taker: '2' } })],
    ['a non-string discount asset', commissionPayload({ discount: { discountAsset: 7 } })],
  ])('returns null for %s', (_label, raw) => {
    // Fail-closed is the whole safety argument: null rates route the third-asset arm back to "unpriced", which increments `unpricedTrades` and holds `feeBasis` at `unknown`. A partially-parsed rate set would instead write a confidently wrong number and mark it complete.
    expect(parseCommissionRates(raw)).toBeNull();
  });

  it('accepts the endpoint payload as documented', () => {
    // The positive control. Without it every negative row above could pass because the parser rejects everything.
    expect(parseCommissionRates(commissionPayload())).not.toBeNull();
  });
});

describe('resolveFeesFromTradesWithRates fetches rates only when one is needed', () => {
  it('never asks for rates when every commission priced itself', async () => {
    // Weight 20 per symbol, on a cycle that runs constantly. The ordinary archive charges nothing extra because a quote-asset or base-asset commission carries its own valuation evidence.
    const fetchRates = vi.fn(async () => mustParse(commissionPayload()));
    const resolved = await resolveFeesFromTradesWithRates(
      [myTrade({ orderId: 1, commission: '0.5', commissionAsset: QUOTE })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      fetchRates,
    );
    expect(fetchRates).not.toHaveBeenCalled();
    expect(resolved.feesQuote).toBe('0.5');
    expect(resolved.feeBasis).toBe('exact');
  });

  it('re-runs the resolution with rates once an unpriced commission appears', async () => {
    // Parameter named so the spy records the argument the wrapper passed; that is the half proving the fetch was scoped to THIS archive's symbol rather than to whatever the caller last looked at.
    const fetchRates = vi.fn(async (_symbol: string) => mustParse(commissionPayload()));
    const resolved = await resolveFeesFromTradesWithRates(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB', quoteQty: '100' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      fetchRates,
    );
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates.mock.calls[0]?.[0]).toBe(SYMBOL);
    expect(resolved.feesQuote).toBe('0.075');
    // The second pass is the whole signal: reaching for the table at all is what makes the total a reconstruction, so the wrapper cannot return the tier its rate-free first pass would have.
    expect(resolved.feeBasis).toBe('estimated');
  });

  it('keeps the row incomplete when the fetch produced no rates', async () => {
    const fetchRates = vi.fn(async () => null);
    const resolved = await resolveFeesFromTradesWithRates(
      [myTrade({ orderId: 1, commission: '0.001', commissionAsset: 'BNB' })],
      [expectedOrder(1)],
      SYMBOL,
      BASE,
      QUOTE,
      fetchRates,
    );
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(resolved.feesQuote).toBe('0');
    expect(resolved.feeBasis).toBe('unknown');
  });
});

describe('createCommissionRateResolver', () => {
  const clientWith = (
    impl: () => Promise<unknown>,
  ): { client: BinanceRestClient; spy: ReturnType<typeof vi.fn> } => {
    const spy = vi.fn(impl);
    return { client: { getCommissionRates: spy } as unknown as BinanceRestClient, spy };
  };

  it('asks Binance once per symbol and reuses the answer for the rest of the job', async () => {
    // A reconcile pass walks up to 500 rows. Without the memo each row on the same symbol spends another weight-20 call for a value that cannot change inside one job.
    const { client, spy } = clientWith(async () => commissionPayload());
    const resolve = createCommissionRateResolver(client, silentLogger);
    const first = await resolve(SYMBOL);
    const second = await resolve(SYMBOL);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(SYMBOL);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('fetches separately for a second symbol', async () => {
    // The memo is per symbol, not per job: sharing one entry across symbols would price every row at the first symbol's rates.
    const { client, spy } = clientWith(async () => commissionPayload());
    const resolve = createCommissionRateResolver(client, silentLogger);
    await resolve(SYMBOL);
    await resolve('ETHUSDT');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers null and caches it when the endpoint rejects', async () => {
    // Fail-closed and once. A testnet deployment where this endpoint is unsupported must degrade to today's unpriced behaviour, and must not re-attempt per row on a pass that already knows the answer.
    const { client, spy } = clientWith(async () => {
      throw new Error('-1121 Invalid symbol');
    });
    const resolve = createCommissionRateResolver(client, silentLogger);
    expect(await resolve(SYMBOL)).toBeNull();
    expect(await resolve(SYMBOL)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers null and caches it when the endpoint returns a body it cannot parse', async () => {
    // The path a deployment that does not serve this endpoint actually takes — an HTML error page parsed leniently, or a payload missing a member. A refusal that is not memoised costs a weight-20 call per row across a 500-row reconcile pass.
    const { client, spy } = clientWith(async () => ({ symbol: SYMBOL }));
    const resolve = createCommissionRateResolver(client, silentLogger);
    expect(await resolve(SYMBOL)).toBeNull();
    expect(await resolve(SYMBOL)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
