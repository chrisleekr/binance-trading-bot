import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  accountRepo,
  accountRepoFromScope,
  profileRepo,
  type AccountRepo,
  type ProfileRepo,
} from '../../src/repo/index.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

/**
 * Behaviour suite for the `override-actions` repo: the terminal writers
 * (`settle` / `finalize` / `reapExpiredForAccount`, which all share one private
 * `consume`) and the `claimAction`/`releaseClaim`/`reapStaleProcessing`
 * processing lifecycle. Skipped when `TEST_DB_URL` is unset so workstations
 * without Postgres still see `bun run test` go green; CI runs against a live
 * database.
 *
 * Every terminal write records an OUTCOME, never just a `consumed_at`: a row
 * closed out with no outcome cannot tell a filled force-sell apart from one the
 * exchange refused, and reads on the symbol page exactly like a success.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('override-actions repo', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let aa: AccountRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    aa = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('settle closes out only the row whose id was passed', async () => {
    // Regression guard: an earlier revision built the WHERE clause from
    // `profileId` + `IS NULL` only and dropped the id, so settling one row
    // flipped every pending row for the profile.
    const a = await ap.overrideActions.record({
      symbol: 'BTCUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'test',
    });
    const b = await ap.overrideActions.record({
      symbol: 'ETHUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'test',
    });

    await ap.overrideActions.settle(a.id, { status: 'applied' });

    const stillPending = await ap.overrideActions.listPending();
    expect(stillPending.map((row) => row.id)).toEqual([b.id]);
  });

  const newAction = (symbol: string) =>
    ap.overrideActions.record({
      symbol,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'test',
    });

  /**
   * Digs the Postgres error code out of a rejection: drizzle wraps driver errors in
   * its own query error and hangs the original off `cause`.
   */
  const pgErrorCode = (err: unknown): string | undefined => {
    if (typeof err !== 'object' || err === null) return undefined;
    if ('code' in err && typeof err.code === 'string') return err.code;
    return 'cause' in err ? pgErrorCode(err.cause) : undefined;
  };

  /**
   * Reads one row by id, bypassing the repo's own reads: `listPending` excludes a
   * settled row by definition and the symbol reads return only the NEWEST row for
   * the symbol, so neither can show what a supersede did to the row underneath.
   */
  const rowById = async (id: string) => {
    const rows = await fx.db
      .select()
      .from(schema.overrideActions)
      .where(eq(schema.overrideActions.id, id));
    return rows[0];
  };

  it('claimAction wins once — a second claim on the same row returns false', async () => {
    const row = await newAction('CLAIM1USDT');
    expect(await ap.overrideActions.claimAction(row.id, new Date())).toBe(true);
    expect(await ap.overrideActions.claimAction(row.id, new Date())).toBe(false);
  });

  it('claimAction returns false for an already-consumed row', async () => {
    const row = await newAction('CLAIM2USDT');
    await ap.overrideActions.settle(row.id, { status: 'applied' });
    expect(await ap.overrideActions.claimAction(row.id, new Date())).toBe(false);
  });

  it('finalize advances a claimed row to consumed, stamping the applied outcome', async () => {
    const row = await newAction('FINAL1USDT');
    await ap.overrideActions.claimAction(row.id, new Date());
    expect(await ap.overrideActions.finalize(row.id)).toBe(true);
    const stillPending = await ap.overrideActions.listPending();
    expect(stillPending.some((r) => r.id === row.id)).toBe(false);
    // Reaching finalize means the side-effect succeeded, so the row says so —
    // "terminal" and "carries an outcome" are the same fact.
    const history = await ap.overrideActions.listDustTransferHistory(50);
    expect(history.find((r) => r.id === row.id)?.outcome?.status).toBe('applied');
  });

  it('finalize is a no-op returning false on a row that was never claimed', async () => {
    const row = await newAction('FINAL2USDT');
    expect(await ap.overrideActions.finalize(row.id)).toBe(false);
    const stillPending = await ap.overrideActions.listPending();
    expect(stillPending.some((r) => r.id === row.id && r.consumedAt === null)).toBe(true);
  });

  it('releaseClaim resets a processing row so it can be claimed again', async () => {
    const row = await newAction('RELEASE1USDT');
    const claimAt = new Date();
    await ap.overrideActions.claimAction(row.id, claimAt);
    await ap.overrideActions.releaseClaim(row.id, claimAt);
    const pending = await ap.overrideActions.listPending();
    expect(pending.find((r) => r.id === row.id)?.processingAt).toBeNull();
    expect(await ap.overrideActions.claimAction(row.id, new Date())).toBe(true);
  });

  it('releaseClaim ignores a stamp that is not the one on the row', async () => {
    // The fence. Every caller bounds its writes by a deadline, and a deadline ABANDONS
    // the write rather than cancelling it, so a release issued under one attempt can
    // land after a different consumer has claimed the row. Unfenced, that late write
    // clears the live claim and the guard protecting an in-flight order from an
    // operator cancel silently comes off.
    const row = await newAction('FENCEDUSDT');
    const abandoned = new Date(Date.now() - 30_000);
    const live = new Date();
    expect(await ap.overrideActions.claimAction(row.id, live)).toBe(true);

    await ap.overrideActions.releaseClaim(row.id, abandoned);

    const stillClaimed = await ap.overrideActions.findActiveForSymbol('FENCEDUSDT');
    expect(stillClaimed?.processingAt).toEqual(live);
    // And the row is still protected from a cancel, which is the point of the fence.
    expect(await ap.overrideActions.deletePendingForSymbol('FENCEDUSDT')).toBe(0);

    // The holder's own stamp still works, so this is not passing by refusing everything.
    await ap.overrideActions.releaseClaim(row.id, live);
    expect((await ap.overrideActions.findActiveForSymbol('FENCEDUSDT'))?.processingAt).toBeNull();
  });

  it('reapStaleProcessing resets a claim only when it predates the cutoff', async () => {
    const row = await newAction('REAPUSDT');
    await ap.overrideActions.claimAction(row.id, new Date());

    // A cutoff before the claim leaves the row processing.
    await ap.overrideActions.reapStaleProcessing(new Date(Date.now() - 60_000));
    const afterPast = await ap.overrideActions.listPending();
    expect(afterPast.find((r) => r.id === row.id)?.processingAt).not.toBeNull();

    // A cutoff after the claim resets it back to pending.
    const reaped = await ap.overrideActions.reapStaleProcessing(new Date(Date.now() + 60_000));
    expect(reaped).toBeGreaterThanOrEqual(1);
    const afterFuture = await ap.overrideActions.listPending();
    expect(afterFuture.find((r) => r.id === row.id)?.processingAt).toBeNull();
  });

  it('deletePendingForSymbol removes a pending row and returns 1', async () => {
    await newAction('DELPENDUSDT');
    expect(await ap.overrideActions.deletePendingForSymbol('DELPENDUSDT')).toBe(1);
    expect(await ap.overrideActions.findActiveForSymbol('DELPENDUSDT')).toBeNull();
  });

  it('deletePendingForSymbol skips a processing row a worker has claimed', async () => {
    const row = await newAction('DELPROCUSDT');
    await ap.overrideActions.claimAction(row.id, new Date());

    // The claimed row is mid-side-effect: an operator cancel must not delete it.
    expect(await ap.overrideActions.deletePendingForSymbol('DELPROCUSDT')).toBe(0);
    const survivor = await ap.overrideActions.findActiveForSymbol('DELPROCUSDT');
    expect(survivor?.id).toBe(row.id);
    expect(survivor?.processingAt).not.toBeNull();

    await ap.overrideActions.settle(row.id, { status: 'applied' });
  });

  it('settle closes out a row that is still holding its claim', async () => {
    // The tick claims the row before dispatching and then settles it with the outcome
    // the operator got. `settle` carries no `processing_at` predicate, so the claim
    // cannot block that. If it could, every claimed override would settle nowhere and
    // the operator would watch a force-sell that already ran sit "pending" until the
    // expiry sweep relabelled it as never having happened.
    const row = await newAction('SETTLECLAIMEDUSDT');
    expect(await ap.overrideActions.claimAction(row.id, new Date())).toBe(true);

    await ap.overrideActions.settle(row.id, { status: 'applied' });

    expect(await ap.overrideActions.findActiveForSymbol('SETTLECLAIMEDUSDT')).toBeNull();
    const settled = await ap.overrideActions.findLatestForSymbol(
      'SETTLECLAIMEDUSDT',
      new Date(Date.now() - 60_000),
    );
    expect(settled?.consumedAt).not.toBeNull();
    expect(settled?.outcome?.status).toBe('applied');
  });

  it('reapExpiredForAccount settles a stranded row that never released its claim', async () => {
    // A worker SIGKILLed mid-dispatch leaves the row claimed forever: nothing else
    // releases it, and the cancel route refuses to delete it. This sweep has to reach it
    // without any cooperation from the dead process AND without waiting on the
    // stale-claim reaper: its predicate carries no `processing_at` term, so a still-held
    // claim settles like any other. Otherwise an operator is left with an override that
    // can be neither cancelled nor resolved.
    const stranded = await ap.overrideActions.record({
      symbol: 'CLAIMSTRANDEDUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(await ap.overrideActions.claimAction(stranded.id, new Date())).toBe(true);
    // Breadcrumbed, which is the real shape of a crash past the claim: the claim lands
    // before the dispatch and the breadcrumb immediately after it.
    expect(await ap.overrideActions.markPickedUp(stranded.id)).toBe(true);

    // Claim deliberately left held: the sweep must not depend on the stale-claim reaper
    // having run first.
    expect(
      (await ap.overrideActions.findActiveForSymbol('CLAIMSTRANDEDUSDT'))?.processingAt,
    ).not.toBeNull();

    const swept = await aa.overrideActions.reapExpiredForAccount(
      [fx.alice.profileId],
      new Date('2026-06-01T00:00:00Z'),
    );

    const row = await ap.overrideActions.findLatestForSymbol(
      'CLAIMSTRANDEDUSDT',
      new Date('2020-01-01T00:00:00Z'),
    );
    expect(row?.consumedAt).not.toBeNull();
    // An order may be live on the exchange, so the verdict must send a human to look.
    expect(row?.outcome?.status).toBe('unknown');
    expect(swept.unresolved.filter((r) => r.symbol === 'CLAIMSTRANDEDUSDT')).toHaveLength(1);
  });

  it('findActiveForSymbol surfaces the processing state via processingAt', async () => {
    const row = await newAction('ACTIVEUSDT');
    expect((await ap.overrideActions.findActiveForSymbol('ACTIVEUSDT'))?.processingAt).toBeNull();

    await ap.overrideActions.claimAction(row.id, new Date());
    const claimed = await ap.overrideActions.findActiveForSymbol('ACTIVEUSDT');
    expect(claimed?.id).toBe(row.id);
    expect(claimed?.processingAt).not.toBeNull();

    await ap.overrideActions.settle(row.id, { status: 'applied' });
    expect(await ap.overrideActions.findActiveForSymbol('ACTIVEUSDT')).toBeNull();
  });

  it('findActiveForSymbol returns the most recently created active row', async () => {
    const older = await ap.overrideActions.record({
      symbol: 'LATESTUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'older' },
      triggeredBy: 'test',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    // Claimed, which is the one shape in which two active rows coexist on a symbol:
    // recording the newer one settles a still-PENDING predecessor, but a row a
    // consumer already holds is left alone, and "active" spans both states.
    expect(await ap.overrideActions.claimAction(older.id, new Date())).toBe(true);
    const newer = await ap.overrideActions.record({
      symbol: 'LATESTUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'newer' },
      triggeredBy: 'test',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const found = await ap.overrideActions.findActiveForSymbol('LATESTUSDT');
    expect(found?.id).toBe(newer.id);
    expect(older.id).not.toBe(newer.id);
  });

  it('settle records the outcome alongside consumed_at, not just the timestamp', async () => {
    const row = await ap.overrideActions.record({
      symbol: 'SETTLEUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    await ap.overrideActions.settle(row.id, {
      status: 'rejected',
      reason: 'binance logic -2010: insufficient balance',
    });

    const found = await ap.overrideActions.findLatestForSymbol(
      'SETTLEUSDT',
      new Date(Date.now() - 600_000),
    );
    expect(found?.consumedAt).not.toBeNull();
    // Without the outcome a settled row cannot tell a filled force-sell apart
    // from one the exchange refused — which is the whole point of the column.
    expect(found?.outcome).toMatchObject({
      status: 'rejected',
      reason: 'binance logic -2010: insufficient balance',
    });
    expect(typeof found?.outcome?.at).toBe('string');
    // The outcome has its OWN column: `result` is the side-effect payload the
    // dust flow writes, and settling must not scribble over it.
    expect(found?.result).toBeNull();
  });

  it('settle leaves an already-settled row untouched, so a replay cannot rewrite history', async () => {
    const row = await ap.overrideActions.record({
      symbol: 'IMMUTABLEUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    await ap.overrideActions.settle(row.id, { status: 'applied' });
    await ap.overrideActions.settle(row.id, { status: 'rejected', reason: 'a replayed tick' });

    const found = await ap.overrideActions.findLatestForSymbol(
      'IMMUTABLEUSDT',
      new Date(Date.now() - 600_000),
    );
    expect(found?.outcome?.status).toBe('applied');
  });

  it('findLatestForSymbol returns a SETTLED row — that is the one carrying the outcome', async () => {
    const row = await ap.overrideActions.record({
      symbol: 'CONSUMEDUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    await ap.overrideActions.settle(row.id, { status: 'applied' });

    // findActiveForSymbol deliberately hides it; the outcome read must not.
    expect(await ap.overrideActions.findActiveForSymbol('CONSUMEDUSDT')).toBeNull();
    const found = await ap.overrideActions.findLatestForSymbol(
      'CONSUMEDUSDT',
      new Date(Date.now() - 600_000),
    );
    expect(found?.id).toBe(row.id);
  });

  it('findLatestForSymbol ignores a row older than the window', async () => {
    await ap.overrideActions.record({
      symbol: 'STALEWINDOWUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(
      await ap.overrideActions.findLatestForSymbol(
        'STALEWINDOWUSDT',
        new Date(Date.now() - 600_000),
      ),
    ).toBeNull();
  });

  it('reapExpiredForAccount settles stranded symbol rows and never touches dust rows', async () => {
    const stranded = await ap.overrideActions.record({
      symbol: 'STRANDEDUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const fresh = await ap.overrideActions.record({
      symbol: 'FRESHUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    // Account-wide dust rows have their own claim/finalize lifecycle and no
    // Redis key to expire; reaping one would settle work still queued to run.
    const dust = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['XRP'] },
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Sibling tests seed their own back-dated rows on this profile, so the count
    // is not pinned here; what matters is exactly WHICH rows the sweep touches.
    await aa.overrideActions.reapExpiredForAccount(
      [fx.alice.profileId],
      new Date('2026-06-01T00:00:00Z'),
    );

    const strandedRow = await ap.overrideActions.findLatestForSymbol(
      'STRANDEDUSDT',
      new Date('2020-01-01T00:00:00Z'),
    );
    expect(strandedRow?.id).toBe(stranded.id);
    expect(strandedRow?.outcome?.status).toBe('expired');
    // No breadcrumb on this row, so no tick ever took the override: the window
    // simply drained. Pinned to the wording that says exactly that — the vaguer
    // "no recorded outcome" it used to carry also covered the crashed-tick case,
    // which is the one an operator has to act on.
    expect(strandedRow?.outcome?.reason).toBe('no tick ran inside the override window');

    const pending = await ap.overrideActions.listPending();
    const pendingIds = pending.map((r) => r.id);
    expect(pendingIds).toContain(fresh.id);
    expect(pendingIds).toContain(dust.id);
    expect(pendingIds).not.toContain(stranded.id);
  });

  it('reapExpiredForAccount reports a breadcrumbed row as unknown, not expired', async () => {
    // The other half of the branch the breadcrumb exists to split. This row was
    // picked up by a tick that never came back — an order may be live on the
    // exchange — so `expired` ("nothing happened, try again") would be a lie, and
    // the operator would re-issue a force-sell that already ran.
    const stamped = await ap.overrideActions.record({
      symbol: 'BREADCRUMBUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(await ap.overrideActions.markPickedUp(stamped.id)).toBe(true);

    const swept = await aa.overrideActions.reapExpiredForAccount(
      [fx.alice.profileId],
      new Date('2026-06-01T00:00:00Z'),
    );

    const row = await ap.overrideActions.findLatestForSymbol(
      'BREADCRUMBUSDT',
      new Date('2020-01-01T00:00:00Z'),
    );
    expect(row?.id).toBe(stamped.id);
    expect(row?.outcome?.status).toBe('unknown');
    expect(row?.outcome?.reason).toBe('a tick consumed this override and no outcome was recorded');

    // The sweep hands the caller back the rows a human has to look at, because a
    // count cannot name a symbol and an alert that cannot name one is unusable.
    // Sibling tests seed their own back-dated rows, so narrow to this symbol.
    const mine = swept.unresolved.filter((r) => r.symbol === 'BREADCRUMBUSDT');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: stamped.id, profileId: fx.alice.profileId });
  });

  it('markPickedUp stamps a row once and reports the later call as a no-op', async () => {
    // Not back-dated: a row the expiry sweep must not reach, so this test cannot
    // perturb the sibling tests that assert on what the sweep settled.
    const row = await ap.overrideActions.record({
      symbol: 'PICKEDUPONCEUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    expect(await ap.overrideActions.markPickedUp(row.id)).toBe(true);
    // A retried job must not slide the breadcrumb forward: its timestamp is the
    // moment the FIRST tick took ownership, which is what dates the crash.
    expect(await ap.overrideActions.markPickedUp(row.id)).toBe(false);
  });

  it('deletePendingForSymbol still deletes a row a tick has breadcrumbed', async () => {
    // The breadcrumb is a marker, never a claim. `processing_at` blocks the cancel
    // route on purpose (a consumer is mid-side-effect); if the breadcrumb did
    // the same, an operator could not cancel an override at all once a tick had
    // touched it, and the re-arm path relies on that DELETE to know the action
    // was revoked.
    const row = await ap.overrideActions.record({
      symbol: 'CANCELAFTERPICKUPUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    expect(await ap.overrideActions.markPickedUp(row.id)).toBe(true);

    expect(await ap.overrideActions.deletePendingForSymbol('CANCELAFTERPICKUPUSDT')).toBe(1);
    expect((await ap.overrideActions.listPending()).map((r) => r.id)).not.toContain(row.id);
  });

  it('listDustTransferHistory returns only dust-transfer rows, newest-first, with the finalized result', async () => {
    // A non-dust action must be excluded from the history.
    await ap.overrideActions.record({
      symbol: null,
      action: 'buy',
      actionAt: new Date(),
      payload: { assets: ['SOL'] },
      triggeredBy: 'user',
      createdAt: new Date('2026-04-01T00:00:00Z'),
    });
    const older = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['XRP'] },
      triggeredBy: 'user',
      createdAt: new Date('2026-04-02T00:00:00Z'),
    });
    const newer = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['ADA'] },
      triggeredBy: 'user',
      createdAt: new Date('2026-04-03T00:00:00Z'),
    });

    // Finalise the older row with a convert result, persisted to the `result` column.
    await ap.overrideActions.claimAction(older.id, new Date());
    expect(
      await ap.overrideActions.finalize(older.id, {
        totalTransfered: '0.5',
        transferResult: [{ fromAsset: 'XRP' }],
      }),
    ).toBe(true);

    const history = await ap.overrideActions.listDustTransferHistory(50);

    // Filter: only dust-transfer rows (the `buy` row is excluded by the query).
    expect(history.every((r) => r.action === 'dust-transfer')).toBe(true);
    // Order: newest-first, so the later-created row precedes the older one.
    const idxNewer = history.findIndex((r) => r.id === newer.id);
    const idxOlder = history.findIndex((r) => r.id === older.id);
    expect(idxNewer).toBeGreaterThanOrEqual(0);
    expect(idxNewer).toBeLessThan(idxOlder);
    // The convert result round-trips through the jsonb `result` column.
    const finalized = history.find((r) => r.id === older.id);
    expect((finalized?.result as { totalTransfered?: string } | null)?.totalTransfered).toBe('0.5');
  });

  it('reapExpiredForAccount runs the breadcrumbed branch before the NULL branch', async () => {
    // The two `consume()` calls in reapExpiredForAccount are not wrapped in a
    // transaction, and their order is load-bearing: the `picked_up_at is not
    // null` branch MUST run first so a stamp landing between them misses both
    // and survives for the next sweep, rather than being caught by the NULL
    // branch and settled `expired` — a terminal wrong answer about an order that
    // may be live on the exchange.
    //
    // Asserting emitted-SQL order stands in for the race itself, whose window is
    // microseconds wide and which no test can open without a seam in production
    // code. It is a weaker claim than "the race is safe", but it is the claim
    // that fails the moment someone swaps the two calls.

    // One stale unbreadcrumbed row, so the sweep has something to settle.
    await ap.overrideActions.record({
      symbol: 'LOADORDERUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Drizzle's `logger` hook fires per statement as it executes, so the two
    // updates land in `captured` in execution order. A second handle over the
    // fixture's own pool keeps the capture to this sweep.
    const captured: string[] = [];
    const traced = accountRepoFromScope({
      ...aa.scope,
      db: drizzle(fx.pool, { schema, logger: { logQuery: (sql) => captured.push(sql) } }),
    });

    await traced.overrideActions.reapExpiredForAccount(
      [fx.alice.profileId],
      new Date('2026-06-01T00:00:00Z'),
    );

    // One update per `consume()` call, so position IS branch order.
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain('"picked_up_at" is not null');
    expect(captured[1]).toContain('"picked_up_at" is null');
  });

  it('record settles the prior pending override for the same symbol as superseded', async () => {
    // Only the newest override can ever run: the Redis key a tick reads is
    // blindly overwritten by the later record. Left unconsumed the older row is a
    // ghost — it sits "pending" on the symbol page for the whole expiry window,
    // describing work that can no longer happen.
    const older = await ap.overrideActions.record({
      symbol: 'SUPERSEDEUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'older' },
      triggeredBy: 'user',
    });
    const newer = await ap.overrideActions.record({
      symbol: 'SUPERSEDEUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'newer' },
      triggeredBy: 'user',
    });

    const settled = await rowById(older.id);
    expect(settled?.consumedAt).not.toBeNull();
    expect(settled?.outcome?.status).toBe('superseded');
    expect(typeof settled?.outcome?.at).toBe('string');

    const active = (await ap.overrideActions.listPending()).filter(
      (r) => r.symbol === 'SUPERSEDEUSDT',
    );
    expect(active.map((r) => r.id)).toEqual([newer.id]);
  });

  it('record leaves a prior override a consumer has claimed untouched', async () => {
    // A claimed row is mid-side-effect. Settling it `superseded` would record
    // "replaced before it ran" about an order that may already be on the wire, and
    // terminally: the one writer refuses to rewrite a settled row.
    const claimed = await ap.overrideActions.record({
      symbol: 'SUPERSEDECLAIMEDUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    expect(await ap.overrideActions.claimAction(claimed.id, new Date())).toBe(true);

    await ap.overrideActions.record({
      symbol: 'SUPERSEDECLAIMEDUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    const survivor = await rowById(claimed.id);
    expect(survivor?.consumedAt).toBeNull();
    expect(survivor?.outcome).toBeNull();
  });

  it('record leaves a prior override a tick has already taken untouched', async () => {
    // The breadcrumb says a tick took this override out of Redis and may have
    // dispatched from it. Same reason as a claim: the row's fate belongs to the
    // consumer that owns it, or to the sweep that decides it is unresolvable.
    const dispatched = await ap.overrideActions.record({
      symbol: 'SUPERSEDEPICKEDUPUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    expect(await ap.overrideActions.markPickedUp(dispatched.id)).toBe(true);

    await ap.overrideActions.record({
      symbol: 'SUPERSEDEPICKEDUPUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    const survivor = await rowById(dispatched.id);
    expect(survivor?.consumedAt).toBeNull();
    expect(survivor?.outcome).toBeNull();
  });

  it('record never supersedes a profile-level dust row, which carries no symbol', async () => {
    // Dust conversions are account-wide, have their own claim/finalize lifecycle and
    // no Redis key one can overwrite: two queued conversions are two real pieces of
    // work, not a replacement. What this pins is that nobody adds an `isNull(symbol)`
    // arm to the supersede predicate — a plain `symbol = NULL` could never match.
    const first = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['XRP'] },
      triggeredBy: 'user',
    });
    const second = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets: ['ADA'] },
      triggeredBy: 'user',
    });

    const pendingIds = (await ap.overrideActions.listPending()).map((r) => r.id);
    expect(pendingIds).toContain(first.id);
    expect(pendingIds).toContain(second.id);
  });

  it('record supersedes only the same symbol on the same profile', async () => {
    // The blast radius. A supersede bounded by profile alone would settle every
    // other symbol's queued override on the account; bounded by symbol alone it
    // would reach across profiles, which share a wallet but never an override.
    const otherSymbol = await ap.overrideActions.record({
      symbol: 'SUPERSEDEOTHERUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });
    const bobRow = await bp.overrideActions.record({
      symbol: 'SUPERSEDESCOPEUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    await ap.overrideActions.record({
      symbol: 'SUPERSEDESCOPEUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    const untouchedSymbol = await rowById(otherSymbol.id);
    expect(untouchedSymbol?.consumedAt).toBeNull();
    expect(untouchedSymbol?.outcome).toBeNull();
    const untouchedProfile = await rowById(bobRow.id);
    expect(untouchedProfile?.consumedAt).toBeNull();
    expect(untouchedProfile?.outcome).toBeNull();
  });

  it('a failed insert leaves the prior override pending, so the two writes are one unit', async () => {
    // Split across two statements the operator loses the override entirely: the
    // predecessor is settled "replaced" while the replacement never lands, and no
    // pending row is left for any tick to run.
    const prior = await ap.overrideActions.record({
      symbol: 'SUPERSEDEATOMICUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: {},
      triggeredBy: 'user',
    });

    // Reusing the prior row's primary key is what makes the INSERT fail. Asserting
    // the code rather than merely "it threw" is what keeps this honest: a future
    // pre-flight guard rejecting before the supersede runs would satisfy a bare
    // toThrow and leave the surviving assertions passing on a path never taken.
    const rejection = await ap.overrideActions
      .record({
        id: prior.id,
        symbol: 'SUPERSEDEATOMICUSDT',
        action: 'buy',
        actionAt: new Date(),
        payload: {},
        triggeredBy: 'user',
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    // 23505 = unique_violation, so the INSERT reached Postgres inside the transaction.
    expect(pgErrorCode(rejection)).toBe('23505');

    const untouched = await rowById(prior.id);
    expect(untouched?.consumedAt).toBeNull();
    expect(untouched?.outcome).toBeNull();
  });

  it('findLatestForSymbol still surfaces a superseded row once the newer one is cancelled', async () => {
    const older = await ap.overrideActions.record({
      symbol: 'SUPERSEDEREADUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'older' },
      triggeredBy: 'user',
    });
    await ap.overrideActions.record({
      symbol: 'SUPERSEDEREADUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'newer' },
      triggeredBy: 'user',
    });
    expect((await rowById(older.id))?.outcome?.status).toBe('superseded');

    // The operator cancels the replacement, which deletes only what is still
    // pending — exactly one row now. The superseded predecessor then becomes the
    // newest row in the window, and the read carries no status filter, so it is what
    // the symbol page falls back to: it has to explain itself rather than read as an
    // override that simply never resolved.
    expect(await ap.overrideActions.deletePendingForSymbol('SUPERSEDEREADUSDT')).toBe(1);

    const found = await ap.overrideActions.findLatestForSymbol(
      'SUPERSEDEREADUSDT',
      new Date(Date.now() - 600_000),
    );
    expect(found?.id).toBe(older.id);
    expect(found?.outcome?.status).toBe('superseded');
  });
});
