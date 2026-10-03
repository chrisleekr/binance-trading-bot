import type { ConfigPreviewResponse } from '@app/contracts';
import { GLOBAL_KEYS, profileKey } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * The preview route, which answers "what levels would this configuration place" without writing anything.
 *
 * Integration-level because every input it reads comes from somewhere real: the profile's strategy and config from Postgres, the price, filters and wallet from Redis, and the candle history from the exchange client. The property worth pinning is that it agrees with the two operator views that call the same projection in the browser, since a configuration that reads as empty here and populated there is worse than no preview at all.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const SYMBOL = 'BTCUSDT';

const symbolInfo = JSON.stringify({
  symbol: SYMBOL,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
});

describeIfInfra('preview-config route', () => {
  let fx: ApiFixture;
  let decisionInterval = '';
  const klineCalls: { interval: string; limit: number | undefined }[] = [];

  beforeAll(async () => {
    fx = await setupApp();
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source)
       values ($1, $2, 'BTC', 'manual')
       on conflict do nothing`,
      [fx.alice.profileId, SYMBOL],
    );
    // The fixture seeds every profile with an empty config, which no strategy schema accepts. The route refuses an effective config its strategy cannot read, deliberately, so the profile has to carry a real one before any projection question can be asked of it.
    const descriptor = fx.di.strategies
      .describeAll()
      .find((entry) => entry.name === 'trailing-trade');
    if (!descriptor) throw new Error('trailing-trade is not registered');
    decisionInterval = String(
      (descriptor.defaultConfig as { candleInterval?: unknown }).candleInterval,
    );
    await fx.di.pool.query(`update profiles set config = $2 where id = $1`, [
      fx.alice.profileId,
      JSON.stringify({ ...descriptor.defaultConfig, symbol: SYMBOL }),
    ]);
    // The fixture leaves market data unwired on purpose. Recording the calls is the only way to see which candle windows the preview asked for, which is the difference between a regime section that is off and one whose history never arrived.
    (
      fx.di as unknown as {
        marketData: {
          getKlines: (mode: string, params: Record<string, unknown>) => Promise<unknown[]>;
        };
      }
    ).marketData.getKlines = async (_mode, params) => {
      klineCalls.push({
        interval: String(params['interval']),
        limit: typeof params['limit'] === 'number' ? params['limit'] : undefined,
      });
      return [
        {
          openTimeMs: 1_700_000_000_000,
          closeTimeMs: 1_700_003_600_000,
          open: '100',
          high: '110',
          low: '90',
          close: '105',
          volume: '1',
        },
      ];
    };
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const SYM_KEY = GLOBAL_KEYS.symbolInfo(SYMBOL, 'test');
  const TICKER_KEY = GLOBAL_KEYS.ticker(SYMBOL);

  const clearCostBasis = async (): Promise<void> => {
    await fx.di.pool.query(`delete from avg_entry_prices where profile_id = $1 and symbol = $2`, [
      fx.alice.profileId,
      SYMBOL,
    ]);
  };

  const preview = async (
    body: unknown,
  ): Promise<{
    status: number;
    body: ConfigPreviewResponse & { error?: { code: string; message: string } };
  }> => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/${SYMBOL}/preview-config`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return {
      status: res.status,
      body: (await res.json()) as ConfigPreviewResponse & {
        error?: { code: string; message: string };
      },
    };
  };

  it('projects a flat symbol from the live price, and says that is what it did', async () => {
    // Every strategy projection is relative to an entry, so a flat symbol handed a null entry projects nothing at all, which is precisely the moment a caller is deciding whether to enter. Both browser views anchor on the live price for this reason, and this route has to give the same answer.
    const r = fx.di.redis.raw();
    await r.set(SYM_KEY, symbolInfo);
    await r.set(TICKER_KEY, JSON.stringify({ price: '100', ts: 1 }));
    await clearCostBasis();

    const { status, body } = await preview({});
    expect(status).toBe(200);
    expect(body.entryPrice).toBeNull();
    expect(body.anchorPrice).toBe('100');
    expect(body.anchorBasis).toBe('current-price');
    // The projection is the point: an anchor the strategy never receives leaves this empty.
    expect(body.sections.length).toBeGreaterThan(0);
  });

  it('projects a held symbol from its recorded cost basis, not from the live price', async () => {
    const r = fx.di.redis.raw();
    await r.set(SYM_KEY, symbolInfo);
    await r.set(TICKER_KEY, JSON.stringify({ price: '100', ts: 1 }));
    await fx.di.pool.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
       values ($1, $2, '80', '1')
       on conflict (profile_id, symbol) do update set avg_entry_price = excluded.avg_entry_price`,
      [fx.alice.profileId, SYMBOL],
    );

    const { body } = await preview({});
    // Compared numerically: the column is `numeric`, so the wire value carries the column's scale rather than the literal that was written.
    expect(Number(body.entryPrice)).toBe(80);
    expect(Number(body.anchorPrice)).toBe(80);
    expect(body.anchorBasis).toBe('position');
  });

  it('reports no anchor, rather than a fabricated one, when neither a basis nor a price exists', async () => {
    await clearCostBasis();
    await fx.di.redis.raw().del(TICKER_KEY);
    const { body } = await preview({});
    expect(body.anchorPrice).toBeNull();
    expect(body.anchorBasis).toBe('none');
    await fx.di.redis.raw().set(TICKER_KEY, JSON.stringify({ price: '100', ts: 1 }));
  });

  it("requests the configuration's own decision window from the exchange", async () => {
    // A candle-reading projection returns no rows when handed none, and a caller cannot tell that from a projection whose rows are genuinely absent. The window asked for is therefore part of the contract, not an implementation detail.
    klineCalls.length = 0;
    const { status } = await preview({});
    expect(status).toBe(200);
    expect(klineCalls.map((call) => call.interval)).toContain(decisionInterval);
    expect(klineCalls.every((call) => (call.limit ?? 0) <= 500)).toBe(true);
  });

  it('still answers when the exchange refuses the candle window', async () => {
    // The window is best-effort input to a config question. Failing the whole preview on it would turn an unreachable exchange into an unanswerable configuration.
    const marketData = (
      fx.di as unknown as {
        marketData: {
          getKlines: (mode: string, params: Record<string, unknown>) => Promise<unknown[]>;
        };
      }
    ).marketData;
    const restore = marketData.getKlines;
    marketData.getKlines = async () => {
      throw new Error('binance unreachable');
    };
    try {
      const { status, body } = await preview({});
      expect(status).toBe(200);
      expect(body.effectiveConfig).toBeDefined();
    } finally {
      marketData.getKlines = restore;
    }
  });

  it('refuses a candidate override the write path would reject', async () => {
    // Showing levels for a configuration that can never be saved is worse than refusing: it is a confident answer about something that will not run.
    const { status, body } = await preview({
      config: { buy: { entrySizing: { mode: 'nonsense' } } },
    });
    expect(status).toBe(422);
    // The status alone cannot tell the override check from the effective-config parse after it, which also answers 422 for this candidate. The message is what proves the refusal came from the same check the write path runs.
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(body.error?.message).toMatch(/^invalid symbol override — /);
  });

  it('hands the strategy the wallet, the quote asset and the candle window it was given', async () => {
    // Everything below is optional input to `previewLevels`, and a strategy handed none of it silently projects a thinner answer rather than failing. Trailing-trade reads only some of these, so asserting through its output would leave the rest unpinned: the assertion is therefore on what the projection was actually called with.
    await fx.di.redis
      .raw()
      .set(
        profileKey({ accountId: fx.alice.accountId, profileId: fx.alice.profileId }, 'accountInfo'),
        JSON.stringify({ balances: { USDT: { free: '1000', locked: '0' } } }),
      );
    await fx.di.redis.raw().set(SYM_KEY, symbolInfo);
    await fx.di.redis.raw().set(TICKER_KEY, JSON.stringify({ price: '100', ts: 1 }));
    await clearCostBasis();

    const registry = fx.di.strategies as unknown as {
      describeForProfile: (name: string, version: string) => { status: string; strategy: unknown };
    };
    const realDescribe = registry.describeForProfile.bind(registry);
    let seen: Record<string, unknown> | null = null;
    registry.describeForProfile = (name, version) => {
      const resolved = realDescribe(name, version);
      if (resolved.status === 'unknown') return resolved;
      const strategy = resolved.strategy as {
        previewLevels: (input: Record<string, unknown>) => unknown;
      };
      return {
        ...resolved,
        strategy: {
          ...strategy,
          previewLevels: (input: Record<string, unknown>) => {
            seen = input;
            return strategy.previewLevels(input);
          },
        },
      };
    };
    try {
      const { status } = await preview({});
      expect(status).toBe(200);
    } finally {
      registry.describeForProfile = realDescribe;
    }

    const input = seen as Record<string, unknown> | null;
    if (input === null) throw new Error('previewLevels was never called');
    expect(
      (input['account'] as { balances: Record<string, unknown> } | undefined)?.balances,
    ).toEqual({ USDT: { free: '1000', locked: '0' } });
    expect(input['quoteAsset']).toBe('USDT');
    expect(input['filters']).toMatchObject({ minNotional: '10' });
    // The anchor the flat case falls back to, seen from the strategy's side rather than from the response echo.
    expect(input['entryPrice']).toBe('100');
    // Asserted by content, not by container: the fixture returns exactly one candle, so a shape check alone would still pass on the thinned answer this test exists to exclude.
    expect(input['candles']).toHaveLength(1);
    expect((input['candles'] as unknown[])[0]).toMatchObject({
      open: '100',
      high: '110',
      low: '90',
      close: '105',
      isClosed: true,
    });
  });

  it('names the candle window it could not fetch, and names none when every window arrived', async () => {
    // The gap has to be part of the answer. A candle-reading projection emits no rows when handed none, so a caller reading only the sections cannot tell a guard that is switched off from one whose history never arrived, and those lead to opposite decisions.
    const marketData = (
      fx.di as unknown as {
        marketData: {
          getKlines: (mode: string, params: Record<string, unknown>) => Promise<unknown[]>;
        };
      }
    ).marketData;
    const restore = marketData.getKlines;
    marketData.getKlines = async () => {
      throw new Error('binance unreachable');
    };
    try {
      const { status, body } = await preview({});
      expect(status).toBe(200);
      expect(body.missingCandleWindows).toEqual([decisionInterval]);
    } finally {
      marketData.getKlines = restore;
    }
    const { body } = await preview({});
    expect(body.missingCandleWindows).toEqual([]);
  });

  it('names a window the exchange answered with no candles at all', async () => {
    // An empty array is the ordinary answer for a newly listed pair or an interval with no history, and it reaches the projection exactly as an unfetched window does. Reporting it as present would put back the ambiguity the list exists to remove: the caller would see an empty projection and no reason for it.
    const marketData = (
      fx.di as unknown as {
        marketData: {
          getKlines: (mode: string, params: Record<string, unknown>) => Promise<unknown[]>;
        };
      }
    ).marketData;
    const restore = marketData.getKlines;
    marketData.getKlines = async () => [];
    try {
      const { status, body } = await preview({});
      expect(status).toBe(200);
      expect(body.missingCandleWindows).toEqual([decisionInterval]);
    } finally {
      marketData.getKlines = restore;
    }
  });
});
