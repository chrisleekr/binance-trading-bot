import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asProfileId, TriggerResponse } from '@app/contracts';
import { profileKey } from '@app/db';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * The operator-action capability gate. An operator action a strategy does not
 * declare must be rejected at the api with 422 ACTION_UNSUPPORTED *before* any
 * override row is written or job enqueued — the kill for the momentum
 * silent-drop, where a force-buy used to return 202, write an override row, and
 * then be silently ignored by a tick that reads no override. Integration-level
 * because the gate reads the live strategy registry and the override write goes
 * through the scoped repo.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

// `Response#json()` is `unknown`, so the wire shape is named once here rather than re-asserted at every read below.
interface ErrorBody {
  error: { code: string; message: string };
}
const errorBody = async (res: Response): Promise<ErrorBody> => (await res.json()) as ErrorBody;

interface SymbolStateBody {
  strategy: { operatorActions: string[] };
}
const stateBody = async (res: Response): Promise<SymbolStateBody> =>
  (await res.json()) as SymbolStateBody;

// Owned by Alice; carries the momentum strategy, which declares ONLY
// `trigger-sell` (force-sell). Every other operator route — trigger-buy,
// reset-grid, manual-order — must still 422 against it, while force-eject
// (which needs `trigger-sell`) is now permitted.
const MOMENTUM_PROFILE = '00000000-0000-4000-8000-00000000a401';

// A locally-seeded trailing-trade profile: the shared fixture's profile is not
// usable on the override routes, and the breaker pre-flight needs a strategy
// that actually declares the buy-side operator actions.
const TT_PROFILE = '00000000-0000-4000-8000-00000000a402';

/** A trailing-trade version the registry does not serve, so drift is genuine. */
const STALE_VERSION = '1.0.0';

