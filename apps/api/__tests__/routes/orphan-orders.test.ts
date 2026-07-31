import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_KEYS } from '@app/db';
import type { OrphanSnapshot } from '@app/contracts';
import { buildStrategyRegistry } from '@app/strategy-registry';
// Tests may import a plugin directly (the no-plugin-leak gate exempts __tests__):
// the fixture has to MINT a real clientOrderId, and only the strategy that owns
// the id scheme can produce one.
import { firstBuyClientOrderId, protectiveStopClientOrderId } from '@app/strategy-trailing-trade';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the orphan-orders surface: the GET reads the worker's
 * Redis snapshot and derives each orphan's owning profile; the POST hands one back
 * to that owner (insert a tracked row in the strategy's own slot + subscribe the
 * symbol). The destination is DERIVED, never supplied — so every adopt here must
 * carry a clientOrderId the seeded trailing-trade profile can actually prove it
 * emitted. The id-scheme membership itself is unit-tested in the strategy package.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

const orphan = (
  orderId: string,
  accountId: string,
  over: Partial<OrphanSnapshot['orphans'][number]> = {},
) => ({
  orderId,
  // The account whose key pair found the order. An order id is unique only within
  // one Binance account, so both the snapshot KEY and this field are per account.
  accountId,
  symbol: 'BTCUSDT',
  side: 'BUY' as const,
  type: 'LIMIT',
  price: '60000',
  origQty: '0.001',
  status: 'NEW',
  clientOrderId: `tt-abc${orderId}-b`,
  timeMs: 1_700_000_000_000,
  // Seeded Alice/Bob profiles are testnet, so the default orphan is testnet too
  // and adopts cleanly; the cross-mode guard is exercised with an explicit
  // `mode: 'live'` override.
  mode: 'test' as const,
  ...over,
});

