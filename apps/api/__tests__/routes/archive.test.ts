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
    // The row's fee evidence. It decides which leg of the rollup the row lands in: every row is counted and summed, but only a row that can prove its commission contributes a win, a loss, a gross magnitude or a Net total.
    feeBasis: 'exact' | 'estimated' | 'unknown' = 'exact',
  ): Promise<void> => {
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote,
          total_sell_quote, profit, breakdown, orders, fees, fee_basis, source, archived_at)
       values ($1,$2,$3,'USDT','100','105',$4,'{}'::jsonb,$5::jsonb,'{}'::jsonb,$6,$7, now())`,
      [
        fx.alice.profileId,
        symbol,
        symbol.replace('USDT', ''),
        profit,
        JSON.stringify(orders),
        feeBasis,
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
    // A cycle with no SELL must bucket under 'unknown', not be dropped. It also carries no fee evidence, which is the other half of what this case pins: it is counted, and it contributes to nothing that is stated net of commission.
    await seedArchive('ETHUSDT', '0', [{ side: 'BUY', intent: 'grid-buy' }], 'manual', 'unknown');

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
    const basisBySymbol = Object.fromEntries(body.items.map((i) => [i.symbol, i.feeBasis]));
    expect(basisBySymbol['WLDUSDT']).toBe('exact');
    expect(basisBySymbol['ETHUSDT']).toBe('unknown');

    // byIntent carries the trader metrics, not just net P/L: the stop-loss bucket
    // is a pure loss, the grid-sell bucket a pure win.
    expect(body.byIntent).toContainEqual(
      expect.objectContaining({
        intent: 'grid-stop-loss',
        tradeCount: 1,
        netTradeCount: 1,
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
      // Counted and summed, but it proves no commission — so it wins nothing, loses nothing, and drags the bucket's reported tier down to `unknown`.
      expect.objectContaining({
        intent: 'unknown',
        tradeCount: 1,
        netTradeCount: 0,
        wins: 0,
        losses: 0,
        feeBasis: 'unknown',
      }),
    );

    // bySource splits the two auto trades (one win, one loss) from the one manual
    // breakeven, proving discovery-vs-manual attribution.
    expect(body.bySource).toContainEqual(
      expect.objectContaining({
        source: 'auto',
        tradeCount: 2,
        netTradeCount: 2,
        wins: 1,
        losses: 1,
        profitSum: '-2',
        grossProfit: '3',
        grossLoss: '5',
        feeBasis: 'exact',
      }),
    );
    expect(body.bySource).toContainEqual(
      expect.objectContaining({
        source: 'manual',
        tradeCount: 1,
        netTradeCount: 0,
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

/**
 * The History page's reach: an explicit window, ordering by keys no index carries, row filters, the NDJSON export and the per-trade detail read.
 *
 * Integration-level because every one of those is a claim about which ROWS come back, and the orderings are decided over rows read from Postgres — a mocked repo would only prove the handler calls itself.
 */
describeIfInfra('archive router — window, ordering, filters, export and detail', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // Every request below carries WINDOW, so the exact orderings and counts assert over this suite's three rows and not over the fixture's shared archive — the suites in this file share one database on purpose.
  const seed = async (row: {
    symbol: string;
    profit: string;
    feesQuote: string;
    feeBasis: string;
    source: 'auto' | 'manual';
    exit: string;
    archivedAt: string;
    entryAt?: string;
    exitAt?: string;
  }): Promise<void> => {
    const orders = [
      {
        orderId: `${row.symbol}-b`,
        side: 'BUY',
        intent: 'grid-buy',
        closedAt: row.entryAt ?? null,
      },
      {
        orderId: `${row.symbol}-s`,
        binanceOrderId: '77',
        clientOrderId: 'c-1',
        side: 'SELL',
        intent: row.exit,
        status: 'FILLED',
        executedQty: '1',
        cummulativeQuoteQty: '105',
        closedAt: row.exitAt ?? null,
        // The whole exchange payload the list refuses to ship and the detail projection drops.
        raw: { fills: [{ price: '105', qty: '1' }] },
      },
    ];
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote,
          profit, fees_quote, fee_basis, breakdown, orders, fees, source, archived_at)
       values ($1,$2,$3,'USDT','100','105',$4,$5,$6,'{}'::jsonb,$7::jsonb,'{}'::jsonb,$8,$9::timestamptz)`,
      [
        fx.bob.profileId,
        row.symbol,
        row.symbol.replace('USDT', ''),
        row.profit,
        row.feesQuote,
        row.feeBasis,
        JSON.stringify(orders),
        row.source,
        row.archivedAt,
      ],
    );
  };

  const url = (): string =>
    `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive`;

  // The window this suite's rows live in, and nothing else in the file does.
  const WINDOW = 'from=2026-03-01T00:00:00.000Z&to=2026-03-03T12:00:00.000Z';

  const get = async (
    query: string,
  ): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
    const res = await fx.app.request(`${url()}?${WINDOW}&${query}`, {
      method: 'GET',
      headers: headers(fx.bob.userId),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body, text };
  };

  beforeAll(async () => {
    await seed({
      // The biggest gross AND the biggest net, so that net P/L, gross profit and the default time order are three DIFFERENT sequences over these rows — a fixture where two of them coincide cannot tell the comparator's net arm from its neighbours.
      symbol: 'AAAUSDT',
      profit: '40',
      feesQuote: '1',
      feeBasis: 'exact',
      source: 'auto',
      exit: 'grid-sell',
      archivedAt: '2026-03-01T00:00:00Z',
      entryAt: '2026-02-28T00:00:00.000Z',
      exitAt: '2026-03-01T00:00:00.000Z',
    });
    await seed({
      symbol: 'BBBUSDT',
      profit: '30',
      feesQuote: '20',
      feeBasis: 'exact',
      source: 'manual',
      exit: 'grid-stop-loss',
      archivedAt: '2026-03-02T00:00:00Z',
      entryAt: '2026-03-01T23:00:00.000Z',
      exitAt: '2026-03-02T00:00:00.000Z',
    });
    await seed({
      symbol: 'CCCUSDT',
      profit: '20',
      feesQuote: '0',
      feeBasis: 'exact',
      source: 'auto',
      exit: 'grid-sell',
      archivedAt: '2026-03-03T00:00:00Z',
    });
  });

  it('orders by net P/L, which is a different order from both the default and gross profit', async () => {
    const { status, body } = await get('sort=netProfit&dir=desc');
    expect(status).toBe(200);
    const symbols = (body['items'] as { symbol: string }[]).map((i) => i.symbol);
    // Net: AAA 39, CCC 20, BBB 10.
    expect(symbols).toEqual(['AAAUSDT', 'CCCUSDT', 'BBBUSDT']);
    // Gross: AAA 40, BBB 30, CCC 20 — BBB's 20 of fees is the whole difference between the two orders.
    const gross = await get('sort=profit&dir=desc');
    expect((gross.body['items'] as { symbol: string }[]).map((i) => i.symbol)).toEqual([
      'AAAUSDT',
      'BBBUSDT',
      'CCCUSDT',
    ]);
    // And the default `archivedAt desc` is a third sequence, so neither of the above can be satisfied by an ordering that ignores its key.
    const byTime = await get('sort=archivedAt&dir=desc');
    expect((byTime.body['items'] as { symbol: string }[]).map((i) => i.symbol)).toEqual([
      'CCCUSDT',
      'BBBUSDT',
      'AAAUSDT',
    ]);
  });

  it('sorts the rows that cannot prove a hold to the end under BOTH directions', async () => {
    // CCC carries no stamps. It is not a zero-length hold, so it must not win "shortest" either.
    const desc = await get('sort=holdMs&dir=desc');
    expect((desc.body['items'] as { symbol: string }[]).at(-1)?.symbol).toBe('CCCUSDT');
    const asc = await get('sort=holdMs&dir=asc');
    expect((asc.body['items'] as { symbol: string }[]).at(-1)?.symbol).toBe('CCCUSDT');
    // And the two stamped rows do flip, so the direction is not being ignored.
    expect((asc.body['items'] as { symbol: string }[])[0]?.symbol).toBe('BBBUSDT');
    expect((desc.body['items'] as { symbol: string }[])[0]?.symbol).toBe('AAAUSDT');
  });

  it('pages a derived ordering by offset and refuses a cursor minted under another one', async () => {
    const first = await get('sort=netProfit&dir=desc&limit=1');
    expect((first.body['items'] as { symbol: string }[])[0]?.symbol).toBe('AAAUSDT');
    // A tag naming the whole sequence, then the position in it. The tag is opaque; what matters is that the offset is `1` and that the token round-trips.
    const cursor = first.body['nextCursor'] as string;
    expect(cursor).toMatch(/^[0-9a-f]{12}:1$/);

    const second = await get(
      `sort=netProfit&dir=desc&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect((second.body['items'] as { symbol: string }[])[0]?.symbol).toBe('CCCUSDT');

    // The same offset under a different key addresses a different row, silently. Refused instead.
    const reSorted = await get(`sort=holdMs&dir=desc&limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(reSorted.status).toBe(422);
    // And the same key in the other direction, which is the reversed sequence.
    const reversed = await get(
      `sort=netProfit&dir=asc&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(reversed.status).toBe(422);
    // And a keyset token, which cannot address anything in an in-memory ordering.
    const keyset = await get(
      'sort=netProfit&dir=desc&limit=1&cursor=2026-03-01T00%3A00%3A00.000000Z__00000000-0000-4000-8000-00000000ffff',
    );
    expect(keyset.status).toBe(422);
  });

  it('refuses an offset cursor replayed against a set a ROW FILTER has changed', async () => {
    // An offset names a position, not a row, so it means nothing once the set it counts into changes. Under the old token — which carried the sort key and nothing else — adding a filter kept the page-2 offset and silently answered rows 1..n of a set that no longer had them, with no field in the response saying so. The keyset walk next door degrades safely because its token names a boundary ROW.
    const first = await get('sort=netProfit&dir=desc&limit=1');
    const cursor = first.body['nextCursor'] as string;
    for (const added of ['symbol=AAAUSDT', 'exitIntent=grid-sell', 'source=auto']) {
      const replayed = await get(
        `sort=netProfit&dir=desc&limit=1&${added}&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(replayed.status).toBe(422);
    }
  });

  it('refuses an offset cursor replayed against a set the WINDOW has changed', async () => {
    // The window decides which rows exist at all, so it is as much a part of the sequence as the ordering is. Built without the suite's shared window, because a repeated query key arrives as an array the string schema refuses.
    const withWindow = async (
      query: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fx.app.request(`${url()}?${query}`, {
        method: 'GET',
        headers: headers(fx.bob.userId),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const wide = await withWindow(
      'from=2026-03-01T00:00:00.000Z&to=2026-03-03T12:00:00.000Z&sort=netProfit&dir=desc&limit=1',
    );
    const cursor = wide.body['nextCursor'] as string;
    const narrowed = await withWindow(
      `from=2026-03-02T00:00:00.000Z&to=2026-03-03T12:00:00.000Z&sort=netProfit&dir=desc&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(narrowed.status).toBe(422);
  });

  it('treats a cycle whose stamps run backwards as unstamped, in the sort AND on the row', async () => {
    // A negative span is not a hold, it is two stamps that cannot both belong to this cycle. Reported as a number it wins "shortest" under an ascending hold sort and renders as `1m` on the row — the archive's fastest trade, fabricated. The contract's rollup already dropped it; the route's own copy of the rule did not.
    await seed({
      symbol: 'ZZZUSDT',
      profit: '1',
      feesQuote: '0',
      feeBasis: 'exact',
      source: 'auto',
      exit: 'grid-sell',
      archivedAt: '2026-03-03T06:00:00Z',
      entryAt: '2026-03-03T06:00:00.000Z',
      exitAt: '2026-03-03T05:00:00.000Z',
    });
    try {
      const asc = await get('sort=holdMs&dir=asc');
      const symbols = (asc.body['items'] as { symbol: string }[]).map((i) => i.symbol);
      // Last, beside the row that carries no stamps at all — not first, which is where a -1h span sorts.
      expect(symbols.at(0)).toBe('BBBUSDT');
      expect(symbols.slice(-2).sort()).toEqual(['CCCUSDT', 'ZZZUSDT']);
    } finally {
      await fx.di.pool.query(`delete from trade_archive where symbol = 'ZZZUSDT'`);
    }
  });

  it('reads a cycle’s exit instant off its closing SELL, not off the stored cycle_end', async () => {
    // Two definitions of one instant. The forward writer falls back to the archive cutoff when a cycle has no closed sell to read, which is not an exit at all — so the Held column came off a different instant from the Avg-hold figure beside it, which reads `deriveExitAt` unconditionally. And the reported exit TIME now comes off the same order as the exit REASON.
    await seed({
      symbol: 'YYYUSDT',
      profit: '1',
      feesQuote: '0',
      feeBasis: 'exact',
      source: 'auto',
      exit: 'grid-sell',
      archivedAt: '2026-03-03T06:00:00Z',
      entryAt: '2026-03-03T00:00:00.000Z',
      exitAt: '2026-03-03T02:00:00.000Z',
    });
    await fx.di.pool.query(
      `update trade_archive set cycle_end = '2026-03-03T09:00:00.000Z'::timestamptz where symbol = 'YYYUSDT'`,
    );
    try {
      const { body } = await get('symbol=YYYUSDT');
      const row = (body['items'] as { exitAt: string }[])[0];
      expect(row?.exitAt).toBe('2026-03-03T02:00:00.000Z');
    } finally {
      await fx.di.pool.query(`delete from trade_archive where symbol = 'YYYUSDT'`);
    }
  });

  it('narrows the list by exit reason without narrowing the rollups the operator drills from', async () => {
    const { status, body } = await get('exitIntent=grid-stop-loss');
    expect(status).toBe(200);
    expect((body['items'] as { symbol: string }[]).map((i) => i.symbol)).toEqual(['BBBUSDT']);
    // The bands still describe the whole period. A map redrawn to show only where the operator already clicked cannot be navigated back out of.
    const intents = (body['byIntent'] as { intent: string }[]).map((b) => b.intent).sort();
    expect(intents).toEqual(['grid-sell', 'grid-stop-loss']);
  });

  it('scopes both the list and the rollups to an explicit range, and echoes the window it used', async () => {
    // Built without the suite's own window: a repeated query key arrives as an array, which the string schema refuses, so the two cannot be layered.
    const res = await fx.app.request(
      `${url()}?from=2026-03-02T00:00:00.000Z&to=2026-03-02T12:00:00.000Z`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    const status = res.status;
    const body = (await res.json()) as Record<string, unknown>;
    expect(status).toBe(200);
    expect((body['items'] as { symbol: string }[]).map((i) => i.symbol)).toEqual(['BBBUSDT']);
    expect((body['byIntent'] as unknown[]).length).toBe(1);
    expect(body['from']).toBe('2026-03-02T00:00:00.000Z');
    expect(body['to']).toBe('2026-03-02T12:00:00.000Z');
  });

  it('refuses an inverted range instead of answering it as an empty archive', async () => {
    const res = await fx.app.request(
      `${url()}?from=2026-03-03T00:00:00.000Z&to=2026-03-01T00:00:00.000Z`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(422);
  });

  it('exports NDJSON restricted to the active filter, one JSON object per line', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive/export?${WINDOW}&source=auto&sort=netProfit&dir=desc`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const lines = (await res.text()).trim().split('\n');
    const rows = lines.map((l) => JSON.parse(l) as { symbol: string; netProfit: string });
    // The two auto rows only, in the requested order — the manual one is excluded exactly as the screen excluded it. Net puts AAA (39) ahead of CCC (20); the default time order would have reversed the pair.
    expect(rows.map((r) => r.symbol)).toEqual(['AAAUSDT', 'CCCUSDT']);
    expect(rows[0]?.netProfit).toBe('39');
  });

  it('reads the export on one pooled connection, under the same budget as the page', async () => {
    // The export runs `listForProfileInRange`, the unpaginated whole-period read the archive budget exists for, and it defaults to the entire archive because `period` defaults to 'a' and `to` is optional. Unbudgeted it is a worse version of the page: a handful in flight hold the api pool's ten connections for as long as Postgres will run the query, and every other route queues behind them until its 5s checkout deadline turns into a 503. On a LIVE_DEMO box `requireUser` passes for an anonymous caller, so the requests need no credential.
    // Asserted from the pool rather than from the response for the same reason the page's twin is: a 200 says nothing about how many connections it took or whether a budget was ever armed.
    const { peak, statements } = await recordPoolCheckouts(fx.di.pool, async () => {
      const res = await fx.app.request(
        `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive/export`,
        { method: 'GET', headers: headers(fx.bob.userId) },
      );
      expect(res.status).toBe(200);
      // Drain the stream: the reads finish before `stream()` is called, but leaving the body unread can end the request while the recorder is still watching.
      await res.text();
    });

    expect.soft(peak).toBe(1);
    expect.soft(statements.some((s) => s.includes("set_config('statement_timeout'"))).toBe(true);
  });

  it('serves one cycle its fills without the raw exchange payload, and hides another profile’s row', async () => {
    const list = await get('symbol=AAAUSDT');
    const id = (list.body['items'] as { id: string }[])[0]?.id ?? '';
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive/${id}`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; orders: Record<string, unknown>[] };
    expect(body.id).toBe(id);
    expect(body.orders).toHaveLength(2);
    const sell = body.orders.find((o) => o['side'] === 'SELL');
    expect(sell?.['intent']).toBe('grid-sell');
    expect(sell?.['cummulativeQuoteQty']).toBe('105');
    // The reason the list ships no `orders` at all: each stored element embeds the whole exchange payload.
    expect('raw' in (sell ?? {})).toBe(false);

    // Alice cannot read Charlie's row, and gets the same answer as for a row that does not exist.
    const cross = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/trade-archive/${id}`,
      { method: 'GET', headers: headers(fx.alice.userId) },
    );
    expect(cross.status).toBe(404);
  });

  it('rejects the export and the detail read without a session', async () => {
    // Both live under a path the list's own `use` does not cover, so the middleware line that covers them is load-bearing on its own.
    const anonExport = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive/export`,
      { method: 'GET' },
    );
    expect(anonExport.status).toBe(401);
    const anonDetail = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive/00000000-0000-4000-8000-00000000aaaa`,
      { method: 'GET' },
    );
    expect(anonDetail.status).toBe(401);
  });
});

describeIfInfra('archive router — the P/L sort ranks only rows the ledger renders', () => {
  let fx: ApiFixture;

  // Its own window, so these rows cannot reach any other suite's ordering assertions in this file.
  const WINDOW = 'from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z';

  const seed = async (row: {
    symbol: string;
    profit: string;
    feesQuote: string;
    feeBasis: 'exact' | 'estimated' | 'unknown';
    missingCostBasis: number;
    archivedAt: string;
  }): Promise<void> => {
    await fx.di.pool.query(
      `insert into trade_archive
         (profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote,
          profit, fees_quote, fee_basis, missing_cost_basis, breakdown, orders, fees, source, archived_at)
       values ($1,$2,$3,'USDT','100','105',$4,$5,$6,$7,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'auto',$8::timestamptz)`,
      [
        fx.bob.profileId,
        row.symbol,
        row.symbol.replace('USDT', ''),
        row.profit,
        row.feesQuote,
        row.feeBasis,
        row.missingCostBasis,
        row.archivedAt,
      ],
    );
  };

  const symbolsOf = async (query: string): Promise<string[]> => {
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/trade-archive?${WINDOW}&${query}`,
      { method: 'GET', headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { symbol: string }[] };
    return body.items.map((i) => i.symbol);
  };

  beforeAll(async () => {
    fx = await setupApp();
    // The biggest stored net of the three, and the one the ledger renders as `net n/a`: its fee is missing outright, so the figure it would be ranked on is one the operator is looking at a dash in place of.
    await seed({
      symbol: 'NNNUSDT',
      profit: '500',
      feesQuote: '0',
      feeBasis: 'unknown',
      missingCostBasis: 0,
      archivedAt: '2026-07-01T00:00:00Z',
    });
    // Withheld on BOTH bases: an un-costed sell leaves the cycle with no readable P/L at all.
    await seed({
      symbol: 'MMMUSDT',
      profit: '400',
      feesQuote: '1',
      feeBasis: 'exact',
      missingCostBasis: 2,
      archivedAt: '2026-07-02T00:00:00Z',
    });
    await seed({
      symbol: 'PPPUSDT',
      profit: '30',
      feesQuote: '1',
      feeBasis: 'exact',
      missingCostBasis: 0,
      archivedAt: '2026-07-03T00:00:00Z',
    });
    await seed({
      symbol: 'QQQUSDT',
      profit: '10',
      feesQuote: '1',
      feeBasis: 'exact',
      missingCostBasis: 0,
      archivedAt: '2026-07-04T00:00:00Z',
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('sinks a row with no readable Net to the end of BOTH directions', async () => {
    // Stored net puts NNN (500) and MMM (399) at the top of a descending sort. Neither renders an amount, so ranking on the stored number shuffles two dashes through the ordering the operator is reading. The pair's own order is the row-id tie-break, which these fixtures do not pin.
    const desc = await symbolsOf('sort=netProfit&dir=desc');
    expect(desc.slice(0, 2)).toEqual(['PPPUSDT', 'QQQUSDT']);
    expect(desc.slice(2).sort()).toEqual(['MMMUSDT', 'NNNUSDT']);
    // Ascending flips the readable pair and leaves the unreadable ones at the end, exactly as the hold sort does: reversing the direction must not float a row with no figure to the top.
    const asc = await symbolsOf('sort=netProfit&dir=asc');
    expect(asc.slice(0, 2)).toEqual(['QQQUSDT', 'PPPUSDT']);
    expect(asc.slice(2).sort()).toEqual(['MMMUSDT', 'NNNUSDT']);
  });

  it('keeps the unknown-fee row in the Recorded ordering, where it does render an amount', async () => {
    // The two withholdings have different scopes. A missing commission blanks Net alone, so NNN's 500 is a real Recorded figure and ranks first; MMM's un-costed sell blanks both and stays at the end.
    expect(await symbolsOf('sort=profit&dir=desc')).toEqual([
      'NNNUSDT',
      'PPPUSDT',
      'QQQUSDT',
      'MMMUSDT',
    ]);
  });
});
