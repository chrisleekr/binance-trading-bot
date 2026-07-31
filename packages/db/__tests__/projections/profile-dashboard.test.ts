import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileScope } from '../../src/repo/_scoped.js';
import { profileRepo } from '../../src/repo/index.js';
import {
  getProfileDashboard,
  invalidateProfileDashboard,
  PROFILE_DASHBOARD_TTL_S,
} from '../../src/repo/projections/profile-dashboard.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Issue #649 C2/E9: the per-profile dashboard cache TTL must strictly exceed
// the SPA's 10s poll (Phase B), mirroring DASHBOARD_AGGREGATE_TTL_S. RED until
// Phase B lifts it 5→15.
describe('PROFILE_DASHBOARD_TTL_S decouples cache lifetime from the poll cadence', () => {
  it('is 15s (> the 10s dashboard poll)', () => {
    expect(PROFILE_DASHBOARD_TTL_S).toBe(15);
  });
});

describe('getProfileDashboard — cache hit (no DB)', () => {
  it('returns the cached payload verbatim and never touches Postgres', async () => {
    const cached = {
      profileId: '00000000-0000-0000-0000-0000000a1001',
      enabled: true,
      binanceMode: 'test',
      balances: [],
      totalProfit: '0',
      symbols: [],
      cachedAt: '2026-05-17T00:00:00.000Z',
    };
    const scope = {
      db: {} as ProfileScope['db'],
      operatorId: 'u1' as ProfileScope['operatorId'],
      accountId: 'a1' as ProfileScope['accountId'],
      profileId: 'p1' as ProfileScope['profileId'],
    };
    const { redis } = makeRedisStub({
      'tenant:a1:profile:p1:dashboard:cache': JSON.stringify(cached),
    });
    const out = await getProfileDashboard(scope, redis);
    expect(out).toEqual(cached);
  });
});

describe('invalidateProfileDashboard (no DB)', () => {
  const scope = {
    db: {} as ProfileScope['db'],
    operatorId: 'u1' as ProfileScope['operatorId'],
    accountId: 'a1' as ProfileScope['accountId'],
    profileId: 'p1' as ProfileScope['profileId'],
  };
  const CACHE_KEY = 'tenant:a1:profile:p1:dashboard:cache';

  it('deletes the dashboard cache key for the scope', async () => {
    const store = new Map<string, string>([[CACHE_KEY, '{}']]);
    const redis = { del: async (k: string): Promise<number> => (store.delete(k) ? 1 : 0) };
    await invalidateProfileDashboard(scope, redis);
    expect(store.has(CACHE_KEY)).toBe(false);
  });

  it('swallows a redis failure — busting the cache is best-effort', async () => {
    const redis = {
      del: async (): Promise<number> => {
        throw new Error('redis down');
      },
    };
    await expect(invalidateProfileDashboard(scope, redis)).resolves.toBeUndefined();
  });
});

