import type { ConfigDiagnostic } from '@app/contracts';
import { BacktestCreatedSchema, ProfileResponse, ProfileSymbolResponse } from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXCHANGE_INFO_REDIS_KEY } from '../../src/routes/exchange-info.js';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * The three mutation boundaries that gate on order feasibility run the same
 * per-symbol check. Keeping only its `block` findings made a save whose sizing
 * could NOT be verified answer with an unqualified success, indistinguishable to
 * the operator from a verified one.
 *
 * These cases pin the rule that replaced it. A finding rides back on the
 * response only when it is actionable on that route: `filters-unavailable` and
 * `config-unverified` everywhere, and a missing price on the add-symbol bind
 * alone, where the check being skipped is the ordinary outcome and silence would
 * claim a check that did not run. A config save and a backtest stay quiet about
 * a missing price, and no advisory ever turns into a rejection.
 * Integration-level because the finding depends on the profile's bound symbols,
 * its account's Binance environment, and the cached market snapshots in Redis.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const SYMBOL = 'BTCUSDT';

// Alice's account is test-mode, so the profile save and the symbol bind read the
// testnet filter keyspace. A backtest replays production klines and is checked
// against live filters regardless of the account. Both are seeded or cleared
// together so one market state covers all three routes.
const TEST_FILTER_KEY = GLOBAL_KEYS.symbolInfo(SYMBOL, 'test');
const LIVE_FILTER_KEY = GLOBAL_KEYS.symbolInfo(SYMBOL, 'live');
const TICKER_KEY = GLOBAL_KEYS.ticker(SYMBOL);

// Minimums low enough that only a config deliberately sized under them blocks.
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

// Valid JSON whose filter values no longer match the snapshot schema. A drifted
// cache entry is as unusable as a missing one, so it must report the same gap
// instead of being read as a successful check.
const driftedSymbolInfo = JSON.stringify({ quoteAsset: 'USDT', filters: { minNotional: 10 } });

const ticker = JSON.stringify({ price: '100', ts: 1 });

// Clears every seeded minimum at the seeded price, so any finding on this config
// comes from the market snapshots being unreadable, never from the sizing.
const feasibleConfig = {
  symbol: SYMBOL,
  candleInterval: '1h',
  buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '50' } },
  sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
};

// Sized below the seeded minNotional of 10 so the strategy returns a `block`.
const underMinNotionalConfig = {
  ...feasibleConfig,
  buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '5' } },
};

const backtestParams = {
  symbols: [SYMBOL],
  fromMs: 1_000,
  toMs: 2_000,
  strategyInterval: '1h',
  detailInterval: '5m',
  initialQuoteBalance: '1000',
  fees: { makerBps: 10, takerBps: 10 },
  slippageBps: 5,
};

type Body = Record<string, unknown>;

const readBody = async (res: Response): Promise<Body> => (await res.json()) as Body;

/**
 * Re-parse a body through its contract schema and hand back a plain map. zod
 * object schemas are non-strict, so a key the schema does not declare is dropped
 * on parse. Reading the key back off the parsed value is therefore what proves
 * the contract carries the field, rather than only the handler emitting it.
 */
const throughContract = (schema: { parse: (value: unknown) => unknown }, body: unknown): Body => ({
  ...(schema.parse(body) as object),
});

