import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { GLOBAL_KEYS, profileRepo, schema } from '@app/db';
import { asProfileId, asUserId, DEFAULT_PROFILE_NOTIFY_EVENTS } from '@app/contracts';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { HAS_INFRA, setupApp, TRAILING_TRADE_VERSION, type ApiFixture } from '../_helpers.js';

/**
 * Profile route coverage for the first-class `quoteAsset` column: a PATCH
 * uppercases the value, returns it in the response, and persists it to the row.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('profiles router — quoteAsset', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('PATCH uppercases quoteAsset, returns it, and persists', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ quoteAsset: 'btc' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quoteAsset: string };
    expect(body.quoteAsset).toBe('BTC');

    // Persisted to the row, not just echoed back.
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    const row = await repo.profile.findById();
    expect(row?.quoteAsset).toBe('BTC');
  });

  it('PATCH sets benchmarkMode, returns it, and persists; default is btc', async () => {
    const before = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(((await before.json()) as { benchmarkMode: string }).benchmarkMode).toBe('btc');

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ benchmarkMode: 'basket' }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { benchmarkMode: string }).benchmarkMode).toBe('basket');

    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    expect((await repo.profile.findById())?.benchmarkMode).toBe('basket');
  });

  it('PATCH sets notifyEvents, returns it, and persists; default matches the contract', async () => {
    const before = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    // A null column reads back as the contract's defaults. Asserted against the
    // contract rather than a literal: this test was pinned to a 4-key snapshot
    // and silently rotted when `backtest-complete` / `order-filled` were added.
    expect(
      ((await before.json()) as { notifyEvents: Record<string, boolean> }).notifyEvents,
    ).toEqual(DEFAULT_PROFILE_NOTIFY_EVENTS);

    // A partial PATCH body is filled from the defaults on the way back out, so
    // the round-trip assertion below must compare against the full map.
    const muted = { ...DEFAULT_PROFILE_NOTIFY_EVENTS, alive: false };
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ notifyEvents: muted }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notifyEvents: Record<string, boolean> }).notifyEvents).toEqual(
      muted,
    );

    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    expect((await repo.profile.findById())?.notifyEvents).toEqual(muted);
  });

  it('rejects an unknown benchmarkMode', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ benchmarkMode: 'sp500' }),
      },
    );
    expect(res.status).toBe(422); // VALIDATION_FAILED
  });

  it('equity-snapshots GET reports benchmarkMode and passes benchmarkPrices through', async () => {
    await fx.app.request(`/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ benchmarkMode: 'basket' }),
    });
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    // Seed in whatever quote the profile currently settles in: a sibling test in this block PATCHes it, and the series is READ in one quote, so a hardcoded 'USDT' here would make this test depend on execution order rather than on what it means to assert.
    const currentQuote = (await repo.profile.findById())?.quoteAsset ?? 'USDT';
    const base = {
      quoteAsset: currentQuote,
      netPnlQuote: '10',
      realizedNetQuote: '5',
      positionValueQuote: '110',
      positionCostQuote: '100',
      benchmarkAsset: 'BTC',
      benchmarkPriceQuote: '50000',
      feeBasis: 'exact' as const,
    };
    await repo.equitySnapshots.record({ ...base, benchmarkPrices: { ETHUSDT: '2000' } });
    await repo.equitySnapshots.record(base); // old-style row, no benchmarkPrices
    await fx.di.db.insert(schema.equitySnapshots).values({
      profileId: fx.alice.profileId,
      ...base,
      netPnlQuote: '999',
      feeBasis: 'unknown',
    });
    // The middle tier, seeded because it is the arm a two-state fixture cannot see: `exact` and `unknown` alone cannot tell "carries the tier through" apart from "maps anything imperfect to one bucket". An account Binance bills in BNB has a reconstructed commission on every cycle, so this is its entire series.
    await fx.di.db.insert(schema.equitySnapshots).values({
      profileId: fx.alice.profileId,
      ...base,
      netPnlQuote: '888',
      feeBasis: 'estimated',
    });

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/equity-snapshots?limit=500`,
      { headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      benchmarkMode: string;
      points: { netPnlQuote: string; feeBasis: string; benchmarkPrices?: Record<string, string> }[];
    };
    expect(body.benchmarkMode).toBe('basket');
    expect(body.points.some((p) => p.benchmarkPrices?.['ETHUSDT'] === '2000')).toBe(true);
    // Every tier is served, `unknown` included, each carrying its own. A snapshot's realised leg is an all-time cumulative fold over an append-only archive, so its tier can only ever weaken and nothing revisits a closed row: withholding one here would not defer a point until better evidence arrives, it would blank the series permanently for any profile with a single historical fill Binance billed in an asset nobody valued. The route hands the tier to the caller, which is what lets the card mark the line instead of losing it.
    // Keyed numerically rather than by string identity: the column is `numeric(38,18)` and the wire carries its full scale, so `=== '999'` is false for a row that IS present. Each tier is named against its own row, so a route that served all three but collapsed them to one label still fails.
    const tierByPnl = new Map(body.points.map((p) => [Number(p.netPnlQuote), p.feeBasis]));
    expect(tierByPnl.get(10)).toBe('exact');
    expect(tierByPnl.get(888)).toBe('estimated');
    expect(tierByPnl.get(999)).toBe('unknown');
  });

  it('pins a finished backtest run as the baseline, then clears it', async () => {
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    const run = await repo.backtestRuns.create({ symbols: ['BTCUSDT'], params: {} });
    await repo.backtestRuns.markRunning(run.id);
    await repo.backtestRuns.complete(run.id, {});

    const patchBaseline = (id: string | null) =>
      fx.app.request(`/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`, {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ baselineBacktestRunId: id }),
      });

    const pinned = await patchBaseline(run.id);
    expect(pinned.status).toBe(200);
    expect(
      ((await pinned.json()) as { baselineBacktestRunId: string | null }).baselineBacktestRunId,
    ).toBe(run.id);

    const cleared = await patchBaseline(null);
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { baselineBacktestRunId: string | null }).baselineBacktestRunId,
    ).toBeNull();
  });

  it('clears the pin when the pinned backtest run is deleted (FK ON DELETE SET NULL)', async () => {
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    const run = await repo.backtestRuns.create({ symbols: ['BTCUSDT'], params: {} });
    await repo.backtestRuns.markRunning(run.id);
    await repo.backtestRuns.complete(run.id, {});
    await fx.app.request(`/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ baselineBacktestRunId: run.id }),
    });
    // Deleting the run must auto-unpin the profile, not orphan a dangling id.
    await fx.di.db.execute(sql`delete from backtest_runs where id = ${run.id}`);
    expect((await repo.profile.findById())?.baselineBacktestRunId).toBeNull();
  });

  it('rejects pinning an unfinished or unknown backtest run', async () => {
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(fx.alice.profileId),
    );
    const queued = await repo.backtestRuns.create({ symbols: ['BTCUSDT'], params: {} }); // not done
    const unfinished = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ baselineBacktestRunId: queued.id }),
      },
    );
    expect(unfinished.status).toBe(422);

    const unknown = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ baselineBacktestRunId: '00000000-0000-4000-8000-000000000000' }),
      },
    );
    expect(unknown.status).toBe(422);
  });

  // The gate-clear IS the live-propagation mechanism: deleting the per-profile
  // discovery refresh stamp makes the next cron wake re-discover against the new
  // quote (≤60s) instead of waiting up to refreshPeriodMs.
  const patch = (body: unknown) =>
    fx.app.request(`/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify(body),
    });

  it('clears the discovery refresh gate when the quote changes on an enabled profile', async () => {
    await patch({ enabled: true, quoteAsset: 'usdt' });
    const key = GLOBAL_KEYS.discoveryLastRun(fx.alice.profileId);
    await fx.di.redis.raw().set(key, '1700000000000');
    const res = await patch({ quoteAsset: 'btc' });
    expect(res.status).toBe(200);
    expect(await fx.di.redis.raw().get(key)).toBeNull();
  });

  it('leaves the discovery gate intact when the quote is unchanged', async () => {
    await patch({ enabled: true, quoteAsset: 'sol' });
    const key = GLOBAL_KEYS.discoveryLastRun(fx.alice.profileId);
    await fx.di.redis.raw().set(key, '42');
    // Same quote after uppercasing — no re-point, so the gate is preserved.
    await patch({ quoteAsset: 'SOL' });
    expect(await fx.di.redis.raw().get(key)).toBe('42');
  });

  it('leaves the discovery gate intact when the profile is disabled', async () => {
    await patch({ enabled: false, quoteAsset: 'usdt' });
    const key = GLOBAL_KEYS.discoveryLastRun(fx.alice.profileId);
    await fx.di.redis.raw().set(key, '99');
    // Disabled: the cron will not act on this profile, so don't bust its gate.
    await patch({ quoteAsset: 'xrp' });
    expect(await fx.di.redis.raw().get(key)).toBe('99');
  });

  it('enqueues reconfigure-profile when the patch includes config so the worker drops the stale tick context', async () => {
    // The route fires the reconfigure on config PRESENCE in the PATCH body (not a
    // value diff): any patch carrying `config` on an enabled profile evicts the
    // worker's cached tick context so the next tick reads fresh. Known baseline:
    // enabled. The config must pass the strategy's schema, so use the plugin's
    // own default config.
    const validConfig = buildStrategyRegistry().get('trailing-trade')?.defaultConfig;
    await patch({ enabled: true });
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    const res = await patch({ config: validConfig });
    expect(res.status).toBe(200);
    expect(addSpy).toHaveBeenCalledWith(
      'reconfigure-profile',
      { userId: fx.alice.userId, accountId: fx.alice.accountId, profileId: fx.alice.profileId },
      expect.anything(),
    );
    addSpy.mockRestore();
  });

  it('does not reconfigure when the config is unchanged', async () => {
    await patch({ enabled: true });
    const addSpy = vi.spyOn(fx.di.queue, 'add');
    await patch({ name: 'renamed' });
    expect(addSpy).not.toHaveBeenCalledWith(
      'reconfigure-profile',
      expect.anything(),
      expect.anything(),
    );
    addSpy.mockRestore();
  });

  it('returns 409 and keeps the profile when open orders exist', async () => {
    // Seed one LIVE open order (closed_at null) on the profile's symbol so the
    // delete guard's open-exposure count is non-zero.
    await fx.di.pool.query(
      `insert into orders
         (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
       values ($1, $2, 'BTCUSDT', 'BUY', 'manual', 9000001, 'tt-del-guard-b', 'NEW', '{}')`,
      [fx.alice.accountId, fx.alice.profileId],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'DELETE',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(409);

    // The exposure counts ride on the envelope so the UI can name what is open.
    const body = (await res.json()) as {
      error: { details: { openOrderCount: number; openPositionCount: number } };
    };
    expect(body.error.details).toEqual({ openOrderCount: 1, openPositionCount: 0 });

    // The profile row must survive the rejected delete.
    const get = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(get.status).toBe(200);
  });
});

// Each delete that consumes the profile gets its own freshly-seeded fixture so
// the cases stay order-independent (setupApp truncate+seeds per call).
describeIfInfra('profiles router — delete', () => {
  // INTENTIONAL BEHAVIOUR CHANGE. This case used to assert that `?force=true`
  // deleted the row while the order stayed live on Binance — that IS the bug: the
  // orphaned stop kept holding the operator's coins with nothing pointing at it.
  // Force is gone. A profile with exposure is DISPOSED of (the worker cancels on
  // Binance, then deletes), never abandoned, and the api — which has no Binance
  // client — may not delete the row itself.
  it('force=true is not a thing any more: exposure without a disposition is refused and the row survives', async () => {
    const fx = await setupApp();
    try {
      await fx.di.pool.query(
        `insert into orders
           (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
         values ($1, $2, 'BTCUSDT', 'BUY', 'manual', 9000002, 'tt-del-guard-f', 'NEW', '{}')`,
        [fx.alice.accountId, fx.alice.profileId],
      );

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}?force=true`,
        { method: 'DELETE', headers: headers(fx.alice.userId) },
      );
      expect(res.status).toBe(409);

      const get = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        { headers: headers(fx.alice.userId) },
      );
      expect(get.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
  });

  it('a chosen disposition enqueues dispose-profile and leaves the row for the worker to delete', async () => {
    const fx = await setupApp();
    try {
      await fx.di.pool.query(
        `insert into orders
           (account_id, profile_id, symbol, side, intent, binance_order_id, client_order_id, status, raw)
         values ($1, $2, 'BTCUSDT', 'SELL', 'manual', 9000003, 'tt-del-dispose', 'NEW', '{}')`,
        [fx.alice.accountId, fx.alice.profileId],
      );
      const addSpy = vi.spyOn(fx.di.queue, 'add');

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}?disposition=cancel-orders`,
        { method: 'DELETE', headers: headers(fx.alice.userId) },
      );
      expect(res.status).toBe(202);
      expect(addSpy).toHaveBeenCalledWith(
        'dispose-profile',
        expect.objectContaining({
          profileId: fx.alice.profileId,
          disposition: 'cancel-orders',
        }),
        // NOT a fixed jobId: the pipeline queue retains completed jobs, so a fixed
        // id would let only the first disposal per profile ever run.
        expect.not.objectContaining({ jobId: expect.anything() }),
      );

      // The row is still there: only the worker, having proven Binance is clear,
      // may remove it.
      const get = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        { headers: headers(fx.alice.userId) },
      );
      expect(get.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
  });

  it('a handoff with no target is refused', async () => {
    const fx = await setupApp();
    try {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}?disposition=handoff`,
        { method: 'DELETE', headers: headers(fx.alice.userId) },
      );
      expect(res.status).toBe(422);
    } finally {
      await fx.cleanup();
    }
  });

  it('returns 409 for a held position even with no open order', async () => {
    const fx = await setupApp();
    try {
      // A held position (avg-entry price + positive quantity, no resting order)
      // must block the delete just like a live order — the guard reads both
      // counts, so this exercises the position branch through the HTTP route.
      await fx.di.pool.query(
        `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity, updated_at)
         values ($1, 'BTCUSDT', '100', '1', now())`,
        [fx.alice.profileId],
      );

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        {
          method: 'DELETE',
          headers: headers(fx.alice.userId),
        },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { details: { openOrderCount: number; openPositionCount: number } };
      };
      expect(body.error.details).toEqual({ openOrderCount: 0, openPositionCount: 1 });

      const get = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        {
          headers: headers(fx.alice.userId),
        },
      );
      expect(get.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
  });

  it('a profile with no exposure needs no choice: it enqueues the cancel-orders disposal', async () => {
    const fx = await setupApp();
    try {
      const addSpy = vi.spyOn(fx.di.queue, 'add');
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        {
          method: 'DELETE',
          headers: headers(fx.alice.userId),
        },
      );
      expect(res.status).toBe(202);
      // Even with nothing to cancel, the disposal is the ONE delete path: the
      // worker owns the teardown ordering (disable, unsubscribe, wipe, delete).
      expect(addSpy).toHaveBeenCalledWith(
        'dispose-profile',
        expect.objectContaining({
          userId: fx.alice.userId,
          accountId: fx.alice.accountId,
          profileId: fx.alice.profileId,
          disposition: 'cancel-orders',
        }),
        expect.anything(),
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describeIfInfra('profiles router — legacy enablement_policy tolerance', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET coerces a removed monitor.mode (halt) to warn, preserving tuned siblings', async () => {
    // Row written before the mode enum was narrowed to (off,warn). The sibling
    // thresholds are deliberately NON-default so this proves the surgical coercion
    // (only mode changes) — a coarse EnablementPolicy.catch would reset them all.
    await fx.di.db.execute(
      sql`update profiles set enablement_policy = ${JSON.stringify({
        enabled: true,
        minProfitFactor: 1.5,
        minTrades: 250,
        monitor: { mode: 'halt', minTrades: 25, warnFactor: 0.7, breachFactor: 0.5 },
      })}::jsonb where id = ${fx.alice.profileId}`,
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enablementPolicy: {
        minProfitFactor: number;
        minTrades: number;
        monitor: { mode: string; minTrades: number; warnFactor: number; breachFactor: number };
      };
    };
    const pol = body.enablementPolicy;
    expect(pol.monitor.mode).toBe('warn');
    // Only mode moved; every tuned sibling survives.
    expect(pol.minProfitFactor).toBe(1.5);
    expect(pol.minTrades).toBe(250);
    expect(pol.monitor.minTrades).toBe(25);
    expect(pol.monitor.warnFactor).toBe(0.7);
    expect(pol.monitor.breachFactor).toBe(0.5);
  });

  it('GET drops a null/corrupt monitor to the default policy instead of 422', async () => {
    // A null monitor (not merely absent) fails the strict parse because the zod
    // default only fills an absent key; the tolerant read drops it to the default.
    await fx.di.db.execute(
      sql`update profiles set enablement_policy = ${JSON.stringify({
        enabled: true,
        monitor: null,
      })}::jsonb where id = ${fx.alice.profileId}`,
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enablementPolicy: { monitor: { mode: string } } };
    expect(body.enablementPolicy.monitor.mode).toBe('warn'); // default policy
  });

  it('PATCH with an invalid monitor.mode is still rejected (writes stay strict)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ enablementPolicy: { monitor: { mode: 'halt' } } }),
      },
    );
    expect(res.status).toBe(422);
  });
});

// #671: editing a profile's OWN quote_asset is another funnel into the
// cross-profile shared-wallet collision the symbol-bind guard already blocks. A
// base asset is the shared wallet line, so setting profile B's quote to an asset
// a sibling already TRADES as a base (or the profile itself trades) must be
// refused, not persisted. Each case gets its own freshly-seeded fixture (setupApp
// truncate+seeds per call) so the sibling seed and symbol binding stay
// order-independent.
describeIfInfra('profiles router — quoteAsset exclusivity (#671)', () => {
  // A v4-conformant id for a same-account sibling under Alice, added per test.
  const SIBLING_B = '00000000-0000-4000-8000-00000000a102';

  const seedSiblingB = (fx: ApiFixture) =>
    fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'sibling-b', 'trailing-trade', $3, '{}', '{}')`,
      [SIBLING_B, fx.alice.accountId, TRAILING_TRADE_VERSION],
    );

  // Bind a symbol so `profileId` becomes the account's owner of `base`.
  const ownBase = async (fx: ApiFixture, profileId: string, symbol: string, base: string) => {
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(profileId),
    );
    await repo.profileSymbols.upsert(symbol, base, { overrideConfig: null });
  };

  const quoteOf = async (fx: ApiFixture, profileId: string): Promise<string | null> => {
    const repo = await profileRepo(
      fx.di.db,
      asUserId(fx.alice.userId),
      fx.alice.accountId,
      asProfileId(profileId),
    );
    return (await repo.profile.findById())?.quoteAsset ?? null;
  };

  it('CROSS-PROFILE: PATCH quoteAsset to a base a sibling manages is refused with 409, not persisted', async () => {
    const fx = await setupApp();
    try {
      await seedSiblingB(fx);
      // A (Alice's primary, name 'demo') manages base BTC; B must not settle in BTC.
      await ownBase(fx, fx.alice.profileId, 'BTCUSDT', 'BTC');
      const before = await quoteOf(fx, SIBLING_B);

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${SIBLING_B}`,
        {
          method: 'PATCH',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ quoteAsset: 'btc' }),
        },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CONFLICT');
      // The envelope message names the clashing base asset and the owning profile.
      expect(body.error.message).toContain('BTC');
      expect(body.error.message).toContain('demo');
      // Not persisted: B's quote is exactly what it was before the rejected PATCH.
      expect(await quoteOf(fx, SIBLING_B)).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it('SELF: PATCH a profile’s own quoteAsset to a base it manages is refused with 409, not persisted', async () => {
    const fx = await setupApp();
    try {
      // Alice's primary trades BTC as a base; settling in BTC too would size sells
      // and arm stops against the same wallet line it trades.
      await ownBase(fx, fx.alice.profileId, 'BTCUSDT', 'BTC');
      const before = await quoteOf(fx, fx.alice.profileId);

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}`,
        {
          method: 'PATCH',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ quoteAsset: 'btc' }),
        },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CONFLICT');
      // The self-branch message names the clashing base asset and the profile.
      expect(body.error.message).toContain('BTC');
      expect(body.error.message).toContain('demo');
      expect(await quoteOf(fx, fx.alice.profileId)).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it('C4: a CONFIG-only PATCH is unaffected by a sibling owning the base (quote gate holds)', async () => {
    const fx = await setupApp();
    try {
      await seedSiblingB(fx);
      // A owns BTC. Patching B with config only (no quoteAsset) must not trip the
      // quote guard — it fires strictly on `patch.quoteAsset !== undefined`.
      await ownBase(fx, fx.alice.profileId, 'BTCUSDT', 'BTC');
      const validConfig = buildStrategyRegistry().get('trailing-trade')?.defaultConfig;

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${SIBLING_B}`,
        {
          method: 'PATCH',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ config: validConfig }),
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await fx.cleanup();
    }
  });

  it('C3: PATCH quoteAsset to a non-conflicting asset still succeeds and persists', async () => {
    const fx = await setupApp();
    try {
      await seedSiblingB(fx);
      // A manages BTC; B moving to ETH collides with nothing.
      await ownBase(fx, fx.alice.profileId, 'BTCUSDT', 'BTC');

      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${SIBLING_B}`,
        {
          method: 'PATCH',
          headers: headers(fx.alice.userId),
          body: JSON.stringify({ quoteAsset: 'eth' }),
        },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { quoteAsset: string }).quoteAsset).toBe('ETH');
      expect(await quoteOf(fx, SIBLING_B)).toBe('ETH');
    } finally {
      await fx.cleanup();
    }
  });
});
