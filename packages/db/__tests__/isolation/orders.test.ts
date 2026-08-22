import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { eq, inArray } from 'drizzle-orm';
import {
  accountRepo,
  profileRepo,
  type AccountRepo,
  type ProfileRepo,
} from '../../src/repo/index.js';
import { listLiveBinanceOrderIdsByAccount } from '../../src/repo/orders.js';
import { accounts } from '../../src/schema/accounts.js';
import { orders } from '../../src/schema/orders.js';
import { profiles } from '../../src/schema/profiles.js';
import { users } from '../../src/schema/users.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/orders.ts`.
 * Every exported fn takes a `ProfileScope`, so a wrong-owner call cannot be
 * expressed — ownership is proven once by `scopeProfile`. Cross-account
 * rejection lives in `cross-account.test.ts`; this suite locks the
 * owner-scoped read/write semantics on the orders table.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Monotonic per-suite counter so seeded rows never collide on
// binanceOrderId, even on a machine fast enough to produce two inserts
// inside the same millisecond.
let nextBinanceOrderId = 1n;

const liveOrder = (tag: string, side: 'BUY' | 'SELL', intent: string, symbol = 'BTCUSDT') => ({
  symbol,
  side,
  intent,
  binanceOrderId: nextBinanceOrderId++,
  clientOrderId: `cli-${tag}`,
  status: 'NEW',
  raw: { tag },
});