describeIfInfra('orphan-orders router', () => {
  let fx: ApiFixture;

  const writeSnapshot = async (orphans: OrphanSnapshot['orphans']): Promise<void> => {
    await fx.di.redis
      .raw()
      .set(
        GLOBAL_KEYS.orphanSnapshot(fx.alice.accountId),
        JSON.stringify({ computedAtMs: 1_700_000_000_000, orphans }),
        'EX',
        300,
      );
  };

  // An orphan the seeded trailing-trade profile PROVABLY placed: its clientOrderId
  // is the id that strategy would mint for (thisProfile, thisSymbol). Anything
  // else is not adoptable at all now, by design.
  const owned = (
    orderId: string,
    over: Partial<OrphanSnapshot['orphans'][number]> = {},
  ): OrphanSnapshot['orphans'][number] =>
    orphan(orderId, fx.alice.accountId, {
      clientOrderId: firstBuyClientOrderId(fx.alice.profileId, over.symbol ?? 'BTCUSDT'),
      ...over,
    });

  beforeAll(async () => {
    fx = await setupApp();
    // Enabled so adopt enqueues the worker reconfigure (the "full auto adopt"
    // signal) — asserted below. The config must PARSE, or the strategy cannot be
    // asked whether it owns an id and the profile silently drops out of
    // attribution (a refusal, never a 500) — the seeded `{}` does not parse.
    const ttDefaults = buildStrategyRegistry().get('trailing-trade')?.defaultConfig;
    await fx.di.pool.query(`update profiles set enabled = true, config = $2 where id = $1`, [
      fx.alice.profileId,
      JSON.stringify(ttDefaults),
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    // Each test owns the (global) snapshot key and clears tracked rows so an
    // adopt in one test does not bleed into another.
    await fx.di.redis.raw().del(GLOBAL_KEYS.orphanSnapshot(fx.alice.accountId));
    await fx.di.pool.query('truncate table orders, profile_symbols restart identity cascade');
    // Adopt resolves the orphan symbol's base asset via exchangeInfo for the
    // base-asset exclusivity check. Seed the cache so the route never reaches
    // out to live Binance during tests.
    await fx.di.redis.raw().set(
      'exchange-info:cache',
      JSON.stringify({
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
        ],
        fetchedAt: '2026-05-31T00:00:00.000Z',
      }),
    );
  });

  it('GET derives the owning profile for an order that profile placed', async () => {
    await writeSnapshot([owned('10'), owned('20', { symbol: 'ETHUSDT' })]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders`, {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      computedAtMs: number | null;
      orphans: {
        orderId: string;
        mode: string;
        ownerProfileId: string | null;
        ownerProfileName: string | null;
      }[];
    };
    expect(body.orphans.map((o) => o.orderId)).toEqual(['10', '20']);
    expect(body.orphans.every((o) => o.mode === 'test')).toBe(true);
    expect(body.orphans.every((o) => o.ownerProfileId === fx.alice.profileId)).toBe(true);
    // The owner's NAME rides inline on the orphan; there is no separate profile
    // list to cross-reference, because there is no picker.
    expect(body.orphans.every((o) => o.ownerProfileName !== null)).toBe(true);
    expect(body.computedAtMs).toBe(1_700_000_000_000);
  });

  it('GET reports NO owner for an order no profile on the account placed', async () => {
    // An order placed by hand, by another bot, or by a strategy whose id folds
    // runtime data it cannot re-derive. There is nothing to adopt it into, and the
    // page must say so rather than offer a picker.
    await writeSnapshot([
      orphan('30', fx.alice.accountId, { clientOrderId: 'someone-elses-order' }),
    ]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders`, {
      headers: headers(fx.alice.userId),
    });
    const body = (await res.json()) as {
      orphans: { ownerProfileId: string | null; ownerProfileName: string | null }[];
    };
    expect(body.orphans[0]?.ownerProfileId).toBeNull();
    expect(body.orphans[0]?.ownerProfileName).toBeNull();
  });

  it("GET never serves another account's orphan, even if one is in this account's snapshot", async () => {
    // An orphan is only ever adoptable into a profile of the account whose key
    // pair found it. Serving a foreign one is both a leak and a dead
    // pre-selection: the id does not exist on this account's order book.
    await writeSnapshot([owned('10'), orphan('20', fx.bob.accountId, { symbol: 'ETHUSDT' })]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders`, {
      headers: headers(fx.alice.userId),
    });
    const body = (await res.json()) as { orphans: { orderId: string }[] };
    expect(body.orphans.map((o) => o.orderId)).toEqual(['10']);
  });

  it('GET returns an empty list (computedAtMs null) when no snapshot exists', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders`, {
      headers: headers(fx.alice.userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { computedAtMs: number | null; orphans: unknown[] };
    expect(body.orphans).toEqual([]);
    expect(body.computedAtMs).toBeNull();
  });

  it('GET requires authentication', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders`);
    expect(res.status).toBe(401);
  });

  it('POST adopt inserts a tracked row, subscribes the symbol, and signals the worker', async () => {
    await writeSnapshot([owned('12345')]);
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '12345', mode: 'test' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { symbol: string; binanceOrderId: string };
    expect(body).toMatchObject({ symbol: 'BTCUSDT', binanceOrderId: '12345' });

    // The order is now tracked live (the idempotency guard sees it).
    const live = await fx.di.pool.query(
      `select intent, binance_order_id from orders where binance_order_id = 12345 and closed_at is null`,
    );
    // The strategy's OWN slot, derived from the id — not a blanket `manual` bucket
    // the strategy can never account for.
    expect(live.rows[0]?.intent).toBe('grid-buy');
    // The symbol is now bound so the strategy manages it.
    const bound = await fx.di.pool.query(
      `select source from profile_symbols where profile_id = $1 and symbol = 'BTCUSDT'`,
      [fx.alice.profileId],
    );
    expect(bound.rows[0]?.source).toBe('manual');
    // The worker was signalled to pick up the new subscription.
    expect(addSpy).toHaveBeenCalledWith(
      'reconfigure-profile',
      expect.objectContaining({ profileId: fx.alice.profileId }),
      expect.anything(),
    );
    addSpy.mockRestore();
  });

  // The -2010 storm's entry point: a deleted profile's protective stop was left
  // resting on Binance and adopted. It LOCKS the base, so the adopting strategy's
  // own stop is unfundable and Binance rejects it on every tick, forever.
  it('POST adopt 409s on a RESTING SELL — it is holding the coins', async () => {
    await writeSnapshot([
      orphan('4242', fx.alice.accountId, {
        side: 'SELL',
        // Type-agnostic on purpose: an OCO leg or a TAKE_PROFIT_LIMIT locks the
        // base exactly the same way. Side + resting status is the whole test.
        type: 'TAKE_PROFIT_LIMIT',
        status: 'PARTIALLY_FILLED',
      }),
    ]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '4242', profileId: fx.alice.profileId, mode: 'test' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/holding your coins/i);

    // Nothing was tracked: an adopted resting SELL is exactly what must not exist.
    const { rows } = await fx.di.pool.query('select 1 from orders where binance_order_id = 4242');
    expect(rows).toHaveLength(0);
  });

  it('POST adopt ACCEPTS a resting SELL its OWNER claims (an orphaned protective stop)', async () => {
    // The composed rule, and the counterweight to the test above. A blanket
    // resting-SELL refusal would make an orphaned protective stop — which IS a
    // resting SELL — permanently un-adoptable, gutting the "orphans go back to the
    // profile that placed them" decision. Adopting into the TRUE owner is safe by
    // construction under that same reasoning: the strategy matches its own
    // deterministic clientOrderId, so it will not place a duplicate and does not
    // treat the order as a foreign lock on the base. The base held by the profile's
    // OWN stop is the correct protected state.
    await writeSnapshot([
      orphan('4343', fx.alice.accountId, {
        side: 'SELL',
        type: 'STOP_LOSS_LIMIT',
        status: 'NEW',
        clientOrderId: protectiveStopClientOrderId(fx.alice.profileId, 'BTCUSDT'),
      }),
    ]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '4343', mode: 'test' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe(fx.alice.profileId);

    const { rows } = await fx.di.pool.query('select 1 from orders where binance_order_id = 4343');
    expect(rows).toHaveLength(1);
  });

  it('POST adopt 409s when the order is no longer in the snapshot', async () => {
    await writeSnapshot([owned('10')]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '999', mode: 'test' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST adopt evicts the order from the snapshot and the alert sets, synchronously', async () => {
    // The order is tracked now, so it is no longer an orphan. Leaving it in the
    // snapshot keeps it on the adopt list until the next 10-minute cron tick; and
    // leaving it in the seen/alerted sets silently suppresses a genuine re-alert
    // if it ever becomes an orphan again.
    await writeSnapshot([owned('31337')]);
    // Per-account sets, bare-id members (an order id is unique within one account).
    const alertedKey = GLOBAL_KEYS.orphanAlerted(fx.alice.accountId);
    const seenKey = GLOBAL_KEYS.orphanSeen(fx.alice.accountId);
    await fx.di.redis.raw().sadd(alertedKey, '31337');
    await fx.di.redis.raw().sadd(seenKey, '31337');

    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '31337', mode: 'test' }),
    });
    expect(res.status).toBe(201);

    const raw = await fx.di.redis.raw().get(GLOBAL_KEYS.orphanSnapshot(fx.alice.accountId));
    const snap = JSON.parse(raw ?? '{"orphans":[]}') as { orphans: { orderId: string }[] };
    expect(snap.orphans.map((o) => o.orderId)).not.toContain('31337');
    expect(await fx.di.redis.raw().sismember(alertedKey, '31337')).toBe(0);
    expect(await fx.di.redis.raw().sismember(seenKey, '31337')).toBe(0);

    // The rewritten snapshot carries a REAL TTL. `KEEPTTL` on a key that has since
    // expired creates it PERSISTENT — and a snapshot that never expires means a
    // dead worker keeps serving a stale orphan set the operator might act on.
    const ttl = await fx.di.redis.raw().ttl(GLOBAL_KEYS.orphanSnapshot(fx.alice.accountId));
    expect(ttl).toBeGreaterThan(0);
  });

  it('POST adopt 409s on an orphan belonging to ANOTHER account (id + mode alone are not identity)', async () => {
    // An order id is unique only within one Binance account. The GET handler already
    // re-checks each orphan's own accountId against the proven scope; the handler
    // that WRITES must be symmetric, or a sibling account's order gets a tracking
    // row on this profile — for an order that does not exist on this account's book.
    await writeSnapshot([orphan('4242', fx.bob.accountId)]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '4242', mode: 'test' }),
    });
    expect(res.status).toBe(409);
    const live = await fx.di.pool.query(`select 1 from orders where binance_order_id = 4242`);
    expect(live.rows).toHaveLength(0);
  });

  it('POST adopt 409s on a double-adopt (already tracked live)', async () => {
    await writeSnapshot([owned('77')]);
    const adopt = () =>
      fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ orderId: '77', mode: 'test' }),
      });
    expect((await adopt()).status).toBe(201);
    expect((await adopt()).status).toBe(409);
  });

  it('POST adopt 409s when a sibling profile on the same account already manages the symbol', async () => {
    // A second profile under Alice (same account: same user + test mode) owns
    // BTCUSDT, so the orphan cannot be adopted into Alice's primary profile.
    // The pre-check must fire BEFORE the order insert so no phantom row is left.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'sibling', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [sibling, fx.alice.accountId],
    );
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'BTCUSDT', 'BTC', 'auto')`,
      [sibling],
    );
    try {
      await writeSnapshot([owned('66')]);
      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ orderId: '66', mode: 'test' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('managed by profile "sibling"');
      // No order row was inserted for Alice — the conflict fired pre-insert.
      const tracked = await fx.di.pool.query(
        `select 1 from orders where profile_id = $1 and symbol = 'BTCUSDT'`,
        [fx.alice.profileId],
      );
      expect(tracked.rowCount).toBe(0);
    } finally {
      await fx.di.pool.query('delete from profiles where id = $1', [sibling]);
    }
  });

  it('POST adopt 409s when a sibling profile settles (quotes) in the orphan base asset', async () => {
    // A second profile under Alice settles in BTC (quote_asset = 'BTC'), so it
    // spends the shared BTC balance the orphaned BTCUSDT position would also draw
    // on. The quote-collision pre-check must fire BEFORE the order insert — the
    // same dangling-row hazard the owns-base pre-check guards, mirrored.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state, quote_asset)
       values ($1, $2, 'btc-settler', 'trailing-trade', '1.0.0', '{}', '{}', 'BTC')`,
      [sibling, fx.alice.accountId],
    );
    try {
      await writeSnapshot([owned('67')]);
      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ orderId: '67', mode: 'test' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('settlement asset of profile "btc-settler"');
      // No order row was inserted for Alice — the conflict fired pre-insert.
      const tracked = await fx.di.pool.query(
        `select 1 from orders where profile_id = $1 and symbol = 'BTCUSDT'`,
        [fx.alice.profileId],
      );
      expect(tracked.rowCount).toBe(0);
    } finally {
      await fx.di.pool.query('delete from profiles where id = $1', [sibling]);
    }
  });

  it('POST adopt 409s when a different orphan already holds the owning strategy slot', async () => {
    // Two distinct orphans on BTCUSDT: adopting the first takes the single live
    // slot for that (symbol, intent); the second hits the findLive 409 (a different
    // branch from the same-id idempotency 409).
    await writeSnapshot([owned('77'), owned('88')]);
    const adopt = (orderId: string) =>
      fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ orderId, mode: 'test' }),
      });
    expect((await adopt('77')).status).toBe(201);
    const second = await adopt('88');
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { message: string } };
    expect(body.error.message).toContain('grid-buy order is already tracked');
  });

  it('POST adopt 422s when the snapshot order id is not an integer', async () => {
    await writeSnapshot([owned('not-a-number')]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: 'not-a-number', mode: 'test' }),
    });
    expect(res.status).toBe(422);
  });

  it('POST adopt 422s on a malformed body (missing mode)', async () => {
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '10' }),
    });
    expect(res.status).toBe(422);
  });

  it('POST adopt 409s when the orphan is on a different Binance environment than the profile', async () => {
    // The order is a LIVE-account orphan; Alice's profile is testnet. Adopting
    // it would track an order id that does not exist on the testnet account.
    await writeSnapshot([owned('66', { mode: 'live' })]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '66', mode: 'live' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('live account');
  });

  it('POST adopt REFUSES an order no profile on the account placed — cancel-or-leave, never guess', async () => {
    // The Jul-11 incident, made impossible. The operator adopted trailing-trade's
    // protective stops into a MOMENTUM profile, which could not recognise, reprice,
    // or cancel them — so they rested on Binance locking the base asset while
    // momentum's own stop was refused -2010 on every tick for three days. There is
    // no picker to mis-use any more: an order the account cannot prove it placed is
    // not adoptable, and the operator is told to cancel it on Binance or leave it.
    await writeSnapshot([orphan('55', fx.alice.accountId, { clientOrderId: 'mo-deadbeef-ps' })]);
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ orderId: '55', mode: 'test' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no profile on this account placed this order');
    // Nothing was tracked: a refusal leaves no phantom row behind.
    const tracked = await fx.di.pool.query(`select 1 from orders where binance_order_id = 55`);
    expect(tracked.rows).toHaveLength(0);
  });

  it('POST adopt lands in the profile that PLACED the order, not the one the operator is on', async () => {
    // Attribution keys on the PROFILE ID, not merely on the strategy: a sibling
    // trailing-trade profile on the same account cannot claim an id minted for
    // another. This is the property that makes "derive the owner" meaningful — with
    // a picker, both profiles looked equally plausible to the operator.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       select $1, account_id, 'sibling', strategy_name, strategy_version, config, '{}'
       from profiles where id = $2`,
      [sibling, fx.alice.profileId],
    );
    try {
      await writeSnapshot([
        orphan('56', fx.alice.accountId, {
          symbol: 'ETHUSDT',
          clientOrderId: firstBuyClientOrderId(sibling, 'ETHUSDT'),
        }),
      ]);
      const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/orphan-orders/adopt`, {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ orderId: '56', mode: 'test' }),
      });
      expect(res.status).toBe(201);
      const row = await fx.di.pool.query(
        `select profile_id from orders where binance_order_id = 56 and closed_at is null`,
      );
      expect(row.rows[0]?.profile_id).toBe(sibling);
    } finally {
      await fx.di.pool.query('delete from profiles where id = $1', [sibling]);
    }
  });
});
