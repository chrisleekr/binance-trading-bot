import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOBAL_KEYS, profileKey } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the per-symbol config-override surface: an
 * override must be validated against the profile's strategy before it is
 * stored, a null override must reset the symbol to the inherited profile
 * config, and every route must stay account-scoped. Integration-level
 * because the validation depends on a real strategy registry and the
 * override is persisted through the scoped repo.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('symbols router — per-symbol config override', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // Seed the exchangeInfo cache the add-symbol existence check reads, so the
    // attach below validates offline (no live Binance fetch) and a fake pair
    // can be asserted as rejected (#365). BTCUSDT and ETHUSDT are TRADING.
    await fx.di.redis.raw().set(
      'exchange-info:cache',
      JSON.stringify({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
        ],
        fetchedAt: '2026-05-31T00:00:00.000Z',
      }),
    );
    // Attach BTCUSDT to Alice's profile so the override routes have a row.
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'BTCUSDT' }),
      },
    );
    // Seed a valid profile config so the merged effective config validates.
    await fx.di.pool.query(`update profiles set config = $2::jsonb where id = $1`, [
      fx.alice.profileId,
      JSON.stringify({
        symbol: 'BTCUSDT',
        candleInterval: '1h',
        buy: { enabled: true, maxPurchaseAmount: '10', avgEntryPriceRemoveThreshold: '0' },
        sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      }),
    ]);
  });

  // The base-asset exclusivity cases below add sibling profiles under Alice's
  // account. Left behind, a sibling keeps owning BTC and every later case that
  // binds BTCUSDT to Alice's primary profile 409s. `profile_symbols` cascades on
  // profile delete, so dropping the sibling row is enough.
  afterEach(async () => {
    await fx.di.pool.query(`delete from profiles where account_id = $1 and id <> $2`, [
      fx.alice.accountId,
      fx.alice.profileId,
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('rejects adding a pair that is not listed/TRADING on Binance with 422 (#365)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'ZZZFAKEUSDT' }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('GET returns the single symbol row with a null override by default', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      symbol: 'BTCUSDT',
      overrideConfig: null,
      source: 'manual',
      reserveBaseQuantity: null,
    });
  });

  it('GET 404s for a symbol not attached to the profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('PATCH stores a valid partial override', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ overrideConfig: { buy: { maxPurchaseAmount: '25' } } }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overrideConfig: { buy: { maxPurchaseAmount: string } } };
    expect(body.overrideConfig.buy.maxPurchaseAmount).toBe('25');
  });

  it('PATCH rejects an override that fails the strategy schema with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        // Must target a field the live schema still declares. `buy.maxPurchaseAmount`
        // was removed in trailing-trade v2 and the `buy` sub-object is deliberately
        // non-strict (a stale v1 override must still parse), so a bad value there is
        // stripped rather than rejected — this assertion only ever passed because the
        // harness's empty registry made the route 422 on "strategy not registered".
        body: JSON.stringify({
          overrideConfig: { buy: { avgEntryPriceRemoveThreshold: 'nope' } },
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('PATCH rejects an override carrying candleInterval with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ overrideConfig: { candleInterval: '5m' } }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('PATCH rejects a shape-valid override whose merged config fails a cross-field rule', async () => {
    // Every field is individually valid; the ladder ordering is not. Level 0 must
    // pin to 1 and every later level must sit below it, so a rising ladder trips
    // the buy superRefine. This exercises validateOverride's second parse against
    // configSchema. (The previous payload paired autoTriggerBuy with a grid ladder
    // and asserted the superRefine forbids it — it does not; no such rule exists.)
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({
          overrideConfig: {
            buy: {
              gridLevels: [
                { triggerPercentage: '1', maxPurchaseAmount: '10' },
                { triggerPercentage: '1.2', maxPurchaseAmount: '10' },
              ],
            },
          },
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('PATCH with a null override resets to the inherited profile config', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ overrideConfig: null }),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { overrideConfig: unknown }).toEqual({
      symbol: 'BTCUSDT',
      overrideConfig: null,
      source: 'manual',
      reserveBaseQuantity: null,
    });
  });

  it('POST attaches a symbol as source=manual by default', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'BTCUSDT' }),
      },
    );
    expect(res.status).toBe(201);
    expect((await res.json()) as { source: string }).toMatchObject({ source: 'manual' });
  });

  it('Pin flips a discovery-rotated (auto) symbol back to manual', async () => {
    // Simulate discovery having rotated BTCUSDT in. Slice 1 has no cron yet, so
    // set source directly; the Pin route is the operator's "keep this" action.
    await fx.di.pool.query(
      `update profile_symbols set source = 'auto' where profile_id = $1 and symbol = $2`,
      [fx.alice.profileId, 'BTCUSDT'],
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/pin`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { source: string }).toMatchObject({ source: 'manual' });
    // Durable: a subsequent GET still reports manual.
    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect((await after.json()) as { source: string }).toMatchObject({ source: 'manual' });
  });

  it('Pin 404s for a symbol not attached to the profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT/pin`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('Unpin returns a manual symbol to discovery (source=auto), inverse of pin', async () => {
    // BTCUSDT was added manual by the create test; unpin flips it to auto.
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/unpin`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { source: string }).toMatchObject({ source: 'auto' });
    // Durable: a subsequent GET still reports auto.
    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect((await after.json()) as { source: string }).toMatchObject({ source: 'auto' });
    // Restore manual so later cases in this suite see the original source.
    await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/pin`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
      },
    );
  });

  it('Unpin 404s for a symbol not attached to the profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT/unpin`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('502s a positive reserve on a cold profile with no balance snapshot to validate against', async () => {
    // BTCUSDT is attached, but no account-info snapshot or ledger row exists yet
    // (runs before the seeding case below), so the holding check cannot resolve a
    // balance and the route surfaces the documented "enable the profile first" 502.
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reserve`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ reserveBaseQuantity: '1' }),
      },
    );
    expect(res.status).toBe(502);
  });

  it('sets a per-symbol reserve within the live holding and round-trips it', async () => {
    // Seed the wallet snapshot the holding check reads (BTC free 5) plus the
    // global symbol-info the balance read joins on.
    await fx.di.redis
      .raw()
      .set(
        profileKey({ accountId: fx.alice.accountId, profileId: fx.alice.profileId }, 'accountInfo'),
        JSON.stringify({ balances: { BTC: { free: '5', locked: '0' } } }),
      );
    await fx.di.redis
      .raw()
      .set(GLOBAL_KEYS.symbolInfo('BTCUSDT'), JSON.stringify({ baseAsset: 'BTC' }));
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reserve`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ reserveBaseQuantity: '2' }),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { reserveBaseQuantity: string }).toMatchObject({
      symbol: 'BTCUSDT',
      reserveBaseQuantity: '2',
    });
    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect((await after.json()) as { reserveBaseQuantity: string }).toMatchObject({
      reserveBaseQuantity: '2',
    });
  });

  it('rejects a reserve larger than the live holding with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reserve`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ reserveBaseQuantity: '10' }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('clears the reserve with null and skips the holding check', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT/reserve`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ reserveBaseQuantity: null }),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { reserveBaseQuantity: null }).toMatchObject({
      reserveBaseQuantity: null,
    });
  });

  it('404s a reserve on a symbol not attached to the profile, even a positive amount', async () => {
    // Attachment is resolved before the holding check, so a positive reserve on an
    // unattached symbol returns 404 (not the 422/502 the holding check would give).
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT/reserve`,
      {
        method: 'PUT',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ reserveBaseQuantity: '5' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('denies cross-account access to another user profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('rejects adding a symbol a sibling profile on the same account already manages (409)', async () => {
    // A second profile under Alice (same user + binance_mode 'test' = same
    // Binance account) already manages XRPUSDT. The exclusivity guard must stop
    // Alice's primary profile from binding it too — two profiles cannot size
    // sells / arm stops on one shared base-asset balance.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'sibling', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [sibling, fx.alice.accountId],
    );
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'XRPUSDT', 'XRP', 'auto')`,
      [sibling],
    );
    // Make XRPUSDT pass the Binance-tradable existence check (additive — keeps
    // the BTC/ETH entries the other cases rely on).
    await fx.di.redis.raw().set(
      'exchange-info:cache',
      JSON.stringify({
        symbols: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
          {
            symbol: 'XRPUSDT',
            baseAsset: 'XRP',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
        ],
        fetchedAt: '2026-05-31T00:00:00.000Z',
      }),
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'XRPUSDT' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('already managed by');
  });

  it('rejects a different symbol over the same base a sibling manages (cross-quote, 409)', async () => {
    // A sibling under Alice manages BTCUSDT. Alice's primary then tries BTCFDUSD:
    // a different symbol but the same BTC wallet line, so base-asset exclusivity
    // must block it where a symbol-only guard would not.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'sibling-cross', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [sibling, fx.alice.accountId],
    );
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source) values ($1, 'BTCUSDT', 'BTC', 'auto')`,
      [sibling],
    );
    // Keep BTCUSDT/ETHUSDT so later add cases in this file still resolve them
    // (the cache key is shared across tests); add BTCFDUSD for this case.
    await fx.di.redis.raw().set(
      'exchange-info:cache',
      JSON.stringify({
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
          {
            symbol: 'BTCFDUSD',
            baseAsset: 'BTC',
            quoteAsset: 'FDUSD',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
        ],
        fetchedAt: '2026-05-31T00:00:00.000Z',
      }),
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'BTCFDUSD' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('already managed by');
  });

  it('rejects a base equal to a sibling profile’s quote asset (#665, 409)', async () => {
    // Symmetric exclusivity backstop: a sibling under Alice QUOTES ETH (funds its
    // buys from the shared ETH balance). Alice's primary must not bind ETH as a
    // tradable base — sizing sells / arming stops against a balance the sibling
    // silently spends. #661 guarded only the discovery pre-filter; this pins the
    // manual-add funnel.
    const sibling = randomUUID();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state, quote_asset)
       values ($1, $2, 'sibling-quote', 'trailing-trade', '1.0.0', '{}', '{}', 'ETH')`,
      [sibling, fx.alice.accountId],
    );
    // Keep BTCUSDT/ETHUSDT resolvable (shared cache key across tests).
    await fx.di.redis.raw().set(
      'exchange-info:cache',
      JSON.stringify({
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          {
            symbol: 'ETHUSDT',
            baseAsset: 'ETH',
            quoteAsset: 'USDT',
            status: 'TRADING',
            filterTickSize: '0.01',
          },
        ],
        fetchedAt: '2026-05-31T00:00:00.000Z',
      }),
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'ETHUSDT' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
  });

  it('add and remove bust the dashboard cache so the symbol list is fresh on the next read', async () => {
    const dashboardUrl = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/dashboard`;
    const symbolsOf = async (): Promise<string[]> => {
      const res = await fx.app.request(dashboardUrl, { headers: headers(fx.alice.userId) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { symbols: { symbol: string }[] };
      return body.symbols.map((s) => s.symbol);
    };

    // Warm the 5s-TTL dashboard cache without ETHUSDT.
    expect(await symbolsOf()).not.toContain('ETHUSDT');

    // Add it. Without the cache-bust the warmed payload would still answer
    // the next read (no symbol in the key for a symbol-scoped wipe to hit),
    // so ETHUSDT would be invisible until the TTL — the reported flake.
    const add = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'ETHUSDT' }),
      },
    );
    expect(add.status).toBe(201);
    expect(await symbolsOf()).toContain('ETHUSDT');

    // Remove it — same cache must drop it immediately on the next read.
    const del = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT`,
      {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      },
    );
    expect(del.status).toBe(204);
    expect(await symbolsOf()).not.toContain('ETHUSDT');
  });

  it('DELETE untrack clears the durable symbol_states row so a re-add cold-loads fresh', async () => {
    // Attach ETHUSDT and seed a durable strategy-state row (as the worker would
    // after a fill). The untrack must drop it, otherwise a re-add would revive a
    // stale position the operator never asked the profile to hold.
    const add = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'ETHUSDT' }),
      },
    );
    expect(add.status).toBe(201);
    await fx.di.pool.query(
      `insert into symbol_states (profile_id, symbol, state, strategy_version)
       values ($1, 'ETHUSDT', $2::jsonb, '2.0.0')
       on conflict (profile_id, symbol) do update set state = excluded.state`,
      [fx.alice.profileId, JSON.stringify({ schemaVersion: '2.0.0', avgEntryPrice: '1500' })],
    );

    const del = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT`,
      {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      },
    );
    expect(del.status).toBe(204);

    const states = await fx.di.pool.query(
      `select 1 from symbol_states where profile_id = $1 and symbol = 'ETHUSDT'`,
      [fx.alice.profileId],
    );
    expect(states.rowCount).toBe(0);
    // The profile_symbols binding is gone too (the untrack, unchanged).
    const bound = await fx.di.pool.query(
      `select 1 from profile_symbols where profile_id = $1 and symbol = 'ETHUSDT'`,
      [fx.alice.profileId],
    );
    expect(bound.rowCount).toBe(0);
  });

  it('DELETE untrack stays 204 when a claimed override survives the wipe', async () => {
    // The override-cancel route answers 409 for a claimed row, because cancelling one
    // action while the bot is acting on it is a contradiction. A symbol wipe is not
    // that request: it is a wholesale teardown that drops the binding, the state and
    // the cache regardless, and the claimed row it cannot delete is left to the
    // worker's own settle/reaper path. Reporting a conflict here would block the
    // teardown on a row the operator is not asking about.
    const add = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
      {
        method: 'POST',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ symbol: 'ETHUSDT' }),
      },
    );
    expect(add.status).toBe(201);
    // A row a tick has claimed: `processing_at` set, so the wipe's delete skips it.
    const seeded = await fx.di.pool.query<{ id: string }>(
      `insert into override_actions (profile_id, symbol, action, action_at, payload, triggered_by, processing_at)
       values ($1, 'ETHUSDT', 'buy', now(), '{}'::jsonb, 'test', now())
       returning id`,
      [fx.alice.profileId],
    );
    const overrideKey = profileKey(
      { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
      'override',
      'ETHUSDT',
    );
    await fx.di.redis.raw().set(overrideKey, '{}');

    const del = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT`,
      { method: 'DELETE', headers: headers(fx.alice.userId) },
    );
    expect(del.status).toBe(204);

    // The claimed row outlives the wipe by design; the worker settles it.
    const survivor = await fx.di.pool.query(
      `select 1 from override_actions where id = $1 and consumed_at is null`,
      [seeded.rows[0]?.id],
    );
    expect(survivor.rowCount).toBe(1);
    // Unlike an override cancel, the teardown still drops the cache key.
    expect(await fx.di.redis.raw().exists(overrideKey)).toBe(0);
    const bound = await fx.di.pool.query(
      `select 1 from profile_symbols where profile_id = $1 and symbol = 'ETHUSDT'`,
      [fx.alice.profileId],
    );
    expect(bound.rowCount).toBe(0);
  });

  it('add and remove enqueue a worker resync (no static jobId) when the profile is enabled', async () => {
    // The worker reads a profile's symbols only at enable-time; without a
    // resync signal a symbol added or removed after start is never ticked
    // and gets no technicals computed. An enabled profile must enqueue
    // reconfigure-profile on both add and remove; a disabled one needs no
    // signal (the next start re-reads symbols fresh). The job must NOT carry
    // a static jobId — BullMQ would dedupe it against the retained completed
    // job and silently skip every resync after the first.
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue({} as never);
    try {
      await fx.di.pool.query(`update profiles set enabled = true where id = $1`, [
        fx.alice.profileId,
      ]);
      const add = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
        {
          method: 'POST',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ symbol: 'ETHUSDT' }),
        },
      );
      expect(add.status).toBe(201);
      const del = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/ETHUSDT`,
        {
          method: 'DELETE',
          headers: headers(fx.alice.userId),
        },
      );
      expect(del.status).toBe(204);

      const resyncs = addSpy.mock.calls.filter((call) => call[0] === 'reconfigure-profile');
      expect(resyncs).toHaveLength(2);
      for (const call of resyncs) {
        expect(call[1]).toMatchObject({
          userId: fx.alice.userId,
          profileId: fx.alice.profileId,
        });
        expect(call[2]).not.toHaveProperty('jobId');
      }
    } finally {
      addSpy.mockRestore();
      await fx.di.pool.query(`update profiles set enabled = false where id = $1`, [
        fx.alice.profileId,
      ]);
    }
  });

  it('combined add-symbol + entry price seeds the ledger and enqueues the force-set job (#496)', async () => {
    // Adding a coin the operator already holds, priced, in one step: size the
    // held quantity from the wallet snapshot, seed the avg_entry_prices ledger,
    // and enqueue the force-set job so the running strategy manages and can sell
    // the held position instead of treating it as flat.
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue({} as never);
    try {
      await fx.di.pool.query(`update profiles set enabled = true where id = $1`, [
        fx.alice.profileId,
      ]);
      // Wallet holds 3 ETH; the balance read joins the global symbol-info.
      await fx.di.redis
        .raw()
        .set(
          profileKey(
            { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
            'accountInfo',
          ),
          JSON.stringify({ balances: { ETH: { free: '3', locked: '0' } } }),
        );
      await fx.di.redis
        .raw()
        .set(GLOBAL_KEYS.symbolInfo('ETHUSDT'), JSON.stringify({ baseAsset: 'ETH' }));

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols`,
        {
          method: 'POST',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ symbol: 'ETHUSDT', avgEntryPrice: '1500' }),
        },
      );
      expect(res.status).toBe(201);

      // Ledger seeded with the operator's price + the full wallet quantity.
      const { rows } = await fx.di.pool.query<{ avg_entry_price: string; quantity: string }>(
        `select avg_entry_price, quantity from avg_entry_prices
         where profile_id = $1 and symbol = 'ETHUSDT'`,
        [fx.alice.profileId],
      );
      expect(Number(rows[0]?.avg_entry_price)).toBe(1500);
      expect(Number(rows[0]?.quantity)).toBe(3);

      // The force-set job is enqueued so the running strategy picks up the cost
      // basis (a reconfigure revive alone would no-op on a re-add of an
      // already-priced symbol).
      const applyCalls = addSpy.mock.calls.filter((c) => c[0] === 'apply-avg-entry-price');
      expect(applyCalls).toHaveLength(1);
      expect(applyCalls[0]?.[1]).toMatchObject({
        userId: fx.alice.userId,
        profileId: fx.alice.profileId,
        symbol: 'ETHUSDT',
      });
    } finally {
      addSpy.mockRestore();
      await fx.di.pool.query(
        `delete from avg_entry_prices where profile_id = $1 and symbol = 'ETHUSDT'`,
        [fx.alice.profileId],
      );
      await fx.di.pool.query(
        `delete from profile_symbols where profile_id = $1 and symbol = 'ETHUSDT'`,
        [fx.alice.profileId],
      );
      await fx.di.pool.query(`update profiles set enabled = false where id = $1`, [
        fx.alice.profileId,
      ]);
    }
  });

  it('PATCH override enqueues a worker resync (no static jobId) when the profile is enabled', async () => {
    // The worker caches the resolved tick context (config + merged override)
    // across ticks; a per-symbol override edit must enqueue reconfigure-profile
    // so the cache is evicted and the new override applies on the next tick
    // instead of waiting out the cache TTL. As with add/remove, the job must
    // not carry a static jobId or BullMQ would dedupe later resyncs away.
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue({} as never);
    try {
      await fx.di.pool.query(`update profiles set enabled = true where id = $1`, [
        fx.alice.profileId,
      ]);
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/BTCUSDT`,
        {
          method: 'PATCH',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ overrideConfig: { buy: { maxPurchaseAmount: '25' } } }),
        },
      );
      expect(res.status).toBe(200);

      const resyncs = addSpy.mock.calls.filter((call) => call[0] === 'reconfigure-profile');
      expect(resyncs).toHaveLength(1);
      expect(resyncs[0]?.[1]).toMatchObject({
        userId: fx.alice.userId,
        profileId: fx.alice.profileId,
      });
      expect(resyncs[0]?.[2]).not.toHaveProperty('jobId');
    } finally {
      addSpy.mockRestore();
      await fx.di.pool.query(`update profiles set enabled = false where id = $1`, [
        fx.alice.profileId,
      ]);
    }
  });
});
