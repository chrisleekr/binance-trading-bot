import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accountRepo, profileRepo, type AccountScope } from '../../src/repo/index.js';
import {
  DASHBOARD_AGGREGATE_TTL_S,
  getAggregateForAccount,
} from '../../src/repo/projections/profile-aggregate.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Issue #649 C2/E9: the aggregate cache TTL must strictly exceed the SPA's
// dashboard poll (Phase B moves the poll 5s→10s), so the cache absorbs the poll
// instead of expiring on nearly every request. RED until Phase B lifts it 5→15.
describe('DASHBOARD_AGGREGATE_TTL_S decouples cache lifetime from the poll cadence', () => {
  it('is 15s (> the 10s dashboard poll)', () => {
    expect(DASHBOARD_AGGREGATE_TTL_S).toBe(15);
  });
});

describeIfDb('getAggregateForAccount', () => {
  let fx: IsolationFixture;
  let aliceScope: AccountScope;
  let bobScope: AccountScope;

  beforeAll(async () => {
    fx = await setupFixture();
    aliceScope = (await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId)).scope;
    bobScope = (await accountRepo(fx.db, fx.bob.userId, fx.bob.accountId)).scope;
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it("lists the account's profile and reads its Redis liveness blob", async () => {
    const tickMetaKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:profile-tick-meta`;
    const killKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:kill-switch`;
    const { redis } = makeRedisStub({
      [tickMetaKey]: JSON.stringify({
        lastTickAt: '2026-05-17T00:00:00.000Z',
        lastTickLatencyMs: 42,
      }),
      [killKey]: '1',
    });

    const out = await getAggregateForAccount(aliceScope, redis);

    expect(out.profiles).toHaveLength(1);
    expect(out.profiles[0]).toMatchObject({
      profileId: fx.alice.profileId,
      lastTickAt: '2026-05-17T00:00:00.000Z',
      lastTickLatencyMs: 42,
      killSwitch: true,
      // Fixture does not seed an api_keys row; the projection reports the
      // boolean truthfully so the dashboard hint can route the operator to
      // /api-key when needed.
      apiKeyConfigured: false,
      lastTickError: null,
    });
  });

  it('forwards lastTickError from the profile-tick-meta blob', async () => {
    const tickMetaKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:profile-tick-meta`;
    const { redis } = makeRedisStub({
      [tickMetaKey]: JSON.stringify({ lastTickAt: null, lastTickError: 'cold-load-failed' }),
    });
    const out = await getAggregateForAccount(aliceScope, redis);
    expect(out.profiles[0]).toMatchObject({
      lastTickAt: null,
      lastTickError: 'cold-load-failed',
    });
  });

  it('defaults liveness fields when no Redis state blob exists', async () => {
    const { redis } = makeRedisStub();
    const out = await getAggregateForAccount(aliceScope, redis);
    expect(out.profiles[0]).toMatchObject({
      lastTickAt: null,
      lastTickLatencyMs: null,
      killSwitch: false,
    });
  });

  it('reports zero order stats and no positions for a profile with no symbols', async () => {
    const { redis } = makeRedisStub();
    const out = await getAggregateForAccount(aliceScope, redis);
    expect(out.profiles[0]).toMatchObject({
      openOrderCount: 0,
      openPositionCount: 0,
      positions: [],
    });
  });

  it('counts live orders and ships the position P/L inputs with the live price', async () => {
    const ap = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await ap.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });
    await ap.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '9007199254740993.125000000000000001',
      quantity: '0.123456789012345678',
    });
    await ap.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 7n,
      clientOrderId: 'cli-agg-1',
      status: 'NEW',
      raw: {},
    });

    // Symbol-global ticker key the projection reads for each position.
    const { redis } = makeRedisStub({
      'ticker:BTCUSDT': JSON.stringify({ price: '61000.0000' }),
    });
    const out = await getAggregateForAccount(bobScope, redis);
    expect(out.profiles[0]).toMatchObject({ openOrderCount: 1, openPositionCount: 1 });
    expect(out.profiles[0]?.positions).toHaveLength(1);
    const pos = out.profiles[0]?.positions[0];
    expect(pos).toEqual({
      symbol: 'BTCUSDT',
      avgEntryPrice: '9007199254740993.125000000000000001',
      quantity: '0.123456789012345678',
      currentPrice: '61000',
    });
  });

  it('ships a position with a null currentPrice when no ticker is cached', async () => {
    // Self-contained: seed bob's position here (idempotent upserts) rather
    // than relying on the previous test's writes persisting.
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await bp.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });
    await bp.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    // No ticker key in the stub ⇒ currentPrice resolves to null.
    const { redis } = makeRedisStub();
    const out = await getAggregateForAccount(bobScope, redis);
    expect(out.profiles[0]?.positions[0]?.currentPrice).toBeNull();
  });

  it('coerces a malformed ticker price to null rather than leaking it', async () => {
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await bp.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });
    await bp.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    // A non-decimal `price` must degrade to null, not leak an invalid
    // `DecimalString` that fails the response contract.
    const { redis } = makeRedisStub({
      'ticker:BTCUSDT': JSON.stringify({ price: 'not-a-number' }),
    });
    const out = await getAggregateForAccount(bobScope, redis);
    expect(out.profiles[0]?.positions[0]?.currentPrice).toBeNull();
  });

  it('falls back to defaults when the profile-state blob is malformed', async () => {
    const stateKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:profile-state`;
    const { redis } = makeRedisStub({ [stateKey]: 'not-json' });
    const out = await getAggregateForAccount(aliceScope, redis);
    // A malformed Redis blob falls back to Redis-derived liveness defaults.
    expect(out.profiles[0]).toMatchObject({
      lastTickAt: null,
      lastTickLatencyMs: null,
    });
  });

  it('writes a 15s cache and serves the second call from it, skipping the fan-in', async () => {
    const cacheKey = `tenant:${fx.alice.accountId}:dashboard-aggregate:cache`;
    const { redis, store, ttls } = makeRedisStub();
    const p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await p.profile.update({ enabled: false });

    const first = await getAggregateForAccount(aliceScope, redis);
    expect(first.profiles[0]?.enabled).toBe(false);
    expect(store.has(cacheKey)).toBe(true);
    expect(ttls.get(cacheKey)).toBe(15);

    // Flip the source column; within the TTL the cached payload must win,
    // proving the second call did not re-run the Postgres fan-in.
    await p.profile.update({ enabled: true });
    const second = await getAggregateForAccount(aliceScope, redis);
    expect(second.profiles[0]?.enabled).toBe(false);
  });

  it('degrades a corrupt cache blob to a miss and recomputes', async () => {
    const cacheKey = `tenant:${fx.alice.accountId}:dashboard-aggregate:cache`;
    const { redis } = makeRedisStub({ [cacheKey]: 'not-json{' });
    const out = await getAggregateForAccount(aliceScope, redis);
    // Recomputed rather than thrown: a corrupt cache must not 500.
    expect(out.profiles).toHaveLength(1);
  });
});
