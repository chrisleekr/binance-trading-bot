import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import {
  combineExchangeInfoRefresh,
  createExchangeInfoRefresh,
} from '../../src/crons/exchange-info-refresh.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';

const silentLogger = pino({ level: 'silent' });

interface StubRedis {
  writes: Map<string, string>;
  preexisting: string[];
}

const stubRedis = (
  preexisting: string[] = [],
  pipeOverride?: { failAt?: number; failError?: Error },
): Redis & StubRedis => {
  const writes = new Map<string, string>();
  const setCalls: { key: string; value: string }[] = [];
  const pipe = {
    set: vi.fn((k: string, v: string) => {
      setCalls.push({ key: k, value: v });
      writes.set(k, v);
      return pipe;
    }),
    exec: vi.fn(async () => {
      // Default: every SET returns [null, 'OK']. Override lets a test
      // simulate a per-command failure at a specific index.
      return setCalls.map((_, i) =>
        pipeOverride && pipeOverride.failAt === i
          ? [pipeOverride.failError ?? new Error('mock-set-failed'), null]
          : [null, 'OK'],
      );
    }),
  };
  let scanCalled = false;
  return {
    writes,
    preexisting,
    pipeline: () => pipe,
    scan: vi.fn(async () => {
      if (scanCalled) return ['0', []];
      scanCalled = true;
      return ['0', preexisting];
    }),
    del: vi.fn(async () => 0),
  } as unknown as Redis & StubRedis;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createExchangeInfoRefresh', () => {
  it('writes one symbol-info entry per ASCII-tickered symbol', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              {
                filterType: 'PRICE_FILTER',
                minPrice: '0.01',
                maxPrice: '1000000',
                tickSize: '0.01',
              },
              { filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '9000', stepSize: '0.0001' },
              { filterType: 'NOTIONAL', minNotional: '10' },
            ],
          },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '50000', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '5000', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', minNotional: '5' },
            ],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });
    const result = await refresh();

    expect(result).toEqual({ fetched: 2, written: 2, skipped: 0, deleted: 0 });
    expect(redis.writes.has(buildSymbolInfoKey('BTCUSDT'))).toBe(true);
    const btcRaw = redis.writes.get(buildSymbolInfoKey('BTCUSDT'));
    if (!btcRaw) throw new Error('test setup: BTCUSDT not written');
    const btc = JSON.parse(btcRaw) as {
      symbol: string;
      baseAsset: string;
      filters: Record<string, string>;
    };
    expect(btc.symbol).toBe('BTCUSDT');
    expect(btc.baseAsset).toBe('BTC');
    expect(btc.filters.tickSize).toBe('0.01');
    expect(btc.filters.stepSize).toBe('0.0001');
    expect(btc.filters.minNotional).toBe('10');
  });

  it('skips symbols with non-ASCII tickers (e.g. CJK meme tokens)', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [],
          },
          {
            symbol: '币安人生USDT',
            baseAsset: '币安人生',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });
    const result = await refresh();

    expect(result).toEqual({ fetched: 2, written: 1, skipped: 1, deleted: 0 });
    expect(redis.writes.has(buildSymbolInfoKey('BTCUSDT'))).toBe(true);
    expect(redis.writes.has(buildSymbolInfoKey('币安人生USDT'))).toBe(false);
  });

  it('deletes Redis keys for symbols Binance no longer lists', async () => {
    const stale = [buildSymbolInfoKey('BUSDUSDT'), buildSymbolInfoKey('LUNAUSDT')];
    const redis = stubRedis(stale);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });
    const result = await refresh();

    expect(result.deleted).toBe(2);
    expect(redis.del).toHaveBeenCalledWith(...stale);
  });

  it('throws on per-command pipeline failure so a partial write is not masked', async () => {
    const redis = stubRedis([], { failAt: 1, failError: new Error('OOM command not allowed') });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [],
          },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });

    await expect(refresh()).rejects.toThrow(/redis SET failed for .*ETHUSDT/);
  });

  it('refuses to wipe the cache when upstream returns 200 with empty symbols', async () => {
    // Pre-existing cache state from a healthy prior refresh.
    const existing = [buildSymbolInfoKey('BTCUSDT'), buildSymbolInfoKey('ETHUSDT')];
    const redis = stubRedis(existing);
    const fetchImpl = vi.fn(async () => jsonResponse({ symbols: [] }));

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });

    await expect(refresh()).rejects.toThrow(/upstream returned 0 symbols/);
    // del must NOT have been called — the cache stays intact for the
    // next healthy refresh.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('throws on non-ok upstream response so the cron retries + DLQs', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });

    await expect(refresh()).rejects.toThrow(/upstream 429/);
  });

  it('mode=test fetches the testnet host and writes the test keyspace', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            // Testnet publishes a coarser tick than production for the same pair.
            filters: [
              { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
              { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '9000', stepSize: '0.001' },
              { filterType: 'NOTIONAL', minNotional: '10' },
            ],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({
      redis,
      logger: silentLogger,
      fetchImpl,
      mode: 'test',
    });
    await refresh();

    // Fetched from the testnet host, not production.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('testnet.binance.vision');
    // Stale-key cleanup SCANs the TEST glob only — it can never reach and wipe
    // the live keyspace. The stub's scan ignores MATCH, so assert the argument.
    expect(redis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      buildSymbolInfoKey('*', 'test'),
      'COUNT',
      500,
    );
    // Written to the test keyspace; the live key is untouched.
    expect(redis.writes.has(buildSymbolInfoKey('BTCUSDT', 'test'))).toBe(true);
    expect(redis.writes.has(buildSymbolInfoKey('BTCUSDT', 'live'))).toBe(false);
    const raw = redis.writes.get(buildSymbolInfoKey('BTCUSDT', 'test'));
    if (!raw) throw new Error('test setup: test-mode BTCUSDT not written');
    expect((JSON.parse(raw) as { filters: Record<string, string> }).filters.tickSize).toBe('0.1');
  });

  it('handles missing filters gracefully (asset-dust symbols)', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'OBSCURE',
            baseAsset: 'OBS',
            quoteAsset: 'USDT',
            status: 'BREAK',
            // no filters array
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });
    await refresh();

    const obsRaw = redis.writes.get(buildSymbolInfoKey('OBSCURE'));
    if (!obsRaw) throw new Error('test setup: OBSCURE not written');
    const obs = JSON.parse(obsRaw) as { filters: Record<string, string> };
    expect(obs.filters.tickSize).toBe('0'); // safe fallback
    expect(obs.filters.minNotional).toBe('0');
  });
});