describeIfInfra('manual-orders router — operator-action capability gate', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    const registry = buildStrategyRegistry();
    const tt = registry.get('trailing-trade');
    const momentum = registry.get('momentum');
    if (!tt || !momentum) throw new Error('expected trailing-trade and momentum to be registered');
    // Pin Alice to a stale version: the exact state a live profile lands in
    // after a strategy version bump with no re-pin. Before issue #407 the api
    // keyed get() on name@version, so this drift returned null and 422'd every
    // operator control / hid every panel. This suite used to inherit the drift
    // from a seed hardcoded at `1.0.0`; once the seed tracks the registry the
    // drift silently vanishes and the regression goes uncovered. Manufacture it
    // here, and guard that the literal really is stale.
    expect(tt.version).not.toBe(STALE_VERSION);
    await fx.di.pool.query(`update profiles set strategy_version = $2 where id = $1`, [
      fx.alice.profileId,
      STALE_VERSION,
    ]);
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'momentum demo', 'momentum', $3, '{}', '{}')`,
      [MOMENTUM_PROFILE, fx.alice.accountId, momentum.version],
    );
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'halt-preflight', 'trailing-trade', $3, '{}', '{}')`,
      [TT_PROFILE, fx.alice.accountId, tt.version],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('rejects a force-buy on a strategy that does not declare trigger-buy, writing nothing (the silent-drop kill)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${MOMENTUM_PROFILE}/symbols/BTCUSDT/trigger-buy`,
      { method: 'POST', headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(422);
    expect((await errorBody(res)).error.code).toBe('ACTION_UNSUPPORTED');
    // The previous behaviour wrote an override_actions row and returned 202;
    // the gate fires before record(), so the table must be untouched.
    const { rows } = await fx.di.pool.query(
      `select count(*)::int as n from override_actions where profile_id = $1`,
      [MOMENTUM_PROFILE],
    );
    expect(rows[0].n).toBe(0);
  });

  describe('daily-loss breaker pre-flight', () => {
    // Built from the shared key helper, never hand-spelled: the route reads the
    // same builder, and a typo here would arm nothing and pass vacuously.
    const haltKey = (): string =>
      profileKey(
        { accountId: fx.alice.accountId, profileId: asProfileId(TT_PROFILE) },
        'entryHaltDaily',
      );
    const overrideKey = (): string =>
      profileKey(
        { accountId: fx.alice.accountId, profileId: asProfileId(TT_PROFILE) },
        'override',
        'BTCUSDT',
      );
    const ttPath = (suffix: string): string =>
      `/api/accounts/${fx.alice.accountId}/profiles/${TT_PROFILE}/symbols/BTCUSDT${suffix}`;

    afterEach(async () => {
      await fx.di.redis.raw().del(haltKey(), overrideKey());
      await fx.di.pool.query(`delete from override_actions where profile_id = $1`, [TT_PROFILE]);
    });

    it('refuses a force-buy with 409 while the breaker is armed, writing no row and no Redis key', async () => {
      // The breaker runs to the next UTC day; the override lives 5 minutes. A
      // 202 here would record a row and a key the tick is guaranteed to throw
      // away, and the operator would learn it failed minutes later.
      await fx.di.redis.raw().set(haltKey(), '1');

      const res = await fx.app.request(ttPath('/trigger-buy'), {
        method: 'POST',
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(409);
      expect((await errorBody(res)).error.code).toBe('CONFLICT');

      const { rows } = await fx.di.pool.query(
        `select count(*)::int as n from override_actions where profile_id = $1`,
        [TT_PROFILE],
      );
      expect(rows[0].n).toBe(0);
      expect(await fx.di.redis.raw().exists(overrideKey())).toBe(0);
    });

    it('refuses a BUY-side manual order but never an exit', async () => {
      await fx.di.redis.raw().set(haltKey(), '1');

      const buy = await fx.app.request(ttPath('/manual-order'), {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ side: 'BUY', type: 'MARKET', quoteAmount: '20' }),
      });
      expect(buy.status).toBe(409);

      // The breaker pauses new risk; it must never trap the operator in a
      // position. Asserted as ACCEPTED, not merely "not 409": `not.toBe(409)`
      // passes on a 500 or a 422 just as happily, so it would prove the route did
      // not answer 409 — not that the exit went through.
      for (const exit of [
        fx.app.request(ttPath('/manual-order'), {
          method: 'POST',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ side: 'SELL', type: 'MARKET', quantity: '1' }),
        }),
        fx.app.request(ttPath('/trigger-sell'), {
          method: 'POST',
          headers: headers(fx.alice.userId),
        }),
      ]) {
        expect((await exit).status).toBe(202);
      }
    });

    it('does not refuse a force-buy when the breaker is not armed', async () => {
      const res = await fx.app.request(ttPath('/trigger-buy'), {
        method: 'POST',
        headers: headers(fx.alice.userId),
      });
      expect(res.status).toBe(202);
    });

    // The bulk route gates on the LOWERCASE `side === 'buy'` while the single
    // route gates on `'BUY'` — two adjacent lines, two different casings, because
    // `ManualOrderAllRequest.side` is `z.enum(['buy','sell'])` and
    // `ManualOrderRequest.side` is an `OrderSide`. Flip either and the breaker
    // silently stops refusing a bulk buy-everything, which is the single largest
    // new-risk action the app offers. Pin both directions.
    const allPath = (): string =>
      `/api/accounts/${fx.alice.accountId}/profiles/${TT_PROFILE}/manual-order-all`;

    it('refuses a bulk buy-everything with 409 while the breaker is armed, writing no rows', async () => {
      await fx.di.redis.raw().set(haltKey(), '1');

      const res = await fx.app.request(allPath(), {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ side: 'buy', quote: 'USDT', quoteAmount: '20' }),
      });
      expect(res.status).toBe(409);
      expect((await errorBody(res)).error.code).toBe('CONFLICT');

      // The gate fires before the fan-out's first record(), so not one row may exist.
      const { rows } = await fx.di.pool.query(
        `select count(*)::int as n from override_actions where profile_id = $1`,
        [TT_PROFILE],
      );
      expect(rows[0].n).toBe(0);
    });

    it('never refuses a bulk sell-everything, armed breaker or not', async () => {
      await fx.di.redis.raw().set(haltKey(), '1');

      const res = await fx.app.request(allPath(), {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ side: 'sell', quote: 'USDT', marketQuantity: '1' }),
      });
      // The breaker pauses new risk; a panic sell-everything is the operator
      // getting OUT of risk, and must never be blocked by it.
      expect(res.status).toBe(202);
    });
  });

  it('rejects reset-grid on a non-grid strategy without enqueueing a job', async () => {
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${MOMENTUM_PROFILE}/symbols/BTCUSDT/reset-grid-trade`,
      { method: 'POST', headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(422);
    expect((await errorBody(res)).error.code).toBe('ACTION_UNSUPPORTED');
    expect(addSpy).not.toHaveBeenCalled();
    addSpy.mockRestore();
  });

  it('lets a grid strategy through the gate (regression: the gate does not over-block)', async () => {
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reset-grid-trade`,
      { method: 'POST', headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(204);
    expect(addSpy).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
  });

  it('permits force-eject on momentum now that it declares trigger-sell, scheduling a SELL', async () => {
    // momentum declares `trigger-sell`, which force-eject requires, so the gate
    // now passes and a SELL override is recorded (the operator can flatten).
    fx.di.redis.forProfile = (() => ({
      set: async () => undefined,
      get: async () => null,
      del: async () => undefined,
    })) as unknown as typeof fx.di.redis.forProfile;
    fx.di.tickQueue = { add: async () => undefined } as never;
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'BTCUSDT', 'BTC', 'auto')
       on conflict (profile_id, symbol) do update set source = 'auto', last_flatten_at = null`,
      [MOMENTUM_PROFILE],
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${MOMENTUM_PROFILE}/symbols/BTCUSDT/force-eject`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ blocklist: false }),
      },
    );
    expect(res.status).toBe(202);
    const { rows } = await fx.di.pool.query<{ action: string }>(
      `select action from override_actions where profile_id = $1 and symbol = 'BTCUSDT' order by action_at desc limit 1`,
      [MOMENTUM_PROFILE],
    );
    expect(rows[0]?.action).toBe('sell');
  });

  it('force-eject flattens via a SELL override and (blocklist:true) blacklists the symbol', async () => {
    // The bare fixture wires redis.forProfile to throw (no route test executes a
    // real override). Fake the override surface so this reaches the force-eject-
    // specific logic: the SELL override record, the cooldown stamp, the blocklist.
    fx.di.redis.forProfile = (() => ({
      set: async () => undefined,
      get: async () => null,
      del: async () => undefined,
    })) as unknown as typeof fx.di.redis.forProfile;
    fx.di.tickQueue = { add: async () => undefined } as never;
    // An auto-discovered, held symbol — so recordFlatten has a row to stamp.
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'ETHUSDT', 'ETH', 'auto')
       on conflict (profile_id, symbol) do update set source = 'auto', last_flatten_at = null`,
      [fx.alice.profileId],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT/force-eject`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ blocklist: true }),
      },
    );
    expect(res.status).toBe(202);
    const { rows } = await fx.di.pool.query<{ action: string }>(
      `select action from override_actions where profile_id = $1 and symbol = 'ETHUSDT' order by action_at desc limit 1`,
      [fx.alice.profileId],
    );
    expect(rows[0]?.action).toBe('sell'); // a SELL was scheduled
    // The re-add cooldown was stamped on the symbol row.
    const flat = await fx.di.pool.query<{ last_flatten_at: Date | null }>(
      `select last_flatten_at from profile_symbols where profile_id = $1 and symbol = 'ETHUSDT'`,
      [fx.alice.profileId],
    );
    expect(flat.rows[0]?.last_flatten_at).not.toBeNull();
    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(
      ((await after.json()) as { config: { blacklist: string[] } }).config.blacklist,
    ).toContain('ETHUSDT');
  });

  it('returns the armed row createdAt in the arm receipt so a watch has a server-clock baseline', async () => {
    // `scheduledAt` is `action_at`, stamped on the API clock and a different
    // column from `created_at`. A watcher that compares it against the
    // `created_at` the read-back endpoint orders by is comparing two clocks,
    // so it cannot tell an older sibling from a newer one.
    fx.di.redis.forProfile = (() => ({
      set: async () => undefined,
      get: async () => null,
      del: async () => undefined,
    })) as unknown as typeof fx.di.redis.forProfile;
    fx.di.tickQueue = { add: async () => undefined } as never;
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'ADAUSDT', 'ADA', 'auto')
       on conflict (profile_id, symbol) do update set source = 'auto', last_flatten_at = null`,
      [fx.alice.profileId],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ADAUSDT/force-eject`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ blocklist: false }),
      },
    );
    expect(res.status).toBe(202);
    const receipt = TriggerResponse.parse(await res.json());
    const { rows } = await fx.di.pool.query<{ created_at: Date }>(
      `select created_at from override_actions where id = $1`,
      [receipt.overrideActionId],
    );
    expect(receipt.createdAt).toBe(rows[0]?.created_at.toISOString());
  });

  it('GET state carries the strategy operator-action set, filled from the registry', async () => {
    // The db projection leaves operatorActions empty; the api state route fills
    // it from the registry. Assert both ends so a regression to the empty
    // projection value (which would silently hide every panel) is caught.
    const tt = buildStrategyRegistry().get('trailing-trade');
    if (!tt) throw new Error('expected trailing-trade to be registered');
    const ttActions = [...tt.capabilities.operatorActions];

    const ttRes = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/state`,
      { headers: headers(fx.alice.userId) },
    );
    expect(ttRes.status).toBe(200);
    expect((await stateBody(ttRes)).strategy.operatorActions).toEqual(ttActions);

    const momRes = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${MOMENTUM_PROFILE}/symbols/BTCUSDT/state`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(momRes.status).toBe(200);
    expect((await stateBody(momRes)).strategy.operatorActions).toEqual(['trigger-sell']);
  });

  it('resolves a version-drifted profile to the live plugin (issue #407 regression)', async () => {
    // Alice's profile row is pinned to the stale seed version while the live
    // plugin has bumped. Assert the drift is real on the row, then that an
    // operator route resolves it instead of 422-ing STRATEGY_NOT_REGISTERED.
    const { rows } = await fx.di.pool.query<{ strategy_version: string }>(
      `select strategy_version from profiles where id = $1`,
      [fx.alice.profileId],
    );
    const tt = buildStrategyRegistry().get('trailing-trade');
    if (!tt) throw new Error('expected trailing-trade to be registered');
    expect(rows[0]?.strategy_version).not.toBe(tt.version); // drift is genuine

    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reset-grid-trade`,
      { method: 'POST', headers: headers(fx.alice.userId) },
    );
    // Before #407: 422 STRATEGY_NOT_REGISTERED (drifted version not in the
    // name@version map). After: the live plugin gates the action → 204.
    expect(res.status).toBe(204);
    addSpy.mockRestore();
  });

  it('PATCH config on a version-drifted profile validates against the live schema, not STRATEGY_NOT_REGISTERED (#407)', async () => {
    // Drifted Alice. Before #407 the stored 1.0.0 missed the name@version map
    // and PATCH 422'd "strategy not registered for profile" — the operator
    // could not fix a drifted config at all. After: describeForProfile resolves
    // the live plugin and the config is validated against its schema, so a
    // bogus config fails with the config-validation message instead.
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ config: { definitely: 'not-a-valid-tt-config' } }),
      },
    );
    expect(res.status).toBe(422);
    const msg = (await errorBody(res)).error.message;
    expect(msg).toContain('invalid strategy config'); // live-schema validation ran
    expect(msg).not.toContain('not registered'); // drift did NOT short-circuit
  });

  it('PATCH symbol override on a version-drifted profile validates against the live schema (#407)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ overrideConfig: { definitely: 'not-a-valid-tt-override' } }),
      },
    );
    expect(res.status).toBe(422);
    const msg = (await errorBody(res)).error.message;
    expect(msg).toContain('invalid symbol override'); // live override schema ran
    expect(msg).not.toContain('not registered');
  });

  it('create rejects a known strategy at a non-current version (#407 — version stays load-bearing on create)', async () => {
    // The stored-row gates tolerate drift, but create must pin a real, current
    // identity: a known name with a version the live plugin does not ship 422s.
    const res = await fx.app.request(`/api/accounts/${fx.alice.accountId}/profiles`, {
      method: 'POST',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({
        name: 'drift-create',
        strategyName: 'trailing-trade',
        strategyVersion: '0.0.1-stale',
        config: {},
      }),
    });
    expect(res.status).toBe(422);
    expect((await errorBody(res)).error.code).toBe('VALIDATION_FAILED');
  });

  it('switch-strategy rejects a known strategy at a non-current version (#407)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/switch-strategy`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({
          strategyName: 'trailing-trade',
          strategyVersion: '0.0.1-stale',
          config: {},
        }),
      },
    );
    expect(res.status).toBe(422);
    expect((await errorBody(res)).error.code).toBe('VALIDATION_FAILED');
  });
});

