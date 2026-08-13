import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  BINANCE_HOSTS,
  BINANCE_WS_API_HOSTS,
  BINANCE_WS_HOSTS,
  BinanceApiError,
  BinanceNonJsonBodyError,
  createBinanceRest,
  createOrderRateGovernor,
  OrderBudgetUnavailableError,
  parseOrderRateLimits,
  readSignedCallTiming,
  type CreateBinanceRestOptions,
} from '../src/index.js';
import { errorMessage } from '@app/core/error';

/** No-op sleep so the GET-retry backoff runs without wall-clock waits. */
const noSleep = (): Promise<void> => Promise.resolve();

const credentials = { apiKey: 'pub', secretKey: 'sec' } as const;
const fixedClock = { nowMs: () => 1_700_000_000_000 };

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
}

function jsonResponse(body: unknown, init: { status?: number; weight?: string } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.weight) headers.set('x-mbx-used-weight-1m', init.weight);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function makeFetchSpy(...responses: Response[]): {
  fetch: typeof fetch;
  calls: RecordedCall[];
  nth(i: number): RecordedCall;
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET') as string;
    const headers = new Headers(init?.headers ?? {});
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, headers, body, signal: init?.signal, redirect: init?.redirect });
    const r = responses[i++];
    if (!r) throw new Error(`fetch spy out of programmed responses (call ${i})`);
    return r;
  };
  return {
    fetch: fetchImpl,
    calls,
    nth(idx) {
      const c = calls[idx];
      if (!c) throw new Error(`fetch spy: no call at index ${idx} (have ${calls.length})`);
      return c;
    },
  };
}

function options(overrides: Partial<CreateBinanceRestOptions> = {}): CreateBinanceRestOptions {
  return {
    mode: 'test',
    credentials,
    fetchImpl: overrides.fetchImpl,
    clock: fixedClock,
    ...overrides,
  };
}

describe('@app/binance constants', () => {
  it('exposes the live and testnet hosts the executor relies on', () => {
    expect(BINANCE_HOSTS.live).toBe('https://api.binance.com');
    expect(BINANCE_HOSTS.test).toBe('https://testnet.binance.vision');
    expect(BINANCE_WS_HOSTS.live).toContain('stream.binance.com');
    expect(BINANCE_WS_HOSTS.test).toContain('testnet.binance.vision');
    expect(BINANCE_WS_API_HOSTS.live).toContain('ws-api.binance.com');
    expect(BINANCE_WS_API_HOSTS.test).toContain('ws-api.testnet.binance.vision');
  });
});

describe('createBinanceRest.signWsApiPayload', () => {
  it('signs apiKey + timestamp and returns a ready-to-send ws-api envelope', () => {
    const client = createBinanceRest(options());
    const payload = client.signWsApiPayload('req-1', 'userDataStream.subscribe.signature');
    expect(payload.id).toBe('req-1');
    expect(payload.method).toBe('userDataStream.subscribe.signature');
    expect(payload.params['apiKey']).toBe(credentials.apiKey);
    expect(payload.params['timestamp']).toBe(fixedClock.nowMs());
    // Signature is HMAC-SHA256(secret) over the URL-encoded params
    // string in insertion order: apiKey first (per signWsApiPayload),
    // then timestamp. Recompute and compare.
    const qs = `apiKey=${credentials.apiKey}&timestamp=${fixedClock.nowMs()}`;
    const expected = createHmac('sha256', credentials.secretKey).update(qs).digest('hex');
    expect(payload.params['signature']).toBe(expected);
  });

  it('accepts extraParams whose values coerce via toString (e.g. Decimal)', () => {
    const client = createBinanceRest(options());
    // Stand-in for a `Decimal` — anything with .toString() satisfies the
    // signature; URLSearchParams calls it during qs construction.
    const quantity = { toString: () => '0.500' };
    const payload = client.signWsApiPayload('req-2', 'order.place', { quantity });
    expect(payload.params['quantity']).toBe(quantity);
    expect(typeof payload.params['signature']).toBe('string');
    // Sig must include quantity. Recompute: extraParams are spread first
    // (so iteration order is quantity, apiKey, timestamp).
    const qs = `quantity=0.500&apiKey=${credentials.apiKey}&timestamp=${fixedClock.nowMs()}`;
    const expected = createHmac('sha256', credentials.secretKey).update(qs).digest('hex');
    expect(payload.params['signature']).toBe(expected);
  });
});