describeIfDb('getProfileDashboard — cache miss fan-in', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    scope = ap.scope;
    await ap.profileSymbols.upsert('BTCUSDT', 'BTC', {
      overrideConfig: null,
    });
    await ap.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '60000',
      quantity: '0.001',
    });
    await ap.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 1n,
      clientOrderId: 'cli-dash',
      status: 'NEW',
      raw: {},
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('fans in over Postgres + Redis and writes the 15s cache back', async () => {
    const accountInfoKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:account-info`;
    const cacheKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:dashboard:cache`;
    const { redis, ttls } = makeRedisStub({
      [accountInfoKey]: JSON.stringify({
        balances: { USDT: { free: '100', locked: '0' } },
      }),
      'ticker:BTCUSDT': JSON.stringify({ price: '61000' }),
    });

    const out = await getProfileDashboard(scope, redis);

    expect(out.binanceMode).toBe('test');
    // USDT is the profile's quote asset, so it prices 1:1 even with no
    // price-map key seeded in this stub.
    expect(out.balances).toEqual([{ asset: 'USDT', free: '100', locked: '0', usdPrice: '1' }]);
    expect(out.symbols).toHaveLength(1);
    expect(out.symbols[0]).toMatchObject({
      symbol: 'BTCUSDT',
      currentPrice: '61000',
      openOrderCount: 1,
      // No `disable-action` key for BTCUSDT in the stub ⇒ enabled.
      enabled: true,
    });
    // Decimal columns round-trip through Postgres `numeric` with full
    // scale (`60000.000000000000000000`); compare numerically.
    expect(Number(out.symbols[0]?.avgEntryPrice)).toBe(60000);
    // Account-wide deployed cost-basis = 60000 × 0.001 (the only seeded
    // position at this point) = 60; the percent-of-equity config preview adds
    // this to quote cash. Proves the field is wired through the projection;
    // cross-profile aggregation + account isolation are covered separately in
    // isolation/avg-entry-prices-sum.test.ts.
    expect(Number(out.deployedQuote)).toBe(60);
    // Held quantity is shipped straight from the avg-entry-price row; the
    // display layer derives unrealised P/L from it.
    expect(Number(out.symbols[0]?.quantity)).toBe(0.001);
    expect(ttls.get(cacheKey)).toBe(PROFILE_DASHBOARD_TTL_S);
  });

  it('keeps quantity populated from the LBP row when the ticker is missing', async () => {
    // Seeded BTCUSDT has an LBP row, so quantity stays populated; this case
    // asserts the no-ticker fallback (currentPrice null) does not drop it.
    const { redis } = makeRedisStub({
      [`tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:account-info`]: JSON.stringify({
        balances: {},
      }),
    });
    const out = await getProfileDashboard(scope, redis);
    // No `ticker:BTCUSDT` key in this stub ⇒ currentPrice null.
    expect(out.symbols[0]?.currentPrice).toBeNull();
    // quantity still resolves from the seeded avg-entry-price row.
    expect(Number(out.symbols[0]?.quantity)).toBe(0.001);
  });

  it('marks a symbol disabled when its disable-action key is present', async () => {
    const disableKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:disable-action:BTCUSDT`;
    // Fresh stub (no `dashboard:cache` entry) so the fan-in actually runs.
    const { redis } = makeRedisStub({
      'ticker:BTCUSDT': JSON.stringify({ price: '61000' }),
      [disableKey]: JSON.stringify({
        reason: 'stop-loss cooldown',
        since: '2026-05-18T00:00:00.000Z',
      }),
    });

    const out = await getProfileDashboard(scope, redis);

    expect(out.symbols[0]).toMatchObject({ symbol: 'BTCUSDT', enabled: false });
  });

  it('returns no symbols without MGETing for a profile with no symbols (empty-guard)', async () => {
    // bob has a profile but no profile_symbols rows; the empty-symbol guard must
    // short-circuit so MGET is never called with zero keys (the stub throws on
    // that, mirroring real Redis).
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    const { redis } = makeRedisStub();
    const out = await getProfileDashboard(bp.scope, redis);
    expect(out.symbols).toEqual([]);
  });

  it('zips both MGET results back to the right symbol at N>1 (no off-by-one)', async () => {
    // Seed a second symbol and CROSS the keys: ETHUSDT has a ticker, BTCUSDT has
    // a disable flag. A swapped or mis-indexed MGET array would land the price or
    // the disabled flag on the wrong symbol. Added last so earlier single-symbol
    // assertions are unaffected.
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await ap.profileSymbols.upsert('ETHUSDT', 'ETH', { overrideConfig: null });
    await ap.avgEntryPrices.upsert('ETHUSDT', { avgEntryPrice: '2000', quantity: '0.5' });
    const disableBtc = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:disable-action:BTCUSDT`;
    const { redis } = makeRedisStub({
      [`tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:account-info`]: JSON.stringify({
        balances: {},
      }),
      'ticker:ETHUSDT': JSON.stringify({ price: '2100' }),
      [disableBtc]: JSON.stringify({ reason: 'x', since: '2026-05-18T00:00:00.000Z' }),
    });

    const out = await getProfileDashboard(ap.scope, redis);
    const bySymbol = new Map(out.symbols.map((s) => [s.symbol, s]));
    expect(bySymbol.get('ETHUSDT')?.currentPrice).toBe('2100');
    expect(bySymbol.get('ETHUSDT')?.enabled).toBe(true);
    expect(bySymbol.get('BTCUSDT')?.currentPrice).toBeNull();
    expect(bySymbol.get('BTCUSDT')?.enabled).toBe(false);
  });

  it('attaches a per-asset usdPrice from the market-trend price map', async () => {
    // The market-trend cron publishes a symbol→price map under a global key.
    // The projection resolves each held asset's price as `<asset><quoteAsset>`;
    // the profile's own quote asset (USDT here) prices 1:1, and an asset with no
    // matching pair in the map stays unpriced (null).
    const { redis } = makeRedisStub({
      [`tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:account-info`]: JSON.stringify({
        balances: {
          ETH: { free: '1.5', locked: '0' },
          USDT: { free: '100', locked: '0' },
          ENA: { free: '10', locked: '0' },
        },
      }),
      'market-trend:usd-price-map': JSON.stringify({
        computedAtMs: 1_700_000_000_000,
        prices: { ETHUSDT: '2000', USDCUSDT: '1' },
      }),
    });

    const out = await getProfileDashboard(scope, redis);
    const byAsset = new Map(out.balances.map((b) => [b.asset, b]));
    expect(byAsset.get('ETH')?.usdPrice).toBe('2000');
    expect(byAsset.get('USDT')?.usdPrice).toBe('1');
    expect(byAsset.get('ENA')?.usdPrice).toBeNull();
  });
});