describeIfDb('orders account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;
  // Seeking / closing / reclaiming an order by its Binance id is ACCOUNT-domain:
  // the id is unique per account, and a DETACHED row (profile deleted) is
  // reachable only by account.
  let aa: AccountRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    aa = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
    // Seed one live order per account so same-owner happy paths have
    // something to find.
    await ap.orders.insert(liveOrder('alice-buy', 'BUY', 'grid-buy'));
    await bp.orders.insert(liveOrder('bob-buy', 'BUY', 'grid-buy'));
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listLiveForSymbol returns only the owner-scoped row on the happy path', async () => {
    const rows = await ap.orders.listLiveForSymbol('BTCUSDT');
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect((rows[0]?.raw as { tag?: string } | undefined)?.tag).toBe('alice-buy');
  });

  it('lists every exact profile-scoped attribution identity without coercing JSON numbers', async () => {
    const targetOrderId = nextBinanceOrderId++;
    const wrongSymbolOrderId = nextBinanceOrderId++;
    const buyOrderId = nextBinanceOrderId++;
    const nonFilledOrderId = nextBinanceOrderId++;
    const openOrderId = nextBinanceOrderId++;
    const numericQtyOrderId = nextBinanceOrderId++;
    const closedAt = new Date('2026-08-20T00:00:00Z');
    const siblingProfileId = asProfileId(randomUUID());
    await fx.db.insert(profiles).values({
      id: siblingProfileId,
      accountId: fx.alice.accountId,
      name: `sibling-${siblingProfileId}`,
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
    const sibling = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, siblingProfileId);

    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'grid-sell',
      binanceOrderId: targetOrderId,
      clientOrderId: 'attr-target',
      status: 'FILLED',
      raw: { executedQty: '3.12000000' },
      closedAt,
    });
    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'duplicate-canceled',
      binanceOrderId: targetOrderId,
      clientOrderId: 'attr-duplicate-canceled',
      status: 'CANCELED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await sibling.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'protective-stop',
      binanceOrderId: targetOrderId,
      clientOrderId: 'attr-sibling',
      status: 'FILLED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await bp.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'exit',
      binanceOrderId: targetOrderId,
      clientOrderId: 'attr-other-account',
      status: 'FILLED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await ap.orders.insert({
      symbol: 'OTHERUSDT',
      side: 'SELL',
      intent: 'wrong-symbol',
      binanceOrderId: wrongSymbolOrderId,
      clientOrderId: 'attr-wrong-symbol',
      status: 'FILLED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'BUY',
      intent: 'wrong-side',
      binanceOrderId: buyOrderId,
      clientOrderId: 'attr-buy',
      status: 'FILLED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'wrong-status',
      binanceOrderId: nonFilledOrderId,
      clientOrderId: 'attr-canceled',
      status: 'CANCELED',
      raw: { executedQty: '3.12' },
      closedAt,
    });
    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'not-closed',
      binanceOrderId: openOrderId,
      clientOrderId: 'attr-open',
      status: 'FILLED',
      raw: { executedQty: '3.12' },
    });
    await ap.orders.insert({
      symbol: 'ATTRUSDT',
      side: 'SELL',
      intent: 'numeric-qty',
      binanceOrderId: numericQtyOrderId,
      clientOrderId: 'attr-numeric-qty',
      status: 'FILLED',
      raw: { executedQty: 3.12 },
      closedAt,
    });

    const candidates = await ap.orders.listRecoveryAttributionRows('ATTRUSDT', [
      targetOrderId,
      wrongSymbolOrderId,
      buyOrderId,
      nonFilledOrderId,
      openOrderId,
      numericQtyOrderId,
    ]);

    expect(candidates).toHaveLength(6);
    expect(candidates).toEqual(
      expect.arrayContaining([
        {
          binanceOrderId: targetOrderId,
          intent: 'grid-sell',
          side: 'SELL',
          status: 'FILLED',
          closedAt,
          executedQty: '3.12000000',
        },
        expect.objectContaining({
          binanceOrderId: targetOrderId,
          intent: 'duplicate-canceled',
          status: 'CANCELED',
        }),
        expect.objectContaining({ intent: 'wrong-side', side: 'BUY' }),
        expect.objectContaining({ intent: 'wrong-status', status: 'CANCELED' }),
        expect.objectContaining({ intent: 'not-closed', closedAt: null }),
        expect.objectContaining({ intent: 'numeric-qty', executedQty: null }),
      ]),
    );
    // One assertion per leaked row, each naming its own predicate. A single `not.toEqual(arrayContaining([a, b, c]))` passes as soon as ANY one is absent, so it would stay green while two of the three predicates leaked.
    const intents = candidates.map((candidate) => candidate.intent);
    expect(intents).not.toContain('protective-stop'); // sibling profile, same account
    expect(intents).not.toContain('exit'); // other account
    expect(intents).not.toContain('wrong-symbol'); // other symbol
  });

  it('findLive returns only the owner-scoped row on the happy path', async () => {
    const row = await ap.orders.findLive('BTCUSDT', 'grid-buy');
    if (!row) throw new Error('expected alice live order to exist');
    expect(row.profileId).toBe(fx.alice.profileId);
    expect((row.raw as { tag?: string }).tag).toBe('alice-buy');
  });

  it('insert lands the row on the owner profile', async () => {
    await ap.orders.insert(liveOrder('alice-extra', 'BUY', 'manual', 'ETHUSDT'));
    const rows = await ap.orders.listLiveForSymbol('ETHUSDT');
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect((rows[0]?.raw as { tag?: string } | undefined)?.tag).toBe('alice-extra');
  });

  it('close performs the close on the same-owner path', async () => {
    await ap.orders.close('BTCUSDT', 'grid-buy', 'FILLED');
    // No live order left after closing — the unique-on-live index also
    // permits a new live row to land afterwards (relied on by the worker
    // executor on the next grid-buy rung).
    const live = await ap.orders.findLive('BTCUSDT', 'grid-buy');
    expect(live).toBeNull();
  });

  it('upsertLive closes the stale live row and inserts the replacement', async () => {
    // A resting live order already occupies the (symbol, intent) live slot.
    // The partial unique index orders_one_live_per_intent means a plain
    // second insert throws, so the executor must replace atomically: close
    // the stale row, insert the new one, in one transaction.
    const symbol = 'WLDUSDT';
    const intent = 'grid-buy';
    const stale = await ap.orders.insert(liveOrder('wld-stale', 'BUY', intent, symbol));
    expect(stale.closedAt).toBeNull();

    const replacement = await ap.orders.upsertLive(liveOrder('wld-fresh', 'BUY', intent, symbol), {
      closePrevious: true,
    });

    const staleAfter = await ap.orders.findById(stale.id);
    if (!staleAfter) throw new Error('expected stale row to still exist after upsertLive');
    expect(staleAfter.status).toBe('CANCELED');
    expect(staleAfter.closedAt).not.toBeNull();

    expect(replacement.status).toBe('NEW');
    expect(replacement.closedAt).toBeNull();
    expect((replacement.raw as { tag?: string }).tag).toBe('wld-fresh');

    const live = await ap.orders.listLiveForSymbol(symbol);
    const liveForIntent = live.filter((r) => r.intent === intent);
    expect(liveForIntent).toHaveLength(1);
    expect(liveForIntent[0]?.id).toBe(replacement.id);
  });

  it('upsertLive REFUSES to close the previous order when the caller cannot prove it is gone', async () => {
    // The cancel that should have cleared this slot failed, so the previous order
    // may still be RESTING on Binance. Stamping its row CANCELED would record a
    // live order as cancelled — two live orders on the book, one bogus record.
    // The write must refuse, not lie.
    const symbol = 'ARBUSDT';
    const intent = 'stop-loss';
    const resting = await ap.orders.insert(liveOrder('arb-resting', 'SELL', intent, symbol));

    await expect(
      ap.orders.upsertLive(liveOrder('arb-replacement', 'SELL', intent, symbol), {
        closePrevious: false,
      }),
    ).rejects.toThrow(/live slot/i);

    // The resting order's row is untouched: still live, still the truth.
    const after = await ap.orders.findById(resting.id);
    expect(after?.status).toBe('NEW');
    expect(after?.closedAt).toBeNull();
  });

  it('upsertLive with closePrevious=false still inserts when the slot is free', async () => {
    // Nothing to lie about: no row holds the slot, so the refusal must not fire.
    const row = await ap.orders.upsertLive(liveOrder('free-slot', 'BUY', 'entry', 'OPUSDT'), {
      closePrevious: false,
    });
    expect(row.closedAt).toBeNull();
  });

  it('insertTracking STILL WRITES THE ROW when the live slot is occupied (the recovery case itself)', async () => {
    // REGRESSION. The order IS on Binance but its bookkeeping failed — and the most
    // likely reason it failed is that the strategy's live slot is held by the
    // still-resting previous order (LiveSlotOccupiedError). Writing the recovery row
    // under the strategy's own intent made the partial unique index the arbiter, so
    // `onConflictDoNothing` swallowed the insert and the live order kept its ZERO
    // local trace. The reserved per-order intent is what makes the row land.
    const symbol = 'TIAUSDT';
    const intent = 'grid-buy';
    const held = await ap.orders.insert(liveOrder('tia-held', 'BUY', intent, symbol));
    const tracked = liveOrder('tia-tracked', 'BUY', intent, symbol);

    // The slot genuinely refuses to be reused: exactly the failure that lands us here.
    await expect(
      ap.orders.upsertLive(liveOrder('tia-doomed', 'BUY', intent, symbol), {
        closePrevious: false,
      }),
    ).rejects.toThrow(/live slot/i);

    await ap.orders.insertTracking(tracked);

    // The row EXISTS, carrying its Binance id — the only handle the user-data stream
    // can reconcile a fill by.
    const row = await aa.orders.findByBinanceOrderId(tracked.binanceOrderId);
    expect(row?.clientOrderId).toBe(tracked.clientOrderId);
    expect(row?.intent).toBe(`${intent}:untracked:${tracked.binanceOrderId}`);
    // It is OPEN, so it counts toward the account's exposure and stays visible to
    // the orphan sweep (both read `closed_at`, not `intent`).
    expect(row?.closedAt).toBeNull();
    const trackedLive = await listLiveBinanceOrderIdsByAccount(fx.db);
    expect(trackedLive.map((r) => r.binanceOrderId)).toContain(tracked.binanceOrderId);

    // The incumbent is untouched: still live, still holding its slot, still the truth.
    const heldAfter = await ap.orders.findById(held.id);
    expect(heldAfter?.status).toBe('NEW');
    expect(heldAfter?.closedAt).toBeNull();
    const live = await ap.orders.listLiveForSymbol(symbol);
    expect(live.filter((r) => r.intent === intent)).toHaveLength(1);
  });

  it('insertTracking is idempotent for the same order', async () => {
    // The recovery path can be reached twice for one order (a retried probe). The
    // second write must be absorbed, not throw and not duplicate the row.
    const tracked = liveOrder('sei-tracked', 'BUY', 'entry', 'SEIUSDT');
    await ap.orders.insertTracking(tracked);
    await expect(ap.orders.insertTracking(tracked)).resolves.toBeUndefined();
    const rows = await ap.orders.listLiveForSymbol('SEIUSDT');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closedAt).toBeNull();
  });

  it('insertTracking lands a TERMINAL recovery row with closed_at set', async () => {
    // A probed MARKET order comes back FILLED. A terminal row written open would
    // hold the live slot forever, count toward exposure forever, and be stamped
    // CANCELED by the next order — erasing a real trade from the archive.
    const filled = {
      ...liveOrder('doge-filled', 'SELL', 'exit', 'DOGEUSDT'),
      status: 'FILLED',
      closedAt: new Date(1_700_000_000_999),
    };
    await ap.orders.insertTracking(filled);
    const row = await aa.orders.findByBinanceOrderId(filled.binanceOrderId);
    expect(row?.status).toBe('FILLED');
    expect(row?.closedAt).toEqual(new Date(1_700_000_000_999));
    const trackedLive = await listLiveBinanceOrderIdsByAccount(fx.db);
    expect(trackedLive.map((r) => r.binanceOrderId)).not.toContain(filled.binanceOrderId);
  });

  it('closeByBinanceOrderId refreshes raw when given a fresh snapshot (the cancel-vs-fill reconcile)', async () => {
    // A grid-buy whose stored snapshot says NEW/executedQty 0 actually FILLED;
    // the -2011 reconcile closes it with the true status and a fresh raw so the
    // order history stops showing a filled buy as canceled.
    const stale = liveOrder('reconcile', 'BUY', 'grid-buy', 'AVAXUSDT');
    await ap.orders.insert(stale);
    const freshRaw = { status: 'FILLED', executedQty: '30.9', cummulativeQuoteQty: '15.1' };
    const closed = await aa.orders.closeByBinanceOrderId(
      stale.binanceOrderId,
      'FILLED',
      1_700_000_000_999,
      freshRaw,
    );
    expect(closed).toBe(1);
    const row = await aa.orders.findByBinanceOrderId(stale.binanceOrderId);
    if (!row) throw new Error('expected the closed row to be findable');
    expect(row.status).toBe('FILLED');
    expect(row.closedAt).not.toBeNull();
    expect((row.raw as { executedQty?: string }).executedQty).toBe('30.9');
  });

  it('markFilledByBinanceOrderId reclaims a wrongly-CANCELED row, patches raw, and is idempotent', async () => {
    // A resting STOP_LOSS_LIMIT buy filled on Binance, but a racing upsertLive
    // had already clobbered its row to CANCELED with executedQty 0. The fill
    // reconciliation must reclaim it to FILLED (no closed_at guard) and merge
    // the real fill totals into raw, preserving the rest of the snapshot — so
    // the archive's `raw->>'cummulativeQuoteQty'` cost basis is truthful.
    const o = {
      symbol: 'ENAUSDT',
      side: 'BUY' as const,
      intent: 'grid-buy',
      binanceOrderId: nextBinanceOrderId++,
      clientOrderId: 'cli-reclaim',
      status: 'CANCELED',
      closedAt: new Date('2026-06-13T00:00:00.000Z'),
      raw: {
        tag: 'reclaim',
        clientOrderId: 'cli-reclaim',
        status: 'CANCELED',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      },
    };
    await ap.orders.insert(o);

    const n = await aa.orders.markFilledByBinanceOrderId(o.binanceOrderId, {
      executedQty: '163.2',
      cummulativeQuoteQty: '15.14496',
    });
    expect(n).toBe(1);

    const row = await aa.orders.findByBinanceOrderId(o.binanceOrderId);
    if (!row) throw new Error('expected the reclaimed row to be findable');
    expect(row.status).toBe('FILLED');
    expect(row.closedAt).not.toBeNull();
    const raw = row.raw as {
      tag?: string;
      executedQty?: string;
      cummulativeQuoteQty?: string;
      status?: string;
    };
    expect(raw.cummulativeQuoteQty).toBe('15.14496'); // patched cost basis
    expect(raw.executedQty).toBe('163.2');
    expect(raw.status).toBe('FILLED');
    expect(raw.tag).toBe('reclaim'); // other raw keys preserved by the jsonb merge

    // Idempotent: a Binance executionReport replay updates 0 rows.
    const again = await aa.orders.markFilledByBinanceOrderId(o.binanceOrderId, {
      executedQty: '163.2',
      cummulativeQuoteQty: '15.14496',
    });
    expect(again).toBe(0);
  });

  it('markFilledByBinanceOrderId fills the common NEW row (no race), and no-ops an untracked id', async () => {
    // The everyday path: a resting order is inserted NEW (still holding the
    // live slot, closed_at null) and fills before any slot-reuse race. The
    // predicate is `status <> 'FILLED'`, so NEW is in scope just like CANCELED.
    const live = liveOrder('new-fill', 'BUY', 'grid-buy', 'INJUSDT');
    await ap.orders.insert(live); // status NEW, closed_at null

    const n = await aa.orders.markFilledByBinanceOrderId(live.binanceOrderId, {
      executedQty: '50',
      cummulativeQuoteQty: '12.5',
    });
    expect(n).toBe(1);
    const row = await aa.orders.findByBinanceOrderId(live.binanceOrderId);
    if (!row) throw new Error('expected the filled row to be findable');
    expect(row.status).toBe('FILLED');
    expect(row.closedAt).not.toBeNull();
    expect((row.raw as { cummulativeQuoteQty?: string }).cummulativeQuoteQty).toBe('12.5');

    // An id that was never tracked matches nothing → 0 rows, no throw.
    const untracked = await aa.orders.markFilledByBinanceOrderId(nextBinanceOrderId++, {
      executedQty: '1',
      cummulativeQuoteQty: '1',
    });
    expect(untracked).toBe(0);
  });

  it('listLiveBinanceOrderIdsByAccount returns live ids tagged with their OWNING ACCOUNT, excluding closed', async () => {
    // Global read backing the orphan-detection cron's tracked set: every live row
    // appears tagged with the account that owns it (an order id is unique only
    // within one account) and its account's mode; a closed row does not.
    const aliceLive = liveOrder('g-alice', 'BUY', 'grid-buy', 'SOLUSDT');
    const bobLive = liveOrder('g-bob', 'BUY', 'grid-buy', 'SOLUSDT');
    const toClose = liveOrder('g-closed', 'BUY', 'manual', 'SOLUSDT');
    await ap.orders.insert(aliceLive);
    await bp.orders.insert(bobLive);
    await ap.orders.insert(toClose);
    await ap.orders.close('SOLUSDT', 'manual', 'CANCELED');

    const rows = await listLiveBinanceOrderIdsByAccount(fx.db);
    const liveIds = rows.map((r) => r.binanceOrderId);
    expect(liveIds).toContain(aliceLive.binanceOrderId);
    expect(liveIds).toContain(bobLive.binanceOrderId);
    expect(liveIds).not.toContain(toClose.binanceOrderId);
    // Each id is tagged with its OWNING ACCOUNT (the scan key) and that account's
    // mode (fixture = testnet).
    const alice = rows.find((r) => r.binanceOrderId === aliceLive.binanceOrderId);
    expect(alice?.accountId).toBe(fx.alice.accountId);
    expect(alice?.mode).toBe('test');
    expect(rows.find((r) => r.binanceOrderId === bobLive.binanceOrderId)?.accountId).toBe(
      fx.bob.accountId,
    );
  });

  it('table-level invariant: every orders row resolves to its owning profile (immune to a parallel fixture teardown)', async () => {
    // The FK to profiles is ON DELETE CASCADE so orphans should be structurally
    // impossible, but a future schema change could weaken the FK without
    // realising it — the scan still catches that.
    //
    // Regression for #487: the isolation files share one `binance_test` DB and
    // run in parallel (see _helpers.ts), so an unscoped `SELECT * FROM orders`
    // captures rows owned by OTHER files' fixtures. When such a file's afterAll
    // cleanup() CASCADE-deletes its profile between the scan and the per-row
    // owner lookup, the captured foreign row resolves to zero profiles
    // ('expected [] to have length 1'). The interleaved foreign teardown below
    // reproduces that timing; scoping the scan to THIS fixture's profiles (only
    // this file deletes them, in afterAll) makes it deterministic.
    const foreignUser = randomUUID();
    const foreignAccount = randomUUID();
    const foreignProfile = randomUUID();
    await fx.db.insert(users).values({ id: foreignUser, email: `foreign-${foreignUser}@local` });
    await fx.db
      .insert(accounts)
      .values({ id: foreignAccount, ownerId: foreignUser, name: 'foreign', binanceMode: 'test' });
    await fx.db.insert(profiles).values({
      id: foreignProfile,
      accountId: foreignAccount,
      name: 'foreign',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
    const foreign = await profileRepo(
      fx.db,
      asUserId(foreignUser),
      asAccountId(foreignAccount),
      asProfileId(foreignProfile),
    );
    await foreign.orders.insert(liveOrder('foreign', 'BUY', 'grid-buy', 'XRPUSDT'));

    const ownIds = [fx.alice.profileId, fx.bob.profileId];
    const rows = await fx.db.select().from(orders).where(inArray(orders.profileId, ownIds));

    // A parallel file's afterAll cleanup lands here, mid-invariant: deleting the
    // foreign user CASCADE-drops its profile and order. A scoped scan never read
    // the foreign row, so the owner lookups below still all resolve.
    await fx.db.delete(users).where(eq(users.id, foreignUser));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
