import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * The trade-archive backfill trigger. The route is strategy-agnostic (no
 * capability gate): it acknowledges with 202 and enqueues a worker job that
 * reconstructs historic round-trips from Binance myTrades. Integration-level
 * so ownership goes through the scoped repo and the enqueue hits the real DI
 * queue spy.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('archive router — trade-archive backfill', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('enqueues a backfill job and returns 202 with a window of null/null by default', async () => {
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/WLDUSDT/trade-archive-backfill`,
      { method: 'POST', headers: headers(fx.alice.userId), body: JSON.stringify({}) },
    );
    expect(res.status).toBe(202);
    expect(typeof (await res.json()).scheduledAt).toBe('string');
    expect(addSpy).toHaveBeenCalledTimes(1);
    const [name, data] = addSpy.mock.calls[0] ?? [];
    expect(name).toBe('backfill-trade-archive');
    expect(data).toMatchObject({
      profileId: fx.alice.profileId,
      symbol: 'WLDUSDT',
      fromMs: null,
      toMs: null,
    });
    addSpy.mockRestore();
  });

  it('translates an ISO from/to window into epoch-ms on the job payload', async () => {
    const addSpy = vi.spyOn(fx.di.queue, 'add').mockResolvedValue(undefined as never);
    const from = '2026-06-10T00:00:00.000Z';
    const to = '2026-06-11T00:00:00.000Z';
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/symbols/WLDUSDT/trade-archive-backfill`,
      { method: 'POST', headers: headers(fx.alice.userId), body: JSON.stringify({ from, to }) },
    );
    expect(res.status).toBe(202);
    const data = (addSpy.mock.calls[0] ?? [])[1] as { fromMs: number; toMs: number };
    expect(data.fromMs).toBe(Date.parse(from));
    expect(data.toMs).toBe(Date.parse(to));
    addSpy.mockRestore();
  });
});

/**
 * The trade-archive GET projection: per-row `exitIntent` (last SELL's intent,
 * derived from the archived `orders` JSONB) and the period `byIntent` rollup.
 * Integration-level because the projection reads real `orders` JSONB from a
 * seeded row; ownership goes through the scoped repo.
 */