// End-to-end proof of the ledger fallback in balanceQuantityForSymbol: a
// disabled, just-adopted profile has no live `account-info` Redis snapshot, but
// the avg_entry_prices ledger row carries a non-zero quantity. Setting the cost
// basis must size the write from that ledger quantity rather than 502-ing.
describeIfInfra('avg-entry-price PUT — ledger-quantity fallback (no live wallet snapshot)', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // Nothing to stub: the route's capability gate needs trailing-trade registered so it resolves `avg-entry-price`, and the fixture DI already boots the real registry.
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('sizes the write from the ledger quantity when no account-info snapshot exists, preserving quantity', async () => {
    const symbol = 'XPLUSDT';
    // Alice's seeded profile is trailing-trade and enabled=false (default) — the
    // disabled / just-adopted state. Seed a cost-basis ledger row with a stale
    // price and a non-zero quantity.
    await fx.di.pool.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
       values ($1, $2, '0.05', '169.8')`,
      [fx.alice.profileId, symbol],
    );
    // Ensure there is no live account-info snapshot for this profile (the shared
    // Redis test DB may carry leftovers from another suite).
    const redis = fx.di.redis.raw();
    await redis.del(`tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:account-info`);

    // The route enqueues the worker force-set job (not a plain tick) so the
    // operator's price reaches the running strategy; spy + mock so the assertion
    // is exact and no real broker write is needed.
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/${symbol}/avg-entry-price`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ avgEntryPrice: '0.0905' }),
      },
    );
    expect(res.status).toBe(204);

    // The row carries the operator's new price; the quantity is preserved from
    // the ledger. pg returns numeric(38,18) as a fully-scaled string, so compare
    // numerically to stay robust to trailing-zero formatting.
    const { rows } = await fx.di.pool.query<{ avg_entry_price: string; quantity: string }>(
      `select avg_entry_price, quantity from avg_entry_prices where profile_id = $1 and symbol = $2`,
      [fx.alice.profileId, symbol],
    );
    expect(Number(rows[0]?.avg_entry_price)).toBe(0.0905);
    expect(Number(rows[0]?.quantity)).toBe(169.8);

    // #496: a plain tick never converges the ledger into state, so the route
    // must enqueue the dedicated force-set job for the symbol.
    const applyCalls = addSpy.mock.calls.filter((c) => c[0] === 'apply-avg-entry-price');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.[1]).toMatchObject({ profileId: fx.alice.profileId, symbol });
    addSpy.mockRestore();
  });

  it('DELETE removes the ledger and enqueues the force-set clear job', async () => {
    const symbol = 'ICPUSDT';
    await fx.di.pool.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
       values ($1, $2, '2.42', '6.25')
       on conflict (profile_id, symbol) do update set avg_entry_price = excluded.avg_entry_price`,
      [fx.alice.profileId, symbol],
    );
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/${symbol}/avg-entry-price`,
      { method: 'DELETE', headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(204);

    const { rows } = await fx.di.pool.query(
      `select 1 from avg_entry_prices where profile_id = $1 and symbol = $2`,
      [fx.alice.profileId, symbol],
    );
    expect(rows).toHaveLength(0);
    const applyCalls = addSpy.mock.calls.filter((c) => c[0] === 'apply-avg-entry-price');
    expect(applyCalls).toHaveLength(1);
    addSpy.mockRestore();
  });
});