describe('createBinanceRest — request shape', () => {
  it('signs private GETs with HMAC-SHA256(secret, query) and embeds timestamp + recvWindow', async () => {
    const spy = makeFetchSpy(jsonResponse({ balances: [], canTrade: true }, { weight: '17' }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getAccount();
    expect(spy.calls).toHaveLength(1);
    const call = spy.nth(0);
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${BINANCE_HOSTS.test}/api/v3/account`);
    expect(url.searchParams.get('timestamp')).toBe('1700000000000');
    expect(url.searchParams.get('recvWindow')).toBe('5000');
    const sigQs = `recvWindow=5000&timestamp=1700000000000`;
    const expected = createHmac('sha256', 'sec').update(sigQs).digest('hex');
    expect(url.searchParams.get('signature')).toBe(expected);
    expect(call.headers.get('x-mbx-apikey')).toBe('pub');
    expect(client.ctx().weightUsed1m).toBe(17);
  });

  it('bounds every request with an abort signal so a stalled connection cannot hang the caller', async () => {
    const spy = makeFetchSpy(jsonResponse({ balances: [], canTrade: true }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getAccount();
    expect(spy.nth(0).signal).toBeInstanceOf(AbortSignal);
  });

  it('places orders as POST with form body and signature, never on the URL', async () => {
    const spy = makeFetchSpy(
      jsonResponse({ orderId: 1, clientOrderId: 'c-1', status: 'NEW' }, { weight: '5' }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '30000',
      quantity: '0.001',
      timeInForce: 'GTC',
      newClientOrderId: 'c-1',
    });
    const call = spy.nth(0);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BINANCE_HOSTS.test}/api/v3/order`);
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(call.body ?? '');
    expect(params.get('symbol')).toBe('BTCUSDT');
    expect(params.get('newClientOrderId')).toBe('c-1');
    expect(params.get('newOrderRespType')).toBe('FULL');
    expect(params.get('signature')).not.toBeNull();
  });

  it('consumes an ACK-shape placeOrder response (no status/fills) without throwing', async () => {
    const spy = makeFetchSpy(jsonResponse({ orderId: 99, clientOrderId: 'c-9' }, { weight: '5' }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const dto = await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_LOSS_LIMIT',
      price: '30000',
      stopPrice: '29900',
      quantity: '0.001',
      timeInForce: 'GTC',
      newClientOrderId: 'c-9',
    });
    expect(dto.orderId).toBe(99);
    expect(dto.clientOrderId).toBe('c-9');
    expect(dto.status).toBeUndefined();
  });

  it('queries one order as a signed GET to /api/v3/order carrying symbol + orderId, reserving weight 4', async () => {
    const spy = makeFetchSpy(
      jsonResponse(
        {
          symbol: 'BTCUSDT',
          orderId: 42,
          clientOrderId: 'c-1',
          side: 'BUY',
          type: 'LIMIT',
          price: '30000',
          origQty: '0.001',
          executedQty: '0.001',
          status: 'FILLED',
          stopPrice: '',
          time: 1,
          updateTime: 2,
          cummulativeQuoteQty: '30',
        },
        { weight: '4' },
      ),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const dto = await client.getOrder({ symbol: 'BTCUSDT', orderId: 42 });
    expect(dto.status).toBe('FILLED');
    expect(dto.executedQty).toBe('0.001');
    const call = spy.nth(0);
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${BINANCE_HOSTS.test}/api/v3/order`);
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('orderId')).toBe('42');
    expect(url.searchParams.get('signature')).not.toBeNull();
    expect(url.searchParams.get('timestamp')).toBe('1700000000000');
    expect(client.ctx().weightUsed1m).toBe(4);
  });

  it('queries one order by origClientOrderId, sending no orderId', async () => {
    // The ambiguity probe knows only the client id it generated: a placement whose
    // response was lost never yielded an exchange orderId.
    const spy = makeFetchSpy(
      jsonResponse(
        {
          symbol: 'BTCUSDT',
          orderId: 42,
          clientOrderId: 'c-1',
          side: 'BUY',
          type: 'LIMIT',
          price: '30000',
          origQty: '0.001',
          executedQty: '0',
          status: 'NEW',
          stopPrice: '',
          time: 1,
          updateTime: 2,
          cummulativeQuoteQty: '0',
        },
        { weight: '4' },
      ),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const dto = await client.getOrder({ symbol: 'BTCUSDT', origClientOrderId: 'c-1' });
    expect(dto.orderId).toBe(42);
    const url = new URL(spy.nth(0).url);
    expect(url.searchParams.get('origClientOrderId')).toBe('c-1');
    expect(url.searchParams.get('orderId')).toBeNull();
    expect(url.searchParams.get('signature')).not.toBeNull();
  });

  it('does not sign or stamp public klines requests', async () => {
    const spy = makeFetchSpy(jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 100 });
    const url = new URL(spy.nth(0).url);
    expect(url.searchParams.get('signature')).toBeNull();
    expect(url.searchParams.get('timestamp')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('reserves the flat klines weight (2) regardless of the requested limit', async () => {
    const reserved: number[] = [];
    const governor = {
      reserve: async (w: number): Promise<void> => {
        reserved.push(w);
      },
      used: () => 0,
      ceiling: () => 1_200,
    };
    const spy = makeFetchSpy(jsonResponse([]), jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, weightGovernor: governor }));
    await client.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 770 });
    await client.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 100 });
    expect(reserved).toEqual([2, 2]);
  });

  it('reserves account-wide openOrders weight (80) with no symbol, and 6 with one', async () => {
    const reserved: number[] = [];
    const governor = {
      reserve: async (w: number): Promise<void> => {
        reserved.push(w);
      },
      used: () => 0,
      ceiling: () => 1_200,
    };
    const spy = makeFetchSpy(jsonResponse([]), jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, weightGovernor: governor }));
    await client.getOpenOrders(); // account-wide → 80
    await client.getOpenOrders('BTCUSDT'); // single symbol → 6
    expect(reserved).toEqual([80, 6]);
  });

  it('reserves placeOrder and cancelOrder with order priority; bulk reads without', async () => {
    const calls: { weight: number; priority: boolean }[] = [];
    const governor = {
      reserve: async (weight: number, opts?: { priority?: boolean }): Promise<void> => {
        calls.push({ weight, priority: opts?.priority ?? false });
      },
      used: () => 0,
      ceiling: () => 1_200,
    };
    const spy = makeFetchSpy(
      jsonResponse({ orderId: 1, clientOrderId: 'c-1', status: 'NEW' }),
      jsonResponse({ orderId: 1, status: 'CANCELED' }),
      jsonResponse([]),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, weightGovernor: governor }));
    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.001',
      newClientOrderId: 'c-1',
    });
    await client.cancelOrder({ symbol: 'BTCUSDT', orderId: 1 });
    await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 1 });
    // Order placement + cancel jump the reserved band; the bulk read does not.
    expect(calls).toEqual([
      { weight: 1, priority: true },
      { weight: 1, priority: true },
      { weight: 2, priority: false },
    ]);
  });

  it('fetches the 24h ticker as an unsigned public GET carrying only the symbol', async () => {
    const spy = makeFetchSpy(
      jsonResponse({
        symbol: 'BTCUSDT',
        lastPrice: '78171.03',
        priceChange: '-420.50',
        priceChangePercent: '-0.54',
        highPrice: '79000.00',
        lowPrice: '77500.00',
        openPrice: '78591.53',
        volume: '1234.56',
        quoteVolume: '96543210.00',
      }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const ticker = await client.getTicker24hr('BTCUSDT');
    const call = spy.nth(0);
    const url = new URL(call.url);
    expect(call.method).toBe('GET');
    expect(url.origin + url.pathname).toBe(`${BINANCE_HOSTS.test}/api/v3/ticker/24hr`);
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('signature')).toBeNull();
    expect(url.searchParams.get('timestamp')).toBeNull();
    expect(ticker.lastPrice).toBe('78171.03');
    expect(ticker.priceChangePercent).toBe('-0.54');
  });

  it('fetches all-symbols 24h tickers as an unsigned GET with no symbol param', async () => {
    const spy = makeFetchSpy(
      jsonResponse([
        {
          symbol: 'BTCUSDT',
          lastPrice: '78171.03',
          priceChange: '1',
          priceChangePercent: '0.5',
          highPrice: '1',
          lowPrice: '1',
          openPrice: '1',
          volume: '1',
          quoteVolume: '1',
          bidPrice: '78170.00',
          askPrice: '78172.00',
        },
      ]),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const out = await client.getAllTickers24hr();
    const url = new URL(spy.nth(0).url);
    expect(url.origin + url.pathname).toBe(`${BINANCE_HOSTS.test}/api/v3/ticker/24hr`);
    // The all-symbols form must NOT carry a symbol (that would collapse it to the
    // single-symbol endpoint — weight 2, one ticker — silently).
    expect(url.searchParams.get('symbol')).toBeNull();
    expect(out).toHaveLength(1);
    expect(out[0]?.bidPrice).toBe('78170.00');
  });

  it('threads a caller signal through getAllTickers24hr to both the reserve and the fetch', async () => {
    const reservedSignals: (AbortSignal | undefined)[] = [];
    const governor = {
      reserve: async (_w: number, opts?: { signal?: AbortSignal }): Promise<void> => {
        reservedSignals.push(opts?.signal);
      },
      used: () => 0,
      ceiling: () => 1_200,
    };
    const spy = makeFetchSpy(jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, weightGovernor: governor }));
    const signal = AbortSignal.timeout(30_000);
    await client.getAllTickers24hr(signal);
    // The caller's deadline governs the admission wait AND the network call, so
    // a stalled rate-limit budget can't outlive the cron cycle that owns it.
    expect(reservedSignals).toEqual([signal]);
    expect(spy.nth(0).signal).toBe(signal);
  });

  it('omits undefined optional params from the query string', async () => {
    const spy = makeFetchSpy(jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getOpenOrders();
    const url = new URL(spy.nth(0).url);
    expect(url.searchParams.get('symbol')).toBeNull();
  });

  it('fetches own trades as a signed GET carrying symbol + fromId + limit', async () => {
    const spy = makeFetchSpy(
      jsonResponse(
        [
          {
            id: 42,
            orderId: 7,
            symbol: 'BTCUSDT',
            price: '30000',
            qty: '0.001',
            quoteQty: '30',
            commission: '0.00003',
            commissionAsset: 'BNB',
            time: 1_700_000_000_000,
            isBuyer: true,
            isMaker: false,
          },
        ],
        { weight: '20' },
      ),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const trades = await client.getMyTrades({ symbol: 'BTCUSDT', fromId: 41, limit: 1000 });
    const call = spy.nth(0);
    const url = new URL(call.url);
    expect(call.method).toBe('GET');
    expect(url.origin + url.pathname).toBe(`${BINANCE_HOSTS.test}/api/v3/myTrades`);
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('fromId')).toBe('41');
    expect(url.searchParams.get('limit')).toBe('1000');
    // Signed: timestamp + recvWindow + signature present.
    expect(url.searchParams.get('timestamp')).toBe('1700000000000');
    expect(url.searchParams.get('recvWindow')).toBe('5000');
    expect(url.searchParams.get('signature')).not.toBeNull();
    expect(call.headers.get('x-mbx-apikey')).toBe('pub');
    expect(trades).toHaveLength(1);
    expect(trades[0]?.orderId).toBe(7);
    expect(trades[0]?.isBuyer).toBe(true);
    expect(client.ctx().weightUsed1m).toBe(20);
  });

  it('omits fromId and limit from the myTrades query when not provided', async () => {
    const spy = makeFetchSpy(jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getMyTrades({ symbol: 'ETHUSDT' });
    const url = new URL(spy.nth(0).url);
    expect(url.searchParams.get('symbol')).toBe('ETHUSDT');
    expect(url.searchParams.get('fromId')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
    // Still signed even with no optional params.
    expect(url.searchParams.get('signature')).not.toBeNull();
  });

  it('resyncs its time offset and retries once on -1021', async () => {
    // A drifted local clock makes the first signed timestamp land outside
    // recvWindow → Binance 400/-1021. The client must resync its offset from
    // GET /api/v3/time and retry the signed call exactly once, then succeed.
    const spy = makeFetchSpy(
      jsonResponse(
        { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' },
        { status: 400 },
      ),
      jsonResponse({ serverTime: fixedClock.nowMs() + 5_000 }),
      jsonResponse({ balances: [], canTrade: true }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));

    // The signed call resolves rather than rejecting on the first -1021.
    await expect(client.getAccount()).resolves.toBeDefined();

    const urls = spy.calls.map((c) => c.url);
    // The client fetched server time to correct its offset.
    expect(urls.some((u) => u.includes('/api/v3/time'))).toBe(true);
    // The signed endpoint was issued more than once (original + retry).
    const signedCalls = urls.filter((u) => u.includes('/api/v3/account'));
    expect(signedCalls.length).toBeGreaterThan(1);
  });

  it('refuses to follow a redirect on every call, keyed or not', async () => {
    // Pinned because `redirect` reads as an incidental option. On the signed
    // call a followed redirect would replay `X-MBX-APIKEY` to whatever host the
    // hop names; on the unsigned time call it would let that host set the
    // offset added to every later signed timestamp.
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({ serverTime: fixedClock.nowMs() }),
      jsonResponse({ balances: [], canTrade: true }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));

    await expect(client.getAccount()).resolves.toBeDefined();

    expect(spy.calls.length).toBeGreaterThan(1);
    for (const call of spy.calls) {
      expect(call.redirect).toBe('error');
    }
  });

  it('applies the synced offset to the retried signed timestamp', async () => {
    // serverTime is 5s ahead of the fixed local clock; with localBefore ===
    // localAfter (the clock is fixed) the midpoint is the local instant, so
    // offset == +5000 and the retry stamps clock.nowMs() + 5000.
    const offset = 5_000;
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({ serverTime: fixedClock.nowMs() + offset }),
      jsonResponse({ balances: [], canTrade: true }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getAccount();
    // First signed attempt used the raw local clock (offset still 0).
    const first = new URL(spy.nth(0).url);
    expect(first.searchParams.get('timestamp')).toBe(String(fixedClock.nowMs()));
    // Retried attempt (third call; second is /api/v3/time) carries the offset.
    const retried = new URL(spy.nth(2).url);
    expect(retried.searchParams.get('timestamp')).toBe(String(fixedClock.nowMs() + offset));
    // And its signature matches the offset-stamped query string.
    const sigQs = `recvWindow=5000&timestamp=${fixedClock.nowMs() + offset}`;
    expect(retried.searchParams.get('signature')).toBe(
      createHmac('sha256', 'sec').update(sigQs).digest('hex'),
    );
  });

  it('propagates a persistent -1021 after exactly one resync (no infinite loop)', async () => {
    // Both signed attempts return -1021; the client resyncs once, retries once,
    // then lets the second -1021 propagate.
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({ serverTime: fixedClock.nowMs() + 5_000 }),
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(client.getAccount()).rejects.toMatchObject({
      name: 'BinanceApiError',
      status: 400,
      code: -1021,
    });
    const urls = spy.calls.map((c) => c.url);
    // Server time fetched exactly once.
    expect(urls.filter((u) => u.includes('/api/v3/time'))).toHaveLength(1);
    // Signed endpoint hit exactly twice (original + single retry).
    expect(urls.filter((u) => u.includes('/api/v3/account'))).toHaveLength(2);
  });

  it('coalesces concurrent -1021 resyncs into a single /api/v3/time fetch', async () => {
    // Two signed calls race; both get -1021 on their first attempt, both then
    // need a resync. The in-flight coalescing must collapse those to ONE
    // /api/v3/time round-trip. Responses are dispatched in call order, so the
    // two first-attempt -1021s come first, then the single /time, then the two
    // successful retries.
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({ serverTime: fixedClock.nowMs() + 5_000 }),
      jsonResponse({ balances: [], canTrade: true }),
      jsonResponse({ balances: [], canTrade: true }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const [a, b] = await Promise.all([client.getAccount(), client.getAccount()]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const urls = spy.calls.map((c) => c.url);
    expect(urls.filter((u) => u.includes('/api/v3/time'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/api/v3/account'))).toHaveLength(4);
  });

  it('rejects loudly when the -1021 resync gets a non-OK /api/v3/time response', async () => {
    // A 500 on the time fetch must throw a descriptive sync error rather than
    // letting `serverTime` be undefined and poisoning timeOffsetMs with NaN.
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({}, { status: 500 }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(client.getAccount()).rejects.toThrow('binance time sync failed: HTTP 500');

    // The offset stayed 0: a fresh signed call stamps the raw local clock, not NaN.
    const spy2 = makeFetchSpy(jsonResponse({ balances: [], canTrade: true }));
    const client2 = createBinanceRest(options({ fetchImpl: spy2.fetch }));
    await client2.getAccount();
    const ts = Number(new URL(spy2.nth(0).url).searchParams.get('timestamp'));
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBe(fixedClock.nowMs());
  });

  it('rejects loudly when the -1021 resync body lacks serverTime', async () => {
    // A 200 whose body has no numeric serverTime must throw, not compute NaN.
    const spy = makeFetchSpy(
      jsonResponse({ code: -1021, msg: 'outside recvWindow' }, { status: 400 }),
      jsonResponse({}),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(client.getAccount()).rejects.toThrow(
      'binance time sync failed: missing serverTime',
    );

    // Offset not poisoned: a fresh signed call stamps a finite local timestamp.
    const spy2 = makeFetchSpy(jsonResponse({ balances: [], canTrade: true }));
    const client2 = createBinanceRest(options({ fetchImpl: spy2.fetch }));
    await client2.getAccount();
    const ts = Number(new URL(spy2.nth(0).url).searchParams.get('timestamp'));
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBe(fixedClock.nowMs());
  });
});

describe('createBinanceRest — error taxonomy', () => {
  it('flags HTTP 429 as retryable', async () => {
    const spy = makeFetchSpy(jsonResponse({ code: -1, msg: 'too many' }, { status: 429 }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(client.getAccount()).rejects.toMatchObject({
      name: 'BinanceApiError',
      status: 429,
      retryable: true,
    });
  });

  it('flags HTTP 400 with code -2010 as non-retryable', async () => {
    const spy = makeFetchSpy(
      jsonResponse({ code: -2010, msg: 'NEW_ORDER_REJECTED' }, { status: 400 }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(
      client.placeOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.001',
        newClientOrderId: 'c-1',
      }),
    ).rejects.toMatchObject({ status: 400, code: -2010, retryable: false });
  });

  it('flags Binance code -1003 (rate-limit) as retryable even on 200-ish status', async () => {
    const spy = makeFetchSpy(jsonResponse({ code: -1003, msg: 'IP banned' }, { status: 418 }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await expect(client.getAccount()).rejects.toMatchObject({
      retryable: true,
      code: -1003,
    });
  });

  it('falls back gracefully when the error body is not JSON', async () => {
    const spy = makeFetchSpy(
      new Response('<html>504</html>', {
        status: 504,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const err = await client.getAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect((err as BinanceApiError).status).toBe(504);
    expect((err as BinanceApiError).retryable).toBe(true);
  });
});

describe('createBinanceRest — success body parse failure surfaces body excerpt', () => {
  it('wraps a 200-with-non-JSON-body parse failure with the body excerpt so the operator can diagnose without redeploying', async () => {
    const htmlBody = '<html><body>Service Unavailable</body></html>'.repeat(10);
    const r = new Response(htmlBody, {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
    });
    const spy = makeFetchSpy(r);
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const err = await client.getDustBtc().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = errorMessage(err);
    expect(msg).toMatch(/response body was not JSON/);
    expect(msg).toMatch(/\/sapi\/v1\/asset\/dust-btc/);
    expect(msg).toMatch(/Service Unavailable/);
    // Body excerpt is truncated to ~200 chars.
    expect(msg.length).toBeLessThan(800);
  });
});

describe('createBinanceRest — option defaults', () => {
  it('falls back to a real Date.now() clock when no clock is injected', async () => {
    const before = Date.now();
    const spy = makeFetchSpy(jsonResponse({ balances: [], canTrade: true }));
    // No `clock` override — exercises the default `{ nowMs: () => Date.now() }`.
    const client = createBinanceRest({ mode: 'test', credentials, fetchImpl: spy.fetch });
    await client.getAccount();
    const after = Date.now();
    const ts = Number(new URL(spy.nth(0).url).searchParams.get('timestamp'));
    // The default clock stamps a real wall-clock timestamp within the call window.
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('createBinanceRest — weight header parsing', () => {
  it('ignores a non-numeric x-mbx-used-weight-1m header', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('x-mbx-used-weight-1m', 'not-a-number');
    const r = new Response(JSON.stringify({ balances: [], canTrade: true }), {
      status: 200,
      headers,
    });
    const spy = makeFetchSpy(r);
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.getAccount();
    // Header was present but unparseable → weightUsed1m stays undefined
    // (the `Number.isFinite` false arm).
    expect(client.ctx().weightUsed1m).toBeUndefined();
  });
});

describe('createBinanceRest — ORDERS governor', () => {
  const TEN_S = 10_000;
  const ONE_D = 86_400_000;
  const orderLimits = parseOrderRateLimits([
    { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 },
    { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 100 },
    { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 200000 },
  ]);

  const orderResponse = (body: unknown, counts: Record<string, string> = {}): Response => {
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const [k, v] of Object.entries(counts)) headers.set(k, v);
    return new Response(JSON.stringify(body), { status: 200, headers });
  };

  it('charges one order for a placement, and nothing for a cancel or a read', async () => {
    const orderGovernor = createOrderRateGovernor(orderLimits);
    const spy = makeFetchSpy(
      orderResponse({ orderId: 1, clientOrderId: 'c-1', status: 'NEW' }),
      orderResponse({ orderId: 1, status: 'CANCELED' }),
      orderResponse([]),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, orderGovernor }));

    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.001',
      newClientOrderId: 'c-1',
    });
    // Binance's ORDERS budget is an UNFILLED ORDER COUNT, so a cancel spends
    // nothing — only the placement does. A weighted read is metered against
    // REQUEST_WEIGHT, not ORDERS.
    await client.cancelOrder({ symbol: 'BTCUSDT', orderId: 1 });
    await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 1 });

    expect(orderGovernor.used(TEN_S)).toBe(1);
    expect(orderGovernor.used(ONE_D)).toBe(1);
  });

  it('reconciles up to the count Binance reports, catching orders placed elsewhere', async () => {
    const orderGovernor = createOrderRateGovernor(orderLimits);
    const spy = makeFetchSpy(
      orderResponse(
        { orderId: 1, clientOrderId: 'c-1', status: 'NEW' },
        { 'x-mbx-order-count-10s': '37', 'x-mbx-order-count-1d': '900' },
      ),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, orderGovernor }));

    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.001',
      newClientOrderId: 'c-1',
    });

    // Our local tally was 1; Binance's is authoritative and higher.
    expect(orderGovernor.used(TEN_S)).toBe(37);
    expect(orderGovernor.used(ONE_D)).toBe(900);
  });

  it('ignores an unparseable order-count header rather than zeroing the tally', async () => {
    const orderGovernor = createOrderRateGovernor(orderLimits);
    const spy = makeFetchSpy(
      orderResponse(
        { orderId: 1, clientOrderId: 'c-1', status: 'NEW' },
        { 'x-mbx-order-count-10s': 'not-a-number' },
      ),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, orderGovernor }));

    await client.placeOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.001',
      newClientOrderId: 'c-1',
    });

    expect(orderGovernor.used(TEN_S)).toBe(1);
  });

  it('blocks a placement until the window rolls rather than letting Binance reject it', async () => {
    let now = 1_700_000_000_000;
    const clock = { nowMs: () => now };
    const orderGovernor = createOrderRateGovernor({
      // ceiling = floor(1 * 0.8) clamped to 1, so the second order must wait.
      windows: [{ windowMs: TEN_S, limit: 1 }],
      clock,
      sleep: async (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    const spy = makeFetchSpy(
      orderResponse({ orderId: 1, clientOrderId: 'c-1', status: 'NEW' }),
      orderResponse({ orderId: 2, clientOrderId: 'c-2', status: 'NEW' }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, orderGovernor, clock }));
    const place = (id: string): Promise<unknown> =>
      client.placeOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: '0.001',
        newClientOrderId: id,
      });

    await place('c-1');
    const startedAt = now;
    await place('c-2');

    // Deferred, never dropped: both orders reached Binance.
    expect(spy.calls).toHaveLength(2);
    expect(now - startedAt).toBe(TEN_S);
  });

  it('refuses at the ORDERS gate without spending the shared per-IP weight budget', async () => {
    // The reservation order is load-bearing and invisible to every other test
    // in this block, none of which configures a weight governor at all. Both
    // governors are consume-and-decay with no refund, and only this one can
    // refuse; charged the other way round, a placement that never leaves the
    // process still bills the per-IP bucket EVERY account on this host shares,
    // throttling all of them until it decays.
    const orderGovernor = createOrderRateGovernor({
      // Ceiling 1 on the DAY row: clearing it would take hours, far past
      // MAX_RESERVE_WAIT_MS, so the second placement refuses instead of parking.
      windows: [{ windowMs: ONE_D, limit: 1 }],
      clock: fixedClock,
      sleep: (ms: number) => Promise.reject(new Error(`unexpected sleep ${ms}`)),
    });
    let weightReserved = 0;
    const weightGovernor = {
      reserve: async () => {
        weightReserved += 1;
      },
      release: () => undefined,
    } as unknown as CreateBinanceRestOptions['weightGovernor'];
    const spy = makeFetchSpy(orderResponse({ orderId: 1, clientOrderId: 'c-1', status: 'NEW' }));
    const client = createBinanceRest(
      options({ fetchImpl: spy.fetch, orderGovernor, weightGovernor, clock: fixedClock }),
    );
    const place = (id: string): Promise<unknown> =>
      client.placeOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: '0.001',
        newClientOrderId: id,
      });

    await place('c-1');
    expect(weightReserved).toBe(1);

    await expect(place('c-2')).rejects.toBeInstanceOf(OrderBudgetUnavailableError);
    // The refusal cost nothing shared: no second weight charge, no second call.
    expect(weightReserved).toBe(1);
    expect(spy.calls).toHaveLength(1);
  });
});

describe('createBinanceRest — error body without code/msg', () => {
  it('keeps the HTTP-derived payload when the error JSON omits code and msg', async () => {
    // `{}` parses as JSON but carries neither `code` (number) nor `msg`
    // (string) — both `if` guards are false, so the payload stays the
    // status/statusText fallback rather than picking up Binance fields.
    const spy = makeFetchSpy(jsonResponse({}, { status: 500 }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const err = await client.getAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect((err as BinanceApiError).status).toBe(500);
    expect((err as BinanceApiError).code).toBe(0);
  });
});

describe('createBinanceRest — success body parse failure with a SHORT body', () => {
  it('includes the full short body (no truncation ellipsis) in the excerpt', async () => {
    // Body under 200 chars takes the non-truncating arm of the excerpt ternary.
    const shortBody = 'not json';
    const r = new Response(shortBody, {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
    });
    const spy = makeFetchSpy(r);
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const err = await client.getDustBtc().catch((e: unknown) => e);
    const msg = errorMessage(err);
    expect(msg).toMatch(/response body was not JSON/);
    expect(msg).toContain('not json');
    expect(msg).not.toContain('…');
  });
});

describe('createBinanceRest — transient GET retry (empty/non-JSON 200 + network)', () => {
  it('retries an empty-body 200 on a GET klines and returns the good response', async () => {
    const spy = makeFetchSpy(new Response('', { status: 200 }), jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, sleep: noSleep }));
    const out = await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 5 });
    expect(out).toEqual([]);
    // One empty-body attempt + one retry that succeeds.
    expect(spy.calls.length).toBe(2);
  });

  it('gives up after the bounded retries when every attempt returns an empty body', async () => {
    const spy = makeFetchSpy(
      new Response('', { status: 200 }),
      new Response('', { status: 200 }),
      new Response('', { status: 200 }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, sleep: noSleep }));
    const err = await client
      .getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceNonJsonBodyError);
    expect(errorMessage(err)).toMatch(/response body was not JSON/);
    // 1 initial + 2 retries (GET_RETRY_ATTEMPTS).
    expect(spy.calls.length).toBe(3);
  });

  it('retries a raw transient network error on a GET', async () => {
    let n = 0;
    const good = jsonResponse([]);
    const fetchImpl: typeof fetch = async () => {
      if (n++ === 0) throw new Error('fetch failed');
      return good;
    };
    const client = createBinanceRest(options({ fetchImpl, sleep: noSleep }));
    const out = await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 5 });
    expect(out).toEqual([]);
    expect(n).toBe(2);
  });

  it('uses the default real sleep between retries when none is injected', async () => {
    // No `sleep` override — exercises the default `setTimeout`-based backoff.
    const spy = makeFetchSpy(new Response('', { status: 200 }), jsonResponse([]));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const out = await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 5 });
    expect(out).toEqual([]);
    expect(spy.calls.length).toBe(2);
  });

  it('does not retry a GET whose caller deadline (signal) has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    // Empty-200 would be retried if the caller deadline had not fired.
    const spy = makeFetchSpy(new Response('', { status: 200 }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, sleep: noSleep }));
    await client.getAllTickers24hr(controller.signal).catch((e: unknown) => e);
    // Aborted caller signal → no retry, single attempt.
    expect(spy.calls.length).toBe(1);
  });

  it('does not retry a GET when a non-Error value is thrown', async () => {
    // A thrown non-Error is neither a body-parse failure nor a matchable
    // network error, so it propagates on the first attempt.
    const fetchImpl: typeof fetch = async () => {
      throw 'weird';
    };
    const client = createBinanceRest(options({ fetchImpl, sleep: noSleep }));
    await expect(client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 5 })).rejects.toBe(
      'weird',
    );
  });

  it('does NOT retry a non-JSON 200 on a POST — order-path calls stay single-shot', async () => {
    const spy = makeFetchSpy(new Response('', { status: 200 }));
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, sleep: noSleep }));
    const err = await client.getDustBtc().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BinanceNonJsonBodyError);
    // POST is not retried: the spy is hit exactly once (no second programmed response needed).
    expect(spy.calls.length).toBe(1);
  });
});

describe('createBinanceRest — dust endpoints', () => {
  it('getDustBtc POSTs the signed SAPI request and returns the parsed payload', async () => {
    const spy = makeFetchSpy(
      jsonResponse({
        details: [
          {
            asset: 'TRX',
            assetFullName: 'TRON',
            amountFree: '12.5',
            toBTC: '0.0000123',
            toBNB: '0.0011',
            toBNBOffExchange: '0.0010',
            exchange: '0.0001',
          },
        ],
        totalTransferBtc: '0.0000123',
        totalTransferBNB: '0.0011',
        dribbletPercentage: '0.02',
      }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    const res = await client.getDustBtc();
    const call = spy.nth(0);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BINANCE_HOSTS.test}/sapi/v1/asset/dust-btc`);
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const sigQs = `recvWindow=5000&timestamp=1700000000000`;
    expect(new URLSearchParams(call.body ?? '').get('signature')).toBe(
      createHmac('sha256', 'sec').update(sigQs).digest('hex'),
    );
    expect(res.details[0]?.asset).toBe('TRX');
  });

  it('convertDust expands the asset list to repeated query keys, signed in order', async () => {
    const spy = makeFetchSpy(
      jsonResponse({ totalServiceCharge: '0', totalTransfered: '0.01', transferResult: [] }),
    );
    const client = createBinanceRest(options({ fetchImpl: spy.fetch }));
    await client.convertDust(['TRX', 'XRP']);
    const call = spy.nth(0);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BINANCE_HOSTS.test}/sapi/v1/asset/dust`);
    // The signature is HMAC over the exact body string, asset keys repeated
    // in list order ahead of the appended recvWindow/timestamp.
    const sigQs = `asset=TRX&asset=XRP&recvWindow=5000&timestamp=1700000000000`;
    const body = new URLSearchParams(call.body ?? '');
    expect(body.getAll('asset')).toEqual(['TRX', 'XRP']);
    expect(body.get('signature')).toBe(createHmac('sha256', 'sec').update(sigQs).digest('hex'));
  });
});

/**
 * `BinanceApiError.phase` is the ONLY thing standing between an operator's
 * force-sell failing once and the bot placing a SECOND live market order for it.
 * The worker re-arms an override only when the order provably did not execute, and
 * it reads that proof off this field — so the field has to be right AT THE SOURCE,
 * which is the only place that can see whether Binance's answer was readable.
 *
 * These drive the real client through a real (stubbed) fetch. Asserting `phase`
 * on a hand-constructed `BinanceApiError` would only prove the constructor copies
 * its argument. `placeOrder` is the subject deliberately: it is a POST, so it is
 * single-shot (no GET retry loop), and it is the money path.
 */
describe('createBinanceRest — failure phase', () => {
  const order = {
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'MARKET',
    quantity: '0.001',
    newClientOrderId: 'c-phase',
  } as const;

  const placeAndCatch = async (response: Response): Promise<BinanceApiError> => {
    const spy = makeFetchSpy(response);
    const client = createBinanceRest(options({ fetchImpl: spy.fetch, sleep: noSleep }));
    try {
      await client.placeOrder(order);
    } catch (err) {
      return err as BinanceApiError;
    }
    throw new Error('placeOrder resolved; expected a BinanceApiError');
  };

  it('stamps a 5xx `ambiguous` even when the error body parses cleanly', async () => {
    // A readable code is NOT a refusal. Binance's own docs say a 5xx execution
    // status is unknown, so a parseable body must not downgrade the verdict.
    const err = await placeAndCatch(
      jsonResponse(
        { code: -1001, msg: 'Internal error; unable to process your request.' },
        {
          status: 503,
        },
      ),
    );
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.code).toBe(-1001);
    expect(err.phase).toBe('ambiguous');
    // Independent verdicts: the cause is transient AND the execution status is unknown.
    expect(err.retryable).toBe(true);
  });

  it('stamps a 4xx with an unreadable (non-JSON) body `ambiguous`, code 0', async () => {
    // An HTML 418/403 from a proxy or a WAF: we learned nothing, least of all
    // that Binance refused the order. Fail closed.
    const err = await placeAndCatch(
      new Response('<html><body>I am a teapot</body></html>', {
        status: 418,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(err.status).toBe(418);
    expect(err.code).toBe(0);
    expect(err.phase).toBe('ambiguous');
  });

  it('stamps a parsed 4xx rejection `rejected`', async () => {
    // -2010 with a readable body: Binance read the order, applied its rules, and
    // refused. Nothing executed, so the override may safely be re-issued.
    const err = await placeAndCatch(
      jsonResponse(
        { code: -2010, msg: 'Account has insufficient balance for requested action.' },
        { status: 400 },
      ),
    );
    expect(err.code).toBe(-2010);
    expect(err.phase).toBe('rejected');
    expect(err.retryable).toBe(false);
  });

  // The regression test for the double-order bug. These codes are documented by
  // Binance as "execution status unknown" and they arrive with NON-5xx statuses,
  // so a phase rule keyed on the HTTP status alone calls them `rejected`. -1006 and
  // -1007 are ALSO retryable, which is the lethal pair: `rejected` + `retryable`
  // re-arms the override and the next tick places a second live market order for an
  // order Binance says may already have filled.
  it.each([
    [-1000, 400, 'An unknown error occurred while processing the request.'],
    [-1001, 400, 'Internal error; unable to process your request.'],
    [
      -1006,
      400,
      'An unexpected response was received from the message bus. Execution status unknown.',
    ],
    [-1007, 400, 'Timeout waiting for response from backend server. Send status unknown.'],
    [-1008, 429, 'Server is currently overloaded with other requests.'],
  ])(
    'stamps code %i on a non-5xx status `ambiguous` (execution status unknown)',
    async (code, status, msg) => {
      const err = await placeAndCatch(jsonResponse({ code, msg }, { status }));
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.phase).toBe('ambiguous');
    },
  );
});

describe('signed-call timing on a transport failure', () => {
  it('stamps the instant the request was SIGNED — after the governor held it', async () => {
    // A caller whose response never arrived must know how long Binance can still
    // admit the request, and that window runs from the SIGNED timestamp. The weight
    // governor's admission wait sits between the call and the signing, so the
    // caller's own pre-call reading is not that instant. Without this, a placement
    // delayed by the governor is declared "never landed" while it is still
    // admissible — and the retry duplicates a live order.
    let now = 1_700_000_000_000;
    const clock = { nowMs: () => now };
    const governor = {
      reserve: async () => {
        now += 4_000; // held against the shared weight bucket
      },
      release: () => undefined,
    } as unknown as CreateBinanceRestOptions['weightGovernor'];
    const client = createBinanceRest({
      mode: 'test',
      credentials,
      clock,
      sleep: noSleep,
      ...(governor ? { weightGovernor: governor } : {}),
      fetchImpl: (async () => {
        now += 300;
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });

    const err = await client
      .placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '1' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    const timing = readSignedCallTiming(err);
    expect(timing?.signedAtLocalMs).toBe(1_700_000_004_000); // NOT the pre-call 1_700_000_000_000
    expect(timing?.timeOffsetMs).toBe(0);
  });

  it('reports no timing for a value that never carried it', () => {
    expect(readSignedCallTiming(new Error('boom'))).toBeUndefined();
    expect(readSignedCallTiming(null)).toBeUndefined();
  });
});