describeIfInfra('archive router — trade-archive GET exit-intent projection', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // Seed one closed cycle for the profile. `orders` carries the archived order
  // summaries the projection derives the exit intent from.
  const seedArchive = async (
    symbol: string,
    profit: string,
    orders: { side: string; intent: string }[],
    source: 'auto' | 'manual' = 'manual',
  ): Promise<void> => {
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, profit_percent, breakdown, orders, fees, source, archived_at)
       values ($1,$2,$3,'USDT','100','105',$4,'5','{}'::jsonb,$5::jsonb,'{}'::jsonb,$6, now())`,
      [
        fx.alice.profileId,
        symbol,
        symbol.replace('USDT', ''),
        profit,
        JSON.stringify(orders),
        source,
      ],
    );
  };

  it('returns per-row exitIntent plus the byIntent and bySource rollups with win/loss metrics', async () => {
    await seedArchive(
      'WLDUSDT',
      '-5',
      [
        { side: 'BUY', intent: 'grid-buy' },
        { side: 'SELL', intent: 'grid-stop-loss' },
      ],
      'auto',
    );
    await seedArchive(
      'BTCUSDT',
      '3',
      [
        { side: 'BUY', intent: 'grid-buy' },
        { side: 'SELL', intent: 'grid-sell' },
      ],
      'auto',
    );
    // A cycle with no SELL must bucket under 'unknown', not be dropped.
    await seedArchive('ETHUSDT', '0', [{ side: 'BUY', intent: 'grid-buy' }], 'manual');

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/trade-archive`,
      {
        method: 'GET',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { symbol: string; exitIntent: string }[];
      byIntent: { quoteAsset: string; intent: string }[];
      bySource: { quoteAsset: string; source: string }[];
    };

    const intentBySymbol = Object.fromEntries(body.items.map((i) => [i.symbol, i.exitIntent]));
    expect(intentBySymbol['WLDUSDT']).toBe('grid-stop-loss');
    expect(intentBySymbol['BTCUSDT']).toBe('grid-sell');
    expect(intentBySymbol['ETHUSDT']).toBe('unknown');

    // byIntent carries the trader metrics, not just net P/L: the stop-loss bucket
    // is a pure loss, the grid-sell bucket a pure win.
    expect(body.byIntent).toContainEqual(
      expect.objectContaining({
        intent: 'grid-stop-loss',
        tradeCount: 1,
        wins: 0,
        losses: 1,
        profitSum: '-5',
        grossProfit: '0',
        grossLoss: '5',
      }),
    );
    expect(body.byIntent).toContainEqual(
      expect.objectContaining({
        intent: 'grid-sell',
        tradeCount: 1,
        wins: 1,
        losses: 0,
        profitSum: '3',
        grossProfit: '3',
        grossLoss: '0',
      }),
    );
    expect(body.byIntent).toContainEqual(
      expect.objectContaining({ intent: 'unknown', tradeCount: 1, wins: 0, losses: 0 }),
    );

    // bySource splits the two auto trades (one win, one loss) from the one manual
    // breakeven, proving discovery-vs-manual attribution.
    expect(body.bySource).toContainEqual(
      expect.objectContaining({
        source: 'auto',
        tradeCount: 2,
        wins: 1,
        losses: 1,
        profitSum: '-2',
        grossProfit: '3',
        grossLoss: '5',
      }),
    );
    expect(body.bySource).toContainEqual(
      expect.objectContaining({ source: 'manual', tradeCount: 1, wins: 0, losses: 0 }),
    );
  });

  it("treats malformed orders JSONB as 'unknown' without throwing the list", async () => {
    // A legacy/bad row whose `orders` is a non-array object, plus one whose
    // `orders` is an array element missing `side`. Both must coerce to an empty
    // usable-orders list -> exitIntent 'unknown' -> a 200, not a 500. This
    // proves the route + repo coerce guards survive bad rows from the DB.
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, profit_percent, breakdown, orders, fees, archived_at)
       values ($1,'MLFUSDT','MLF','USDT','100','105','7','5','{}'::jsonb,'{}'::jsonb,'{}'::jsonb, now())`,
      [fx.alice.profileId],
    );
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, profit_percent, breakdown, orders, fees, archived_at)
       values ($1,'BADUSDT','BAD','USDT','100','105','11','5','{}'::jsonb,$2::jsonb,'{}'::jsonb, now())`,
      [fx.alice.profileId, JSON.stringify([{ intent: 'x' }])],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/trade-archive`,
      {
        method: 'GET',
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { symbol: string; exitIntent: string }[];
      byIntent: { quoteAsset: string; intent: string; tradeCount: number; profitSum: string }[];
    };

    const intentBySymbol = Object.fromEntries(body.items.map((i) => [i.symbol, i.exitIntent]));
    expect(intentBySymbol['MLFUSDT']).toBe('unknown');
    expect(intentBySymbol['BADUSDT']).toBe('unknown');

    const unknownBucket = body.byIntent.find(
      (b) => b.quoteAsset === 'USDT' && b.intent === 'unknown',
    );
    expect(unknownBucket).toBeDefined();
    // The two malformed rows join the period's unknown bucket (alongside the
    // no-SELL ETHUSDT row seeded above), proving the rollup includes them.
    expect(unknownBucket?.tradeCount).toBeGreaterThanOrEqual(2);
  });

  it('rollup covers the whole period while the list is a paginated subset', async () => {
    // Bob's profile is isolated from Alice's rows seeded above, so the rollup
    // math is unpolluted. Seed two rows with distinct exit intents.
    const seedFor = async (
      symbol: string,
      profit: string,
      orders: { side: string; intent: string }[],
    ): Promise<void> => {
      await fx.di.pool.query(
        `insert into trade_archive
           (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
            total_sell_quote, profit, profit_percent, breakdown, orders, fees, archived_at)
         values ($1,$2,$3,'USDT','100','105',$4,'5','{}'::jsonb,$5::jsonb,'{}'::jsonb, now())`,
        [fx.bob.profileId, symbol, symbol.replace('USDT', ''), profit, JSON.stringify(orders)],
      );
    };
    await seedFor('AAAUSDT', '2', [{ side: 'SELL', intent: 'grid-sell' }]);
    await seedFor('BBBUSDT', '3', [{ side: 'SELL', intent: 'grid-stop-loss' }]);

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?limit=1`,
      {
        method: 'GET',
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { symbol: string }[];
      nextCursor: string | null;
      byIntent: { profitSum: string }[];
    };

    // List is a one-row page (more rows remain behind the cursor)...
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    // ...but the rollup sums EVERY period row: 2 + 3 = 5, not just the visible 1.
    const rollupTotal = body.byIntent.reduce((acc, b) => acc + Number(b.profitSum), 0);
    expect(rollupTotal).toBe(5);
  });

  it('splits recoverableSymbols vs unreconstructableSymbols by backfill attempt', async () => {
    // Bob already has AAAUSDT/BBBUSDT archive rows (prior test). Fills on a coin
    // with NO archive and no attempt (PEPEUSDT) → recoverable; on one that DOES
    // (AAAUSDT) → neither. A coin attempted-and-empty (FOOUSDT, overshoot) →
    // unreconstructable with a reason. Proves the route wires both repo lists.
    await fx.di.pool.query(
      `insert into applied_fills (profile_id, symbol, order_id, trade_id, side)
       values ($1,'PEPEUSDT',901,901,'BUY'), ($1,'AAAUSDT',902,902,'BUY'),
              ($1,'OVERUSDT',903,903,'BUY'), ($1,'ORPHUSDT',904,904,'BUY'),
              ($1,'OPENUSDT',905,905,'BUY'), ($1,'BOTHUSDT',906,906,'BUY')`,
      [fx.bob.profileId],
    );
    await fx.di.pool.query(
      `insert into backfill_attempts (profile_id, symbol, round_trips, skipped_orphan_sells, dropped_overshoot)
       values ($1,'OVERUSDT',0,0,4), ($1,'ORPHUSDT',0,2,0), ($1,'OPENUSDT',0,0,0),
              ($1,'BOTHUSDT',0,1,1)`,
      [fx.bob.profileId],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive`,
      {
        method: 'GET',
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recoverableSymbols: string[];
      unreconstructableSymbols: { symbol: string; reason: string }[];
    };
    expect(body.recoverableSymbols).toContain('PEPEUSDT'); // fills, no archive, not attempted
    expect(body.recoverableSymbols).not.toContain('AAAUSDT'); // has an archive row
    expect(body.recoverableSymbols).not.toContain('OVERUSDT'); // attempted-empty
    // Each reason arm, plus the priority order (overshoot wins when both > 0).
    const reasonBy = Object.fromEntries(
      body.unreconstructableSymbols.map((u) => [u.symbol, u.reason]),
    );
    expect(reasonBy['OVERUSDT']).toBe('overshoot');
    expect(reasonBy['ORPHUSDT']).toBe('orphan-sells');
    expect(reasonBy['OPENUSDT']).toBe('open-or-pre-history');
    expect(reasonBy['BOTHUSDT']).toBe('overshoot');
    expect(body.unreconstructableSymbols.map((u) => u.symbol)).not.toContain('PEPEUSDT');
  });

  it('hides + un-hides an unreconstructable coin via the dismiss endpoint', async () => {
    await fx.di.pool.query(
      `insert into applied_fills (profile_id, symbol, order_id, trade_id, side)
       values ($1,'HIDEUSDT',910,910,'BUY')`,
      [fx.bob.profileId],
    );
    await fx.di.pool.query(
      `insert into backfill_attempts (profile_id, symbol, round_trips) values ($1,'HIDEUSDT',0)`,
      [fx.bob.profileId],
    );

    const dismissedOf = async (): Promise<boolean | undefined> => {
      const res = await fx.app.request(
        `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive`,
        {
          method: 'GET',
          headers: headers(fx.bob.userId),
        },
      );
      const body = (await res.json()) as {
        unreconstructableSymbols: { symbol: string; dismissed: boolean }[];
      };
      return body.unreconstructableSymbols.find((u) => u.symbol === 'HIDEUSDT')?.dismissed;
    };

    expect(await dismissedOf()).toBe(false);

    const hide = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/symbols/HIDEUSDT/unreconstructable-dismiss`,
      {
        method: 'POST',
        headers: headers(fx.bob.userId),
        body: JSON.stringify({ dismissed: true }),
      },
    );
    expect(hide.status).toBe(200);
    expect(await dismissedOf()).toBe(true);

    await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/symbols/HIDEUSDT/unreconstructable-dismiss`,
      {
        method: 'POST',
        headers: headers(fx.bob.userId),
        body: JSON.stringify({ dismissed: false }),
      },
    );
    expect(await dismissedOf()).toBe(false);
  });
});
