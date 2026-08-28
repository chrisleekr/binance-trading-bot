import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '../../src/db.js';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import { profileRepo, scopeProfile } from '../../src/repo/index.js';
import { profileKey } from '../../src/redis.js';
import {
  getProfileDashboard,
  invalidateProfileDashboard,
  PROFILE_DASHBOARD_TTL_S,
} from '../../src/repo/projections/profile-dashboard.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;
const UNIT_OPERATOR_ID = asUserId('00000000-0000-4000-8000-000000000001');
const UNIT_ACCOUNT_ID = asAccountId('00000000-0000-4000-8000-000000000002');
const UNIT_PROFILE_ID = asProfileId('00000000-0000-4000-8000-000000000003');

/**
 * Mints the production scope brand without making cache-only tests depend on a Postgres server.
 * @returns A branded profile scope and cleanup callback for its inert pool.
 */
const unitScope = async (): Promise<{ close: () => Promise<void>; scope: ProfileScope }> => {
  const pool = new Pool();
  const ownershipResult: QueryResult = {
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [[UNIT_PROFILE_ID]],
  };
  Object.defineProperty(pool, 'query', {
    value: async (): Promise<QueryResult> => ownershipResult,
  });
  const scope = await scopeProfile(
    createDb(pool),
    UNIT_OPERATOR_ID,
    UNIT_ACCOUNT_ID,
    UNIT_PROFILE_ID,
  );
  return { scope, close: () => pool.end() };
};

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
    const { scope, close } = await unitScope();
    try {
      const cached = {
        profileId: UNIT_PROFILE_ID,
        enabled: true,
        binanceMode: 'test',
        balances: [],
        totalProfit: '0',
        symbols: [],
        cachedAt: '2026-05-17T00:00:00.000Z',
      };
      const { redis } = makeRedisStub({
        [profileKey(scope, 'dashboardCache')]: JSON.stringify(cached),
      });
      const out = await getProfileDashboard(scope, redis);
      expect(out).toEqual(cached);
    } finally {
      await close();
    }
  });
});

describe('invalidateProfileDashboard (no DB)', () => {
  it('deletes the dashboard cache key for the scope', async () => {
    const { scope, close } = await unitScope();
    try {
      const cacheKey = profileKey(scope, 'dashboardCache');
      const store = new Map<string, string>([[cacheKey, '{}']]);
      const redis = { del: async (key: string): Promise<number> => (store.delete(key) ? 1 : 0) };
      await invalidateProfileDashboard(scope, redis);
      expect(store.has(cacheKey)).toBe(false);
    } finally {
      await close();
    }
  });

  it('swallows a redis failure — busting the cache is best-effort', async () => {
    const { scope, close } = await unitScope();
    try {
      const redis = {
        del: async (): Promise<number> => {
          throw new Error('redis down');
        },
      };
      await expect(invalidateProfileDashboard(scope, redis)).resolves.toBeUndefined();
    } finally {
      await close();
    }
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
      avgEntryPrice: '9007199254740993.125000000000000001',
      quantity: '0.123456789012345678',
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
        balances: { USDT: { free: '100.0000', locked: '0.0000' } },
      }),
      'ticker:BTCUSDT': JSON.stringify({ price: '61000.0000' }),
    });

    const out = await getProfileDashboard(scope, redis);

    expect(out.binanceMode).toBe('test');
    // USDT is the profile's quote asset, so it prices 1:1 even with no
    // price-map key seeded in this stub.
    expect(out.balances).toEqual([
      { asset: 'USDT', free: '100.0000', locked: '0.0000', usdPrice: '1' },
    ]);
    expect(out.symbols).toHaveLength(1);
    expect(out.symbols[0]).toMatchObject({
      symbol: 'BTCUSDT',
      avgEntryPrice: '9007199254740993.125000000000000001',
      currentPrice: '61000.0000',
      quantity: '0.123456789012345678',
      openOrderCount: 1,
      // No `disable-action` key for BTCUSDT in the stub ⇒ enabled.
      enabled: true,
    });
    // The exact product retains digits that an IEEE-754 Number hop would lose.
    expect(out.deployedQuote).toBe('1111999897984716.019564447899521463873456789012345678');
    // totalProfit is a literal zero in this projection and does not originate in PostgreSQL.
    expect(out.totalProfit).toBe('0');
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
    expect(out.symbols[0]?.quantity).toBe('0.123456789012345678');
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