describe('combineExchangeInfoRefresh', () => {
  it('resolves to the live result and refreshes both keyspaces', async () => {
    const live = vi.fn(async () => ({ fetched: 1, written: 1, skipped: 0, deleted: 0 }));
    const test = vi.fn(async () => undefined);

    const combined = combineExchangeInfoRefresh(live, test, silentLogger);
    const result = await combined();

    expect(live).toHaveBeenCalledTimes(1);
    expect(test).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ fetched: 1, written: 1, skipped: 0, deleted: 0 });
  });

  it('swallows a test-mode failure and still resolves to the live result', async () => {
    const live = vi.fn(async () => 'live-ok');
    const test = vi.fn(async () => {
      throw new Error('testnet down');
    });
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof combineExchangeInfoRefresh>[2];

    const combined = combineExchangeInfoRefresh(live, test, logger);

    await expect(combined()).resolves.toBe('live-ok');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('propagates a live-mode failure (load-bearing) without running the test refresh', async () => {
    const live = vi.fn(async () => {
      throw new Error('prod exchangeInfo 429');
    });
    const test = vi.fn(async () => undefined);

    const combined = combineExchangeInfoRefresh(live, test, silentLogger);

    await expect(combined()).rejects.toThrow(/prod exchangeInfo 429/);
    // Live threw before the test refresh was reached.
    expect(test).not.toHaveBeenCalled();
  });
});
