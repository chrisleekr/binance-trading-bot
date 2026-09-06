import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { accountRepo, entryHaltKeys, profileKey, profileRepo } from '@app/db';
import {
  asAccountId,
  asProfileId,
  type AccountHealthResponse,
  type StoredRiskConfig,
} from '@app/contracts';
import { HAS_INFRA, setupApp, TRAILING_TRADE_VERSION, type ApiFixture } from '../_helpers.js';
import { recordPoolCheckouts } from '../_pool-checkouts.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({ 'x-test-user-id': userId });

describeIfInfra('account-health router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  const haltKeys = () =>
    entryHaltKeys({ accountId: fx.alice.accountId, profileId: fx.alice.profileId });

  // Every halt key, after every test. A halt flag left behind is invisible to the test that leaks it and decides the verdict of the next one, so a suite that passes in file order would go red under --shuffle for reasons nothing states.
  afterEach(async () => {
    const k = haltKeys();
    await fx.di.redis.raw().del(k['daily-loss'], k['loss-streak'], k.drawdown);
  });

  const get = async (): Promise<AccountHealthResponse> => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/account/health`, {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AccountHealthResponse;
  };

  it('reports the worker down when no heartbeat is present, and no halts initially', async () => {
    const body = await get();
    // No worker process runs in the api test, so the heartbeat key is absent.
    expect(body.worker.status).toBe('down');
    expect(body.halts).toEqual([]);
    // Today's realized is summed per (quote, mode); the array exists even at zero.
    expect(Array.isArray(body.todayRealized)).toBe(true);
  });

  it("buckets today's realized in the profile's own quote, ignoring cycles closed under a previous one", async () => {
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const now = new Date();
    const cycle = (quoteAsset: string, symbol: string, profit: string) => ({
      symbol,
      baseAsset: 'ETH',
      quoteAsset,
      totalBuyQuote: '100',
      totalSellQuote: '92',
      breakdown: {},
      profit,
      source: 'manual' as const,
      orders: [{ side: 'SELL' as const }],
      archivedAt: now,
    });
    await p.tradeArchive.insert(cycle('USDT', 'ETHUSDT', '-8'));
    // Same UTC day, previous quote. The bar buckets by quote asset, so admitting this would add a BTC loss into the USDT row — a sum of two currencies, which is exactly the defect the quote filter exists to stop. Magnitude far from -8 so a dropped filter cannot pass by coincidence.
    await p.tradeArchive.insert(cycle('BTC', 'ETHBTC', '-500'));

    const body = await get();
    const usdt = body.todayRealized.find((r) => r.quoteAsset === 'USDT');
    expect(Number(usdt?.realizedQuote)).toBe(-8);
    // No BTC bucket at all: the profile settles in USDT, so nothing is counted in BTC.
    expect(body.todayRealized.some((r) => r.quoteAsset === 'BTC')).toBe(false);
  });

  it('matches a lower-case stored quote against the archive’s exchangeInfo casing', async () => {
    // The grouped read LEFT JOINs the archive, so a dropped `upper()` on the profiles side does not error and does not lose the row: the join simply fails to match and the bar reports a flat day for a profile that lost money. That is the same figure the daily-loss limit is measured against. Reachable because `profiles.insert` stores `quoteAsset` verbatim while `update` upper-cases it.
    await fx.di.pool.query(`update profiles set quote_asset='usdt' where id=$1`, [
      fx.alice.profileId,
    ]);
    try {
      const body = await get();
      // The USDT cycle seeded above, still counted, and still labelled canonically.
      const usdt = body.todayRealized.find((r) => r.quoteAsset === 'USDT');
      expect(Number(usdt?.realizedQuote)).toBe(-8);
    } finally {
      await fx.di.pool.query(`update profiles set quote_asset='USDT' where id=$1`, [
        fx.alice.profileId,
      ]);
    }
  });

  it('aggregates the per-profile daily-loss halt Redis flag', async () => {
    const raw = fx.di.redis.raw();
    await raw.set(
      profileKey(
        { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
        'entryHaltDaily',
      ),
      JSON.stringify({ reason: 'daily-loss-limit' }),
    );

    const body = await get();
    const kinds = body.halts
      .filter((h) => h.profileId === fx.alice.profileId)
      .map((h) => h.kind)
      .sort();
    expect(kinds).toEqual(['daily-loss']);
  });

  it('reports one entry per active breaker, not a single winner', async () => {
    // A profile can be held by two breakers at once. Collapsing them would tell the operator to go and look at only one of the limits pausing their buys.
    const raw = fx.di.redis.raw();
    const keys = haltKeys();
    // All three seeded here, including the daily one: asserting a kind this test did not arm would only be passing on a key some earlier test left behind.
    await raw.set(keys['daily-loss'], '{}', 'EX', 3600);
    await raw.set(keys['loss-streak'], '{}', 'EX', 3600);
    await raw.set(keys.drawdown, '{}', 'EX', 3600);

    const body = await get();
    const kinds = body.halts.filter((h) => h.profileId === fx.alice.profileId).map((h) => h.kind);
    expect(kinds).toEqual(['daily-loss', 'loss-streak', 'drawdown']);
  });

  // Its own ACCOUNT, live-mode, holding one profile with one losing cycle. Not a second profile on Alice's account: `todayRealized` is summed per account, so an extra archive row there would move a figure another test asserts on, and that test would then pass or fail on file order. This describe reads its own account and touches nothing the rest of the file can see.
  describe('the daily warn band is gated on the DAILY breaker alone', () => {
    const WARN_ACCOUNT = '00000000-0000-4000-8000-0000000009a1';
    let warnProfileId: string;

    const getWarn = async (): Promise<AccountHealthResponse> => {
      const res = await fx.app.request(`/api/accounts/${WARN_ACCOUNT}/account/health`, {
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as AccountHealthResponse;
    };

    beforeAll(async () => {
      await fx.di.pool.query(
        `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'Warn', 'live')`,
        [WARN_ACCOUNT, fx.alice.userId],
      );
      const account = await accountRepo(fx.di.db, fx.alice.userId, asAccountId(WARN_ACCOUNT));
      const row = await account.profiles.insert({
        name: 'warn-band',
        strategyName: 'trailing-trade',
        strategyVersion: TRAILING_TRADE_VERSION,
        config: {},
        state: {},
      });
      warnProfileId = row.id;
      const warnRepo = await profileRepo(
        fx.di.db,
        fx.alice.userId,
        asAccountId(WARN_ACCOUNT),
        asProfileId(row.id),
      );
      // -8 realised today against a limit of 10 puts the profile exactly ON the 80% band, which is also the boundary the comparison has to include.
      await warnRepo.tradeArchive.insert({
        symbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        totalBuyQuote: '100',
        totalSellQuote: '92',
        breakdown: {},
        profit: '-8',
        source: 'manual',
        orders: [{ side: 'SELL' }],
        archivedAt: new Date(),
      });
      await warnRepo.profile.setRiskConfig({ dailyLossLimitQuote: '10' } as StoredRiskConfig);
    });

    const warnKeys = () =>
      entryHaltKeys({
        accountId: asAccountId(WARN_ACCOUNT),
        profileId: asProfileId(warnProfileId),
      });

    afterEach(async () => {
      const k = warnKeys();
      await fx.di.redis.raw().del(k['daily-loss'], k['loss-streak'], k.drawdown);
    });

    it('is armed at all only because the loss has reached the band', async () => {
      // Non-vacuity for the two cases below: with no halt of any kind the profile MUST appear, or they would both be asserting about an empty list.
      const body = await getWarn();
      expect(body.approachingLimit.some((w) => w.profileId === warnProfileId)).toBe(true);
    });

    it('stays armed when only a GUARD is pausing buys', async () => {
      // The band answers one question — how close is today's loss to today's limit — and a guard pause says nothing about that. Retiring it for any halt would blank the operator's last warning before the daily breaker trips, at the exact moment a guard has told them the day is going badly.
      await fx.di.redis.raw().set(warnKeys().drawdown, '{}', 'EX', 3600);

      const body = await getWarn();
      // The guard IS reported as a halt...
      expect(body.halts.filter((h) => h.profileId === warnProfileId).map((h) => h.kind)).toEqual([
        'drawdown',
      ]);
      // ...and the daily warn band is still armed, because no DAILY halt exists.
      const warn = body.approachingLimit.find((w) => w.profileId === warnProfileId);
      expect(warn).toBeDefined();
      expect(Number(warn?.lossQuote)).toBe(-8);
      expect(Number(warn?.limitQuote)).toBe(10);
    });

    it('retires once the DAILY breaker has actually tripped', async () => {
      // The other half of the same predicate, so a gate that always passes fails here even though the guard-only case above would not notice it.
      await fx.di.redis.raw().set(warnKeys()['daily-loss'], '{}', 'EX', 3600);

      const body = await getWarn();
      expect(body.approachingLimit.some((w) => w.profileId === warnProfileId)).toBe(false);
    });
  });

  it('serves the bar on one pooled connection however many profiles the account has', async () => {
    // This route resolved each profile's facts concurrently and took a pooled connection per profile while it did. The api shares a pool of ten, so the checkout burst was unbounded in the profile count: an operator with a handful of profiles emptied the pool on one poll of the health bar, and the bar polls.
    // The gate is that the peak does not GROW with the profile count, which is why it is measured twice. A single measurement at one profile count cannot tell a fan-out apart from a fixed burst, and the pre-fix peak was itself timing-dependent — pg-pool hands back a connection a fast read has already released, so the observed number moved run to run.
    const peakAt = async (): Promise<number> => {
      const { peak } = await recordPoolCheckouts(fx.di.pool, async () => {
        const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/account/health`, {
          headers: headers(fx.alice.userId),
        });
        expect(res.status).toBe(200);
      });
      return peak;
    };

    const atOneProfile = await peakAt();

    // Distinct quote assets, one per profile. `todayRealized` is keyed by quote asset, so the default 'USDT' would collapse all five into alice's single bucket and the response could not distinguish one profile from five.
    const extraQuotes = ['BTC', 'ETH', 'BNB', 'SOL'];
    for (const [i, quoteAsset] of extraQuotes.entries()) {
      await fx.di.pool.query(
        `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state, quote_asset)
         values ($1, $2, $3, 'trailing-trade', $4, '{}'::jsonb, '{}'::jsonb, $5)`,
        [
          `00000000-0000-4000-8000-0000000000f${i + 1}`,
          fx.alice.accountId,
          `health-fanout-${quoteAsset}`,
          TRAILING_TRADE_VERSION,
          quoteAsset,
        ],
      );
    }
    // The seed has to be visible to the route, or the second measurement would silently repeat the first and the whole gate would pass vacuously the moment anything narrowed `listForAccount`. A 200 alone does not prove that — the body has to enumerate every quote this test seeded.
    // Containment rather than set equality: a sibling case may legitimately seed a sixth profile with its own quote, and exact equality would make THIS assertion fail for a change made somewhere else, at a distance, with nothing but declaration order holding it together. Each of the five is still named individually, so a dropped profile is still caught.
    const listed = await get();
    const quotes = listed.todayRealized.map((r) => r.quoteAsset);
    for (const quoteAsset of ['BNB', 'BTC', 'ETH', 'SOL', 'USDT']) {
      expect(quotes).toContain(quoteAsset);
    }

    const atFiveProfiles = await peakAt();

    // Not "at most one query" — the reads may be as many as they like, as long as one request cannot occupy more than one connection at a time, and adding a profile cannot widen it.
    expect(atFiveProfiles).toBe(atOneProfile);
    expect(atOneProfile).toBe(1);
  });

  it('normalises a sub-1e-6 realised sum end to end, through a real route and its response schema', async () => {
    // What this pins is the SCHEMA transform, driven through a real route rather than in isolation: `account-health.ts` ends in `AccountHealthResponse.parse(body)`, so reverting the route's own `asDecimalString` call would leave this green — the schema re-spells the value either way. That is worth knowing, not a weakness: this route is backstopped, and the case proves the backstop actually runs on a live response rather than only in a unit test. The unbackstopped cast is `resolveGaugeCap` in discovery.ts, which reaches `c.json` with no parse; discovery.test.ts covers that one.
    // The value: decimal.js switches `toString()` to exponential once the decimal exponent reaches -7, so a realised sum of 0.00000036 leaves the route as `3.6e-7`. The bar interpolates the field verbatim into a currency column, where an exponent reads as a corrupted number rather than a very small one — and this is the same figure the daily-loss limit is measured against.
    const profileId = asProfileId('00000000-0000-4000-8000-0000000000fa');
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state, quote_asset)
       values ($1, $2, 'health-tiny-realised', 'trailing-trade', $3, '{}'::jsonb, '{}'::jsonb, 'XRP')`,
      [profileId, fx.alice.accountId, TRAILING_TRADE_VERSION],
    );
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, profileId);
    await p.tradeArchive.insert({
      symbol: 'ETHXRP',
      baseAsset: 'ETH',
      quoteAsset: 'XRP',
      totalBuyQuote: '100',
      totalSellQuote: '100.00000036',
      breakdown: {},
      profit: '0.00000036',
      source: 'manual' as const,
      orders: [{ side: 'SELL' as const }],
      archivedAt: new Date(),
    });

    const body = await get();
    const xrp = body.todayRealized.find((r) => r.quoteAsset === 'XRP');
    expect(xrp?.realizedQuote).toBe('0.00000036');
    // Spelled twice on purpose: an equality that regressed to the exponential form would still read as "a number", so the grammar is asserted separately.
    expect(xrp?.realizedQuote).not.toMatch(/e-/i);
  });
});