describeIfInfra('save-time order-feasibility diagnostics', () => {
  let fx: ApiFixture;

  const headers = (): Record<string, string> => ({
    'x-test-user-id': fx.alice.userId,
    'content-type': 'application/json',
  });

  const base = (): string => `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`;

  const saveConfig = (config: unknown): Promise<Response> =>
    fx.app.request(base(), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ config }),
    });

  const bindSymbol = (): Promise<Response> =>
    fx.app.request(`${base()}/symbols`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ symbol: SYMBOL }),
    });

  const launchBacktest = (): Promise<Response> =>
    fx.app.request(`${base()}/backtests`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(backtestParams),
    });

  const setFilters = async (value: string): Promise<void> => {
    const r = fx.di.redis.raw();
    await r.set(TEST_FILTER_KEY, value);
    await r.set(LIVE_FILTER_KEY, value);
  };

  const clearFilters = async (): Promise<void> => {
    await fx.di.redis.raw().del(TEST_FILTER_KEY, LIVE_FILTER_KEY);
  };

  const setPrice = async (): Promise<void> => {
    await fx.di.redis.raw().set(TICKER_KEY, ticker);
  };

  const clearPrice = async (): Promise<void> => {
    await fx.di.redis.raw().del(TICKER_KEY);
  };

  beforeAll(async () => {
    fx = await setupApp();
    // The bind route rejects a pair it cannot find listed as TRADING, and reads
    // that from the cached exchangeInfo rather than Binance.
    await fx.di.redis.raw().set(
      EXCHANGE_INFO_REDIS_KEY,
      JSON.stringify({
        symbols: [
          {
            symbol: SYMBOL,
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
        ],
        fetchedAt: '2026-07-29T00:00:00.000Z',
      }),
    );
    // The profile save checks its bound symbols, so an unbound profile would
    // produce an empty finding list on every state below.
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source)
       values ($1, $2, 'BTC', 'auto')`,
      [fx.alice.profileId, SYMBOL],
    );
    // The bind and backtest routes size against the STORED config; the seeded
    // '{}' fails the strategy schema, which reports config-unverified and never
    // reaches the exchange-rule check these cases are about.
    await fx.di.pool.query(`update profiles set config = $2::jsonb where id = $1`, [
      fx.alice.profileId,
      JSON.stringify(feasibleConfig),
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('tells the operator a saved config was not verified against exchange rules', async () => {
    await clearFilters();
    await setPrice();
    const res = await saveConfig(feasibleConfig);
    const body = await readBody(res);
    // 200 with the saved row: the gap is advisory, so the save still lands. A
    // fail-closed 422 here would be a dead end the operator cannot clear.
    expect(res.status).toBe(200);
    expect(body['id']).toBe(fx.alice.profileId);
    expect(body['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'filters-unavailable' }),
    );
    const found = (body['diagnostics'] as ConfigDiagnostic[]).find(
      (d) => d.code === 'filters-unavailable',
    );
    // The symbol prefix is what makes it actionable on a multi-symbol profile.
    expect(found?.message).toMatch(/^BTCUSDT: /);
  });

  it('reports a drifted filter snapshot the same way as a missing one', async () => {
    await setFilters(driftedSymbolInfo);
    await setPrice();
    const res = await saveConfig(feasibleConfig);
    const body = await readBody(res);
    expect(res.status).toBe(200);
    expect(body['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'filters-unavailable' }),
    );
  });

  it('tells the operator a bound symbol was not verified against exchange rules', async () => {
    await clearFilters();
    await setPrice();
    const res = await bindSymbol();
    const body = await readBody(res);
    expect(res.status).toBe(201);
    expect(body['symbol']).toBe(SYMBOL);
    expect(body['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'filters-unavailable' }),
    );
  });

  it('tells the operator a launched backtest was not verified against exchange rules', async () => {
    await clearFilters();
    await setPrice();
    const res = await launchBacktest();
    const body = await readBody(res);
    expect(res.status).toBe(202);
    expect(typeof body['runId']).toBe('string');
    expect(body['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'filters-unavailable' }),
    );
  });

  it('reports a missing price on the bind only, and stays silent on the other two', async () => {
    await setFilters(symbolInfo);
    await clearPrice();

    // A config save checks every bound symbol, so on a disabled profile this
    // would fire once per symbol with nothing the operator can do about any of
    // them. A backtest replays historical candles, where a live price is beside
    // the point.
    const saved = await saveConfig(feasibleConfig);
    expect(saved.status).toBe(200);
    expect(await readBody(saved)).not.toHaveProperty('diagnostics');

    const launched = await launchBacktest();
    expect(launched.status).toBe(202);
    expect(await readBody(launched)).not.toHaveProperty('diagnostics');

    // The bind is different in kind: it checks the one symbol being added, and
    // prices stream only for symbols an enabled profile already subscribes to,
    // so that symbol never has one. Staying quiet would make the route that
    // exists to validate a new symbol claim a check it structurally never runs.
    const bound = await bindSymbol();
    expect(bound.status).toBe(201);
    expect((await readBody(bound))['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'price-unavailable' }),
    );
  });

  it('stays silent on a bind whose symbol already has a cached price', async () => {
    // The ticker cache is symbol-global, so a pair another profile already
    // streams DOES have a price and the bind's sizing check really runs. Without
    // this arm, a bind that reported the finding unconditionally would still
    // satisfy the case above.
    await setFilters(symbolInfo);
    await setPrice();
    const res = await bindSymbol();
    const body = await readBody(res);
    expect(res.status).toBe(201);
    expect(body['symbol']).toBe(SYMBOL);
    expect(body).not.toHaveProperty('diagnostics');

    // The same config sized under the seeded minimum still 422s here, which is
    // what proves the check ran against those snapshots rather than being
    // skipped quietly.
    const rejected = await saveConfig(underMinNotionalConfig);
    expect(rejected.status).toBe(422);
  });

  it('leaves a fully verified response exactly as it was', async () => {
    await setFilters(symbolInfo);
    await setPrice();

    const saved = await readBody(await saveConfig(feasibleConfig));
    expect(Object.keys(saved).sort()).toEqual(
      [
        'id',
        'accountId',
        'name',
        'strategyName',
        'strategyVersion',
        'config',
        'enabled',
        'binanceMode',
        'quoteAsset',
        'benchmarkMode',
        'baselineBacktestRunId',
        'enablementPolicy',
        'notifyEvents',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    const bound = await readBody(await bindSymbol());
    expect(Object.keys(bound).sort()).toEqual(
      ['symbol', 'overrideConfig', 'source', 'reserveBaseQuantity'].sort(),
    );

    const launched = await readBody(await launchBacktest());
    expect(Object.keys(launched).sort()).toEqual(['runId', 'deduped'].sort());
    expect(launched['deduped']).toBe(false);
  });

  it('still rejects a config that cannot place a valid order', async () => {
    await setFilters(symbolInfo);
    await setPrice();
    const res = await saveConfig(underMinNotionalConfig);
    const body = (await res.json()) as { error: { code: string } };
    // A `block` is not advisory: reporting it in a 200 body would let an
    // unplaceable config reach the worker.
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('carries the findings through the response contracts', async () => {
    await clearFilters();
    await setPrice();

    // Each body is re-parsed through the schema its route declares. An undeclared
    // key does not survive that parse, so this fails while only the handlers know
    // about the field.
    const saved = throughContract(
      ProfileResponse,
      await readBody(await saveConfig(feasibleConfig)),
    );
    expect(saved['diagnostics']).toContainEqual(
      expect.objectContaining({ code: 'filters-unavailable' }),
    );

    const bound = throughContract(ProfileSymbolResponse, await readBody(await bindSymbol()));
    expect(bound['diagnostics']).toContainEqual(
      expect.objectContaining({ code: 'filters-unavailable' }),
    );

    const launched = throughContract(BacktestCreatedSchema, await readBody(await launchBacktest()));
    expect(launched['diagnostics']).toContainEqual(
      expect.objectContaining({ code: 'filters-unavailable' }),
    );
  });

  it('says nothing on a profile patch that does not touch the config', async () => {
    // Renaming is the most common profile PATCH and runs no feasibility check.
    // The market state here would warn on a config edit, so an unconditional
    // attach would show through and put an unrelated advisory on a rename.
    await clearFilters();
    await setPrice();
    const res = await fx.app.request(base(), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ name: 'renamed' }),
    });
    const body = await readBody(res);
    expect(res.status).toBe(200);
    expect(body['name']).toBe('renamed');
    expect(body).not.toHaveProperty('diagnostics');
  });

  // Last on purpose: it leaves the stored config unreadable, which every case
  // above depends on being valid.
  it('reports settings its strategy cannot read at all', async () => {
    await setFilters(symbolInfo);
    await setPrice();
    // A config the live strategy schema rejects. Nothing can be sized against
    // it, so the least-checked bind in the system must not answer like the
    // most-checked one.
    await fx.di.pool.query(`update profiles set config = $2::jsonb where id = $1`, [
      fx.alice.profileId,
      JSON.stringify({ buy: 'not-a-config' }),
    ]);

    const bound = await bindSymbol();
    expect(bound.status).toBe(201);
    expect((await readBody(bound))['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'config-unverified' }),
    );

    const launched = await launchBacktest();
    expect(launched.status).toBe(202);
    expect((await readBody(launched))['diagnostics']).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'config-unverified' }),
    );
  });
});
