import { isPlainDecimalString } from '@app/money';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';
import { recordPoolCheckouts } from '../_pool-checkouts.js';

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
    const accepted = (await res.json()) as { scheduledAt: string };
    expect(typeof accepted.scheduledAt).toBe('string');
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
 * The trade-archive GET projection: per-row `exitIntent` (closing SELL's intent, derived from the archived `orders` JSONB) and the period `byIntent` rollup. Integration-level because the projection reads real `orders` JSONB from a seeded row; ownership goes through the scoped repo.
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
          total_sell_quote, profit, breakdown, orders, fees, source, archived_at)
       values ($1,$2,$3,'USDT','100','105',$4,'{}'::jsonb,$5::jsonb,'{}'::jsonb,$6, now())`,
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
      items: { symbol: string; exitIntent: string; feeBasis: string }[];
      byIntent: { quoteAsset: string; intent: string; feeBasis: string }[];
      bySource: { quoteAsset: string; source: string; feeBasis: string }[];
    };

    const intentBySymbol = Object.fromEntries(body.items.map((i) => [i.symbol, i.exitIntent]));
    expect(intentBySymbol['WLDUSDT']).toBe('grid-stop-loss');
    expect(intentBySymbol['BTCUSDT']).toBe('grid-sell');
    expect(intentBySymbol['ETHUSDT']).toBe('unknown');
    expect(body.items.every((item) => item.feeBasis === 'unknown')).toBe(true);

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
        feeBasis: 'unknown',
      }),
    );
    expect(body.bySource).toContainEqual(
      expect.objectContaining({
        source: 'manual',
        tradeCount: 1,
        wins: 0,
        losses: 0,
        feeBasis: 'unknown',
      }),
    );
  });

  it('projects a complete nonzero fee through the row and its isolated quote rollup', async () => {
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, breakdown, orders, fees, fees_quote,
          fee_basis, source, archived_at)
       values ($1,'ETHBTC','ETH','BTC','1','1.1','0.1','{}'::jsonb,$2::jsonb,
          '{"BTC":"0.01","BNB":"0.00000036"}'::jsonb,'0.01','exact','manual',now())`,
      [fx.alice.profileId, JSON.stringify([{ side: 'SELL', intent: 'grid-sell' }])],
    );
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/trade-archive`,
      { method: 'GET', headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        symbol: string;
        totalBuyQuote: string;
        totalSellQuote: string;
        profit: string;
        fees: Record<string, string>;
        feesQuote: string;
        netProfit: string;
        feeBasis: string;
      }[];
      bySource: {
        quoteAsset: string;
        source: string;
        netProfit: string;
        feeBasis: string;
      }[];
    };
    const item = body.items.find((candidate) => candidate.symbol === 'ETHBTC');
    expect(item?.feeBasis).toBe('exact');
    expect(Number(item?.feesQuote)).toBe(0.01);
    expect(Number(item?.netProfit)).toBe(0.09);

    // Every money field on the row is interpolated verbatim by the SPA. decimal.js flips `toString()` to exponential once the value's decimal exponent reaches -7, meaning any magnitude below 1e-6, so a plainly-stored `0.00000036` commission reaches the operator as `3.6e-7` unless the projection guarantees the wire grammar.
    expect(item?.fees['BNB']).toBe('0.00000036');
    const moneyStrings = [
      item?.totalBuyQuote,
      item?.totalSellQuote,
      item?.profit,
      item?.netProfit,
      item?.feesQuote,
      ...Object.values(item?.fees ?? {}),
    ];
    // The length pin catches a fees map that lost an entry; the fixed-arity fields above cannot shrink it, so a dropped one arrives as `undefined` and is caught by the `typeof` check instead. Both guards are needed because the two failures look identical from the assertion below.
    expect(moneyStrings).toHaveLength(7);
    for (const value of moneyStrings) {
      expect(typeof value).toBe('string');
      expect(isPlainDecimalString(value ?? '')).toBe(true);
    }
    const rollup = body.bySource.find(
      (bucket) => bucket.quoteAsset === 'BTC' && bucket.source === 'manual',
    );
    expect(rollup?.feeBasis).toBe('exact');
    expect(Number(rollup?.netProfit)).toBe(0.09);
  });

  it("treats malformed orders JSONB as 'unknown' without throwing the list", async () => {
    // A legacy/bad row whose `orders` is a non-array object, plus one whose
    // `orders` is an array element missing `side`. Both must coerce to an empty
    // usable-orders list -> exitIntent 'unknown' -> a 200, not a 500. This
    // proves the route + repo coerce guards survive bad rows from the DB.
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, breakdown, orders, fees, archived_at)
       values ($1,'MLFUSDT','MLF','USDT','100','105','7','{}'::jsonb,'{}'::jsonb,'{}'::jsonb, now())`,
      [fx.alice.profileId],
    );
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, breakdown, orders, fees, archived_at)
       values ($1,'BADUSDT','BAD','USDT','100','105','11','{}'::jsonb,$2::jsonb,'{}'::jsonb, now())`,
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
            total_sell_quote, profit, breakdown, orders, fees, archived_at)
         values ($1,$2,$3,'USDT','100','105',$4,'{}'::jsonb,$5::jsonb,'{}'::jsonb, now())`,
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
    // Bob already has AAAUSDT/BBBUSDT archive rows (prior test). A CLOSED cycle
    // (a BUY and a SELL) with NO archive and no attempt (PEPEUSDT) →
    // recoverable; one that DOES have an archive (AAAUSDT) → neither. A coin
    // attempted-and-empty (OVERUSDT, overshoot) → unreconstructable with a
    // reason. Proves the route wires both repo lists.
    // `applied_at` is back-dated because the recoverable list waits for a closing
    // SELL to settle (the forward archive gets first claim on a cycle it may
    // still be writing); fills stamped `now()` are deliberately not yet listed.
    const SETTLED = `now() - interval '1 hour'`;
    await fx.di.pool.query(
      `insert into applied_fills (profile_id, symbol, order_id, trade_id, side, applied_at)
       values ($1,'PEPEUSDT',901,901,'BUY',${SETTLED}), ($1,'PEPEUSDT',907,907,'SELL',${SETTLED}),
              ($1,'AAAUSDT',902,902,'BUY',${SETTLED}),
              ($1,'OVERUSDT',903,903,'BUY',${SETTLED}), ($1,'ORPHUSDT',904,904,'BUY',${SETTLED}),
              ($1,'OPENUSDT',905,905,'BUY',${SETTLED}), ($1,'BOTHUSDT',906,906,'BUY',${SETTLED}),
              ($1,'GONEUSDT',908,908,'BUY',${SETTLED})`,
      [fx.bob.profileId],
    );
    await fx.di.pool.query(
      `insert into backfill_attempts (profile_id, symbol, round_trips, skipped_orphan_sells, dropped_overshoot, symbol_unavailable)
       values ($1,'OVERUSDT',0,0,4,false), ($1,'ORPHUSDT',0,2,0,false), ($1,'OPENUSDT',0,0,0,false),
              ($1,'BOTHUSDT',0,1,1,false), ($1,'GONEUSDT',0,0,0,true)`,
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
    // A delisted coin outranks the count-derived reasons: nothing can be read
    // for it at all, so "no closed cycle" would misdescribe why.
    expect(reasonBy['GONEUSDT']).toBe('symbol-unavailable');
    expect(body.unreconstructableSymbols.map((u) => u.symbol)).not.toContain('PEPEUSDT');
  });

  it('round-trips its own nextCursor: the emitted cursor pages instead of 422ing', async () => {
    // The emitted cursor is composite (`<iso>__<row id>`) but the query schema
    // validated it as a bare ISO timestamp, so echoing back `nextCursor` — the
    // only thing a client can do with it — was rejected at the boundary and the
    // archive was permanently pinned to its first page.
    const url = `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive`;
    const page = async (cursor?: string) => {
      const res = await fx.app.request(
        cursor === undefined
          ? `${url}?limit=1`
          : `${url}?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { method: 'GET', headers: headers(fx.bob.userId) },
      );
      return {
        status: res.status,
        body: (await res.json()) as { items: { id: string }[]; nextCursor: string | null },
      };
    };

    const first = await page();
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toMatch(/__/);

    const second = await page(first.body.nextCursor ?? '');
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    // A different row: the cursor advanced rather than replaying page one.
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0]?.id);
  });

  it('still rejects a cursor that is neither an ISO timestamp nor `<iso>__<id>`', async () => {
    // Widening the schema must not make it accept anything: the timestamp half
    // is parsed into a Date and the id half is compared against a `uuid`
    // column, so garbage belongs in the schema's 422, not a Postgres cast error.
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?cursor=not-a-cursor`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(422);
  });

  it('rejects a well-formed cursor whose row-id half is not a uuid', async () => {
    // The timestamp half parses, so only the uuid check stands between this and
    // `lt(trade_archive.id, ...)` against a `uuid` column — which fails as a
    // Postgres cast error (500), not a bad request.
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?cursor=${encodeURIComponent('2026-01-01T00:00:00.000Z__not-a-uuid')}`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(422);
  });

  // Three cursors that `z.iso.datetime()` accepts and Postgres does not, plus the value on the safe side of each bound. Every one of them would otherwise bind to `$n::timestamptz` and come back as a cast error — neither a statement timeout nor a checkout timeout, so it falls through the classifier to an unhandled 500 on a route whose declared failures are 422 and 503.
  const ID = '11111111-1111-4111-8111-111111111111';
  const cursorStatus = async (cursor: string): Promise<number> => {
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?cursor=${encodeURIComponent(cursor)}`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    return res.status;
  };

  it('rejects the one ISO year Postgres cannot represent', async () => {
    // AD/BC notation has no year zero, so this is SQLSTATE 22008 at the cast.
    expect(await cursorStatus(`0000-01-01T00:00:00.000000Z__${ID}`)).toBe(422);
    // The other side of the bound, so the guard stays a year-zero check rather than a lower bound someone widens later.
    expect(await cursorStatus(`0001-01-01T00:00:00.000000Z__${ID}`)).toBe(200);
  });

  it('rejects a fractional second long enough to overrun the datetime parser', async () => {
    // zod bounds the fraction at `\.\d+` — no upper limit — while Postgres parses datetime input through a fixed work buffer and refuses the literal outright once it overruns, rather than rounding the excess away as it does for a merely over-precise fraction.
    expect(await cursorStatus(`2026-01-01T00:00:00.${'1'.repeat(200)}Z__${ID}`)).toBe(422);
    // A hundred digits still fits the buffer and rounds to microseconds, so the bound must not be so tight that it rejects what the database would have taken.
    expect(await cursorStatus(`2026-01-01T00:00:00.${'1'.repeat(6)}Z__${ID}`)).toBe(200);
  });

  it('rejects a bare timestamp cursor this route never emits', async () => {
    // Not a widening the schema forgot: a cursor with no row id cannot address a row inside a shared timestamp, so honouring it would strand the rows below the boundary silently — the same failure the millisecond cursor caused. A 422 makes the client restart the walk instead.
    expect(await cursorStatus('2026-01-01T00:00:00.000000Z')).toBe(422);
  });

  it('surfaces missingCostBasis so an under-counted row is not read as a break-even', async () => {
    // `profit = 0` from a SELL with no cost basis is indistinguishable from a
    // genuine break-even on the wire. The count is what lets the UI say
    // "unavailable" instead of rendering a number nobody measured.
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, breakdown, orders, fees,
          missing_cost_basis, archived_at)
       values ($1,'NOCBUSDT','NOCB','USDT','0','50','0','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
               2, now())`,
      [fx.bob.profileId],
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?limit=200`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { symbol: string; missingCostBasis: number }[];
    };
    const bySymbol = Object.fromEntries(body.items.map((i) => [i.symbol, i.missingCostBasis]));
    expect(bySymbol['NOCBUSDT']).toBe(2);
    // A fully-costed row reports 0, so the flag means something.
    expect(bySymbol['AAAUSDT']).toBe(0);
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

  it('serves one page on one pooled connection, inside a statement-timeout transaction', async () => {
    // The archive page is the single largest checkout burst in the api: its reads fan out concurrently, and node-postgres takes one pooled connection per concurrent query. Against a pool of ten, three of these page loads in flight is the whole pool, and the reads themselves have no execution bound, so a slow one holds its connection for as long as it runs. What makes that a whole-app outage rather than a slow page is that every OTHER route then queues behind it.
    // Both halves are asserted from the pool itself rather than from the response: peak concurrent checkouts is the property that actually caps the blast radius, and the `set_config` on the acquired connection is the only direct evidence that the reads run under a budget at all.
    const { peak, statements } = await recordPoolCheckouts(fx.di.pool, async () => {
      const res = await fx.app.request(
        `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?limit=50`,
        { method: 'GET', headers: headers(fx.bob.userId) },
      );
      expect(res.status).toBe(200);
    });

    // Soft so both properties report from one run: they fail for different reasons and fixing the fan-out without arming the budget would otherwise look like progress on a single line.
    // Not "at most one query" — the reads may be as many as they like, as long as one request cannot occupy more than one connection at a time.
    expect.soft(peak).toBe(1);
    expect.soft(statements.some((s) => s.includes("set_config('statement_timeout'"))).toBe(true);
  });

  it('reads only the rollup source when the page asks for the rollup view', async () => {
    // The dashboard's edge verdict and its live-vs-backtest card both want one field, `bySource`, over all time. They get it by loading the whole archive page: the paged list, the recoverable-coin scan and the unreconstructable-coin scan all run to build a response the dashboard discards, and both cards poll it every 60s. Only `listForProfileInRange` feeds the rollups, so a rollup-only request has no reason to touch anything else.
    // Asserted on the statements rather than the response body because the cost is the reads, not the JSON: a projection that dropped the unused fields while still issuing the same four reads would be no cheaper, and would still pass a body-shaped assertion.
    let body: Record<string, unknown> = {};
    const { statements } = await recordPoolCheckouts(fx.di.pool, async () => {
      const res = await fx.app.request(
        `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?view=rollup`,
        { method: 'GET', headers: headers(fx.bob.userId) },
      );
      expect(res.status).toBe(200);
      body = (await res.json()) as Record<string, unknown>;
    });

    // Asserted by KEY PRESENCE, not by value. Omission is the load-bearing half of the contract — absent and `[]` are different claims, and only absent is honest about a read that did not run — and nothing else enforces it: the openapi layer does not validate outgoing bodies, so the field disappears only because `JSON.stringify` drops an `undefined`. A `toBeUndefined()` would pass on a key that was serialised as `null`.
    expect('items' in body).toBe(false);
    expect('nextCursor' in body).toBe(false);
    expect('recoverableSymbols' in body).toBe(false);
    expect('unreconstructableSymbols' in body).toBe(false);
    // The rollup the request actually asked for is still there, so the omissions above are not a response that failed to build.
    expect(Array.isArray(body['bySource'])).toBe(true);
    expect(Array.isArray(body['byIntent'])).toBe(true);

    // `applied_fills` is read by the two coverage scans and by nothing else on this route, and the paged list is the only `trade_archive` read carrying a LIMIT, so the pair fingerprints every read the rollup view does not need.
    const archiveReads = statements.filter(
      (s) => s.includes('trade_archive') || s.includes('applied_fills'),
    );
    expect(archiveReads).toHaveLength(1);
    expect(archiveReads[0]).not.toContain('limit');
  });

  it('pages past two rows whose timestamps differ only below the millisecond', async () => {
    // The route half of the cursor fix. `archived_at` is timestamptz — microseconds — while the driver hands the row back as a JS `Date`, milliseconds. Emit the boundary from that `Date` and the row at `.123200` matches neither `< .123000` nor `= .123000`, so it is unreachable on every later page and nothing reports the loss. The db isolation test binds the token straight back and so never exercises this construction; only an end-to-end page walk does.
    const seedAt = async (symbol: string, at: string): Promise<void> => {
      await fx.di.pool.query(
        `insert into trade_archive
           (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
            total_sell_quote, profit, breakdown, orders, fees, archived_at)
         values ($1,$2,$3,'USDT','100','105','5','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$4::timestamptz)`,
        [fx.bob.profileId, symbol, symbol.replace('USDT', ''), at],
      );
    };
    // Dated ahead of every other row in the fixture so the walk starts on this pair; the period filter is a lower bound only, so a future stamp stays in the window.
    await seedAt('SUBMSAUSDT', '2027-01-01 00:00:00.123456+00');
    await seedAt('SUBMSBUSDT', '2027-01-01 00:00:00.123200+00');

    const url = `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive`;
    const page = async (cursor?: string) => {
      const res = await fx.app.request(
        cursor === undefined
          ? `${url}?limit=1`
          : `${url}?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { method: 'GET', headers: headers(fx.bob.userId) },
      );
      return {
        status: res.status,
        body: (await res.json()) as { items: { symbol: string }[]; nextCursor: string | null },
      };
    };

    const first = await page();
    expect(first.status).toBe(200);
    expect(first.body.items[0]?.symbol).toBe('SUBMSAUSDT');
    // Six fractional digits: the boundary is emitted at the column's precision, not the driver's.
    expect(first.body.nextCursor).toMatch(/\.\d{6}Z__/);

    const second = await page(first.body.nextCursor ?? '');
    expect(second.status).toBe(200);
    expect(second.body.items[0]?.symbol).toBe('SUBMSBUSDT');
  });
});
