import { describe, expect, it, vi } from 'vitest';

import {
  EXCHANGE_INFO_CACHE_TTL_SECONDS,
  EXCHANGE_INFO_REDIS_KEY,
  loadOrFetchExchangeInfo,
  type ExchangeInfoStore,
} from '../../src/routes/exchange-info.js';

const upstreamSample = {
  timezone: 'UTC',
  serverTime: 0,
  symbols: [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }],
      permissionSets: [['SPOT', 'MARGIN']],
      orderTypes: ['LIMIT'],
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: [],
      orderTypes: [],
    },
  ],
};

const makeStore = (): {
  store: ExchangeInfoStore;
  raw: Map<string, string>;
  ttl: { key: string; seconds: number } | null;
} => {
  const raw = new Map<string, string>();
  let ttl: { key: string; seconds: number } | null = null;
  const store: ExchangeInfoStore = {
    get: async (key) => raw.get(key) ?? null,
    set: async (key, value, _mode, seconds) => {
      raw.set(key, value);
      ttl = { key, seconds };
      return 'OK';
    },
  };
  return {
    store,
    raw,
    get ttl() {
      return ttl;
    },
  } as { store: ExchangeInfoStore; raw: Map<string, string>; ttl: typeof ttl };
};

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('loadOrFetchExchangeInfo', () => {
  it('hits upstream on cache miss, narrows the shape, and persists with the documented TTL', async () => {
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse(upstreamSample));
    const now = vi.fn(() => new Date('2026-05-10T00:00:00.000Z'));

    const body = await loadOrFetchExchangeInfo(
      fixture.store,
      'live',
      fetchImpl as unknown as typeof fetch,
      now,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    expect((firstCall[0] as string).endsWith('/api/v3/exchangeInfo')).toBe(true);
    expect(body.symbols.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(body.symbols[0]).toEqual({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filterTickSize: '0.01000000',
      // Only PRICE_FILTER.tickSize here — no LOT_SIZE/NOTIONAL, so the full set
      // can't be projected.
      filters: null,
      // Carried through so the bind route can refuse a symbol this account's
      // Binance permission tags can never satisfy.
      permissionSets: [['SPOT', 'MARGIN']],
    });
    // Absent upstream projects to null, which reads as "no constraint
    // published" and stays permitted.
    expect(body.symbols[1]).toMatchObject({
      symbol: 'ETHUSDT',
      filterTickSize: null,
      permissionSets: null,
    });
    expect(body.fetchedAt).toBe('2026-05-10T00:00:00.000Z');
    expect(fixture.raw.get(EXCHANGE_INFO_REDIS_KEY)).toBeTruthy();
    expect(fixture.ttl).toEqual({
      key: EXCHANGE_INFO_REDIS_KEY,
      seconds: EXCHANGE_INFO_CACHE_TTL_SECONDS,
    });
  });

  it('surfaces the full LOT_SIZE/NOTIONAL/PRICE_FILTER set as a nested filters object', async () => {
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okResponse({
        timezone: 'UTC',
        serverTime: 0,
        symbols: [
          {
            symbol: 'FILTUSDT',
            baseAsset: 'FILT',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              {
                filterType: 'PRICE_FILTER',
                minPrice: '0.01000000',
                maxPrice: '1000000.00000000',
                tickSize: '0.01000000',
              },
              {
                filterType: 'LOT_SIZE',
                minQty: '0.00010000',
                maxQty: '9000.00000000',
                stepSize: '0.00010000',
              },
              { filterType: 'NOTIONAL', minNotional: '10.00000000' },
            ],
          },
        ],
      }),
    );

    const body = await loadOrFetchExchangeInfo(
      fixture.store,
      'live',
      fetchImpl as unknown as typeof fetch,
    );

    // The momentum preview needs every sizing filter, not just the tick. All
    // seven ride in a nested `filters` object as decimal-strings (trailing
    // zeros preserved, same as the tick).
    expect(body.symbols[0]?.filters).toEqual({
      minNotional: '10.00000000',
      tickSize: '0.01000000',
      stepSize: '0.00010000',
      minQty: '0.00010000',
      maxQty: '9000.00000000',
      minPrice: '0.01000000',
      maxPrice: '1000000.00000000',
    });
  });

  it('C10: keeps the tick readable when another required filter is present but invalid', async () => {
    // Both projections read the SAME rows, and they answer differently on
    // purpose: the tick extractor needs only PRICE_FILTER, while the sizing set
    // is all-or-nothing. Feeding one payload to both is the only way to pin
    // that divergence — separate fixtures would let a future all-or-nothing
    // rewrite of the tick path pass while blanking every chart axis whose
    // symbol publishes one garbled sizing row.
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okResponse({
        timezone: 'UTC',
        serverTime: 0,
        symbols: [
          {
            symbol: 'GARBLEDUSDT',
            baseAsset: 'GARBLED',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              {
                filterType: 'PRICE_FILTER',
                minPrice: '0.01000000',
                maxPrice: '1000000.00000000',
                tickSize: '0.01000000',
              },
              // Present, not absent: scientific notation is outside the
              // decimal-string form, so the whole sizing set must void.
              {
                filterType: 'LOT_SIZE',
                minQty: '1e-4',
                maxQty: '9000.00000000',
                stepSize: '1e-4',
              },
              { filterType: 'NOTIONAL', minNotional: '10.00000000' },
            ],
          },
        ],
      }),
    );

    const body = await loadOrFetchExchangeInfo(
      fixture.store,
      'live',
      fetchImpl as unknown as typeof fetch,
    );

    expect(body.symbols[0]?.filterTickSize).toBe('0.01000000');
    expect(body.symbols[0]?.filters).toBeNull();
  });

  it('treats an empty tickSize string as missing PRICE_FILTER', async () => {
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okResponse({
        timezone: 'UTC',
        serverTime: 0,
        symbols: [
          {
            symbol: 'EMPTYUSDT',
            baseAsset: 'EMPTY',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [{ filterType: 'PRICE_FILTER', tickSize: '' }],
          },
        ],
      }),
    );
    const body = await loadOrFetchExchangeInfo(
      fixture.store,
      'live',
      fetchImpl as unknown as typeof fetch,
    );
    expect(body.symbols[0]?.filterTickSize).toBeNull();
  });

  it('returns the cached body and skips upstream on subsequent calls', async () => {
    const fixture = makeStore();
    fixture.raw.set(
      EXCHANGE_INFO_REDIS_KEY,
      JSON.stringify({
        symbols: [
          {
            symbol: 'XRPUSDT',
            baseAsset: 'XRP',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.00010000',
          },
        ],
        fetchedAt: '2026-05-09T23:55:00.000Z',
      }),
    );
    const fetchImpl = vi.fn();

    const body = await loadOrFetchExchangeInfo(
      fixture.store,
      'live',
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(body.symbols).toEqual([
      {
        symbol: 'XRPUSDT',
        baseAsset: 'XRP',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filterTickSize: '0.00010000',
      },
    ]);
  });

  it('throws when upstream is non-200', async () => {
    const fixture = makeStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('cloudflare please', { status: 503 }));

    await expect(
      loadOrFetchExchangeInfo(fixture.store, 'live', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/upstream 503/);
    expect(fixture.raw.size).toBe(0);
  });

  it('throws when upstream shape no longer matches', async () => {
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse({ symbols: [{ wrong: 'shape' }] }));

    await expect(
      loadOrFetchExchangeInfo(fixture.store, 'live', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/shape changed/);
    expect(fixture.raw.size).toBe(0);
  });

  it('targets the testnet host when mode is `test`', async () => {
    const fixture = makeStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse(upstreamSample));
    await loadOrFetchExchangeInfo(fixture.store, 'test', fetchImpl as unknown as typeof fetch);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('expected fetch to have been called');
    // Compare the parsed origin, not a URL prefix: a prefix match also accepts
    // `https://testnet.binance.vision.evil.test`, and a bare host check would
    // stop pinning the scheme that the literal used to cover.
    expect(new URL(call[0] as string).origin).toBe('https://testnet.binance.vision');
  });

  it('does not serve a live-populated cache entry to a test-mode load', async () => {
    // Testnet lists a different symbol universe. A shared key would let whichever
    // mode warmed it answer for the other until the TTL expired — admitting a pair
    // the account's exchange cannot trade, or refusing one it can.
    const fixture = makeStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(upstreamSample))
      .mockResolvedValueOnce(okResponse(upstreamSample));

    await loadOrFetchExchangeInfo(fixture.store, 'live', fetchImpl as unknown as typeof fetch);
    await loadOrFetchExchangeInfo(fixture.store, 'test', fetchImpl as unknown as typeof fetch);

    // The test load must MISS the live entry and fetch its own, leaving two keys.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fixture.raw.size).toBe(2);
  });
});
