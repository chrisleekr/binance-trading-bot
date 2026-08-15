import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
  combineExchangeInfoRefresh,
  createExchangeInfoRefresh,
} from '../../src/crons/exchange-info-refresh.js';
import { CATALOG, type MetricName, type MetricsSink } from '../../src/metrics/catalog.js';
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

    expect(result).toEqual({
      fetched: 2,
      written: 2,
      skipped: 0,
      deleted: 0,
      orderRateLimits: { windows: [], headers: new Map() },
    });
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
    // The whole projection, not a spot-check. Neither symbol here publishes a
    // PERCENT_PRICE_BY_SIDE filter, and the band is parsed separately from the
    // seven required thresholds precisely so a missing band cannot null them.
    expect(btc.filters).toEqual({
      minPrice: '0.01',
      maxPrice: '1000000',
      tickSize: '0.01',
      minQty: '0.0001',
      maxQty: '9000',
      stepSize: '0.0001',
      minNotional: '10',
    });
  });

  it('persists the PERCENT_PRICE_BY_SIDE band, which the protective stop prices against', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        symbols: [
          {
            symbol: 'LINKUSDT',
            baseAsset: 'LINK',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filters: [
              {
                filterType: 'PRICE_FILTER',
                minPrice: '0.001',
                maxPrice: '10000',
                tickSize: '0.001',
              },
              { filterType: 'LOT_SIZE', minQty: '0.01', maxQty: '92141578', stepSize: '0.01' },
              { filterType: 'NOTIONAL', minNotional: '5' },
              {
                filterType: 'PERCENT_PRICE_BY_SIDE',
                bidMultiplierUp: '1.1',
                bidMultiplierDown: '0.5',
                askMultiplierUp: '2',
                askMultiplierDown: '0.9',
                avgPriceMins: 5,
              },
            ],
          },
        ],
      }),
    );

    const refresh = createExchangeInfoRefresh({ redis, logger: silentLogger, fetchImpl });
    await refresh();

    const raw = redis.writes.get(buildSymbolInfoKey('LINKUSDT'));
    if (!raw) throw new Error('test setup: LINKUSDT not written');
    const persisted = JSON.parse(raw) as {
      filters: { percentPriceBySide?: Record<string, unknown>; tickSize: string };
    };
    // All five, because the tick reads the band off this blob and a dropped
    // multiplier reads as "band unknown", which is exactly the fail-open that
    // lets an unplaceable stop through.
    expect(persisted.filters.percentPriceBySide).toEqual({
      bidMultiplierUp: '1.1',
      bidMultiplierDown: '0.5',
      askMultiplierUp: '2',
      askMultiplierDown: '0.9',
      avgPriceMins: 5,
    });
    expect(persisted.filters.tickSize).toBe('0.001');
  });

  it('retains the ORDERS rate-limit rows, which the order governor is built from', async () => {
    const redis = stubRedis();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        // Testnet's rows, which are HALF live's 100/10s — the reason these are
        // read from the payload rather than hardcoded.
        rateLimits: [
          { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 },
          { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
          { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160000 },
        ],
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
    const { orderRateLimits } = await refresh();

    expect(orderRateLimits.windows).toEqual([
      { windowMs: 10_000, limit: 50 },
      { windowMs: 86_400_000, limit: 160000 },
    ]);
    expect([...orderRateLimits.headers.keys()]).toEqual([
      'x-mbx-order-count-10s',
      'x-mbx-order-count-1d',
    ]);
    // Pinned here rather than in a shape test because THIS is what a followed
    // redirect would buy an attacker: the ceiling every later placement is
    // measured against, chosen by whichever host answered.
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');
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

    expect(result).toEqual({
      fetched: 2,
      written: 1,
      skipped: 1,
      deleted: 0,
      orderRateLimits: { windows: [], headers: new Map() },
    });
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

  // Both collapse to the same all-zero fallback, and until now both did it in
  // total silence. They are not the same event: a symbol that publishes no
  // filters is a dust pair behaving normally, while a symbol that publishes a
  // filter list the projection cannot read is a payload change, and every tick
  // that then sizes against a zero stepSize skips the symbol without saying why.
  const capturingLogger = (): { logger: Logger; warns: { ctx: unknown; msg: string }[] } => {
    const warns: { ctx: unknown; msg: string }[] = [];
    return {
      logger: {
        info: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        warn: (ctx: unknown, msg: string) => {
          warns.push({ ctx, msg });
        },
      } as unknown as Logger,
      warns,
    };
  };

  const metricsStub = (): MetricsSink =>
    ({ record: vi.fn(), forget: vi.fn() }) as unknown as MetricsSink;

  describe('present-but-unparseable filter payloads', () => {
    // Declared as the catalogue's own type, so an uncatalogued name is a compile
    // error here rather than a silently dropped series at the prom-client sink.
    const UNPARSEABLE: MetricName = 'exchange_info_filters_unparseable_total';

    const symbolWith = (filters: unknown) => ({
      symbol: 'BROKENUSDT',
      baseAsset: 'BROKEN',
      quoteAsset: 'USDT',
      status: 'TRADING',
      ...(filters === undefined ? {} : { filters }),
    });

    it('C8: is per-mode only, never per-symbol', () => {
      // 3641 listed spot pairs. A symbol label turns one counter into a series per
      // pair, which is a cardinality incident, not observability.
      expect(CATALOG[UNPARSEABLE].labelNames).toEqual(['mode']);
      expect(CATALOG[UNPARSEABLE].kind).toBe('counter');
    });

    it('C8: logs and counts a symbol whose filters array is present but unreadable', async () => {
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      // A real filter list, but the LOT_SIZE and NOTIONAL rows the projection
      // requires are missing, so the whole set voids.
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          symbols: [symbolWith([{ filterType: 'PRICE_FILTER', tickSize: '0.001' }])],
        }),
      );

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).toHaveBeenCalledWith(UNPARSEABLE, 1, { mode: 'live' });
      const warn = warns.find((w) => w.ctx !== null && typeof w.ctx === 'object');
      expect(warn).toBeDefined();
      expect(warn?.ctx).toMatchObject({ mode: 'live', symbols: 1, sample: ['BROKENUSDT'] });
      // Still written, still all-zero: naming the problem must not also drop the
      // symbol out of the cache and DLQ its first tick.
      const raw = redis.writes.get(buildSymbolInfoKey('BROKENUSDT'));
      if (!raw) throw new Error('test setup: BROKENUSDT not written');
      expect((JSON.parse(raw) as { filters: Record<string, string> }).filters.tickSize).toBe('0');
    });

    it('C9: an absent filters array stays silent and uncounted', async () => {
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      const fetchImpl = vi.fn(async () => jsonResponse({ symbols: [symbolWith(undefined)] }));

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).not.toHaveBeenCalled();
      expect(warns).toEqual([]);
    });

    it('C9: an empty filters array stays silent and uncounted', async () => {
      // Indistinguishable from absent upstream, and several existing fixtures rely
      // on it: counting it would make the signal fire on healthy dust pairs.
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      const fetchImpl = vi.fn(async () => jsonResponse({ symbols: [symbolWith([])] }));

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).not.toHaveBeenCalled();
      expect(warns).toEqual([]);
    });

    it('C8: counts under the mode it fetched, so testnet drift is not read as live', async () => {
      const redis = stubRedis();
      const { logger } = capturingLogger();
      const metrics = metricsStub();
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          symbols: [symbolWith([{ filterType: 'PRICE_FILTER', tickSize: '0.001' }])],
        }),
      );

      const refresh = createExchangeInfoRefresh({
        redis,
        logger,
        fetchImpl,
        metrics,
        mode: 'test',
      });
      await refresh();

      expect(metrics.record).toHaveBeenCalledWith(UNPARSEABLE, 1, { mode: 'test' });
    });

    it('collapses a whole-universe drift into ONE line carrying the count', async () => {
      // The projection is all-or-nothing, so one renamed upstream field voids
      // every symbol at once. A warn per symbol would be ~3.6k lines per mode
      // every 5 minutes, burying the diagnostic it exists to surface. The metric
      // stays per-symbol; only the log collapses, and the count rides the line so
      // the sample's truncation is never silent.
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      const broken = Array.from({ length: 30 }, (_, i) => ({
        symbol: `BROKEN${i}USDT`,
        baseAsset: `BROKEN${i}`,
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.001' }],
      }));
      const fetchImpl = vi.fn(async () => jsonResponse({ symbols: broken }));

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).toHaveBeenCalledTimes(30);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.ctx).toMatchObject({ mode: 'live', symbols: 30 });
      expect((warns[0]?.ctx as { sample: string[] }).sample).toHaveLength(20);
    });
  });

  // The band is parsed separately from the seven sizing filters and spread in
  // only on success, so a garbled one leaves a NON-NULL filter set: the
  // unparseable-filters signal above cannot see it. Downstream it reads as "no
  // band published", the protective-stop band check fails open, and the
  // cancel/re-place pair goes back out into the -1013 that drift exists to catch.
  describe('a dropped PERCENT_PRICE_BY_SIDE band', () => {
    const BAND_UNPARSEABLE: MetricName = 'exchange_info_band_unparseable_total';

    const complete = (band: Record<string, unknown> | null) => ({
      symbol: 'LINKUSDT',
      baseAsset: 'LINK',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.001', minPrice: '0.001', maxPrice: '1000' },
        { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '9000' },
        { filterType: 'NOTIONAL', minNotional: '10' },
        ...(band === null ? [] : [band]),
      ],
    });

    it('is per-mode only, same cardinality bound as its sibling counter', () => {
      expect(CATALOG[BAND_UNPARSEABLE].labelNames).toEqual(['mode']);
      expect(CATALOG[BAND_UNPARSEABLE].kind).toBe('counter');
    });

    it('counts and logs a published band the projection dropped', async () => {
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      // Published, and complete enough that the seven sizing filters survive —
      // but the multipliers are numbers where Binance sends decimal strings.
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          symbols: [
            complete({
              filterType: 'PERCENT_PRICE_BY_SIDE',
              askMultiplierUp: 5,
              askMultiplierDown: 0.2,
              bidMultiplierUp: 5,
              bidMultiplierDown: 0.2,
              avgPriceMins: 5,
            }),
          ],
        }),
      );

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).toHaveBeenCalledWith(BAND_UNPARSEABLE, 1, { mode: 'live' });
      expect(warns).toHaveLength(1);
      expect(warns[0]?.ctx).toMatchObject({ mode: 'live', symbols: 1, sample: ['LINKUSDT'] });
      // The rest of the filter set survives, which is exactly why this needs its
      // own signal: nothing else reports the symbol as damaged.
      const raw = redis.writes.get(buildSymbolInfoKey('LINKUSDT'));
      if (!raw) throw new Error('test setup: LINKUSDT not written');
      const persisted = JSON.parse(raw) as { filters: Record<string, unknown> };
      expect(persisted.filters['stepSize']).toBe('0.01');
      expect(persisted.filters['percentPriceBySide']).toBeUndefined();
    });

    it('stays silent when no band was published at all', async () => {
      // Not every symbol carries one, and treating an absent band as drift would
      // make the counter fire on healthy pairs.
      const redis = stubRedis();
      const { logger, warns } = capturingLogger();
      const metrics = metricsStub();
      const fetchImpl = vi.fn(async () => jsonResponse({ symbols: [complete(null)] }));

      const refresh = createExchangeInfoRefresh({ redis, logger, fetchImpl, metrics });
      await refresh();

      expect(metrics.record).not.toHaveBeenCalled();
      expect(warns).toEqual([]);
    });
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
