import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { overrideActions } from '../../src/schema/override-actions.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for
 * `packages/db/src/repo/override-actions.ts`. Every exported fn takes a
 * `ProfileScope`, so a wrong-owner call cannot be expressed — ownership is
 * proven once by `scopeProfile`. Cross-account rejection lives in
 * `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('override-actions account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;
  let aliceRowId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Seed one pending action per account.
    const aRow = await ap.overrideActions.record({
      symbol: 'BTCUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'alice-act' },
      triggeredBy: 'test',
    });
    aliceRowId = aRow.id;
    await bp.overrideActions.record({
      symbol: 'BTCUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'bob-act' },
      triggeredBy: 'test',
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listPending returns only the owner-scoped rows on the happy path', async () => {
    const rows = await ap.overrideActions.listPending();
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    expect(rows[0]?.payload).toEqual({ tag: 'alice-act' });
  });

  it('record lands the action on the owner profile', async () => {
    await ap.overrideActions.record({
      symbol: 'ETHUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'alice-eth' },
      triggeredBy: 'test',
    });
    const rows = await ap.overrideActions.listPending();
    expect(rows.find((r) => (r.payload as { tag?: string }).tag === 'alice-eth')?.profileId).toBe(
      fx.alice.profileId,
    );
  });

  it('findActiveForSymbol returns the correct account row on the happy path', async () => {
    const row = await ap.overrideActions.findActiveForSymbol('BTCUSDT');
    expect(row?.id).toBe(aliceRowId);
    expect(row?.payload).toEqual({ tag: 'alice-act' });
  });

  it('deletePendingForSymbol deletes the owner pending row on the happy path', async () => {
    // Self-contained — seed a row inside this test so removal does not
    // poison shared state for later tests in the suite.
    const seeded = await ap.overrideActions.record({
      symbol: 'XRPUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'alice-xrp' },
      triggeredBy: 'test',
    });
    const deleted = await ap.overrideActions.deletePendingForSymbol('XRPUSDT');
    expect(deleted).toBe(1);
    const gone = await ap.overrideActions.findActiveForSymbol('XRPUSDT');
    expect(gone).toBeNull();
    expect(seeded.id).not.toBe('');
  });

  it('claimAction / finalize advance an owner row through the processing lifecycle', async () => {
    const seeded = await ap.overrideActions.record({
      symbol: 'ADAUSDT',
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { tag: 'alice-ada' },
      triggeredBy: 'test',
    });
    expect(await ap.overrideActions.claimAction(seeded.id, new Date())).toBe(true);
    await ap.overrideActions.finalize(seeded.id);
    const pending = await ap.overrideActions.listPending();
    expect(pending.some((r) => r.id === seeded.id)).toBe(false);
  });

  it("markPickedUp refuses another account's row id and an already-settled row", async () => {
    // Both of its guards, which are the whole contract: the breadcrumb can only ever
    // land on a row this scope owns and has not closed out. The wrong-owner half also
    // shows the scope doing the work — the id is real, so only the `profile_id`
    // predicate can be what rejects it.
    const bobRow = await bp.overrideActions.record({
      symbol: 'LINKUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'bob-link' },
      triggeredBy: 'test',
    });
    expect(await ap.overrideActions.markPickedUp(bobRow.id)).toBe(false);
    expect(await bp.overrideActions.markPickedUp(bobRow.id)).toBe(true);

    const settled = await ap.overrideActions.record({
      symbol: 'AVAXUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'alice-avax' },
      triggeredBy: 'test',
    });
    await ap.overrideActions.settle(settled.id, { status: 'applied' });
    expect(await ap.overrideActions.markPickedUp(settled.id)).toBe(false);

    // Leave no pending rows behind for the sibling assertions on `listPending`.
    await bp.overrideActions.settle(bobRow.id, { status: 'applied' });
  });

  it('releaseClaim / reapStaleProcessing reset an owner claim back to pending', async () => {
    const seeded = await ap.overrideActions.record({
      symbol: 'DOTUSDT',
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { tag: 'alice-dot' },
      triggeredBy: 'test',
    });
    // The release is fenced on the claim's stamp, so the owner has to hand back the
    // value it claimed with; a different stamp is a no-op even for the owning scope.
    const claimAt = new Date();
    await ap.overrideActions.claimAction(seeded.id, claimAt);
    await ap.overrideActions.releaseClaim(seeded.id, claimAt);
    expect(
      (await ap.overrideActions.listPending()).find((r) => r.id === seeded.id)?.processingAt,
    ).toBeNull();

    await ap.overrideActions.claimAction(seeded.id, new Date());
    const reaped = await ap.overrideActions.reapStaleProcessing(new Date(Date.now() + 60_000));
    expect(reaped).toBeGreaterThanOrEqual(1);
    // Clean up so the row does not leak a pending action into later tests.
    await ap.overrideActions.settle(seeded.id, { status: 'applied' });
  });

  it('record supersedes only within the owning account', async () => {
    // Arming settles the pending row it replaces, which is the one write in this
    // module that touches a PRE-EXISTING row rather than inserting. Same symbol on
    // both accounts, so only the scope keeps the UPDATE off the neighbour's row.
    // Self-contained symbol: superseding a shared seed would poison later tests.
    const bobRow = await bp.overrideActions.record({
      symbol: 'SUPUSDT',
      action: 'sell',
      actionAt: new Date(),
      payload: { tag: 'bob-sup' },
      triggeredBy: 'test',
    });
    await ap.overrideActions.record({
      symbol: 'SUPUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'alice-sup-first' },
      triggeredBy: 'test',
    });
    await ap.overrideActions.record({
      symbol: 'SUPUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'alice-sup-second' },
      triggeredBy: 'test',
    });

    const bobPending = await bp.overrideActions.listPending();
    expect(bobPending.map((r) => r.id)).toContain(bobRow.id);
    // Alice's own first row DID settle, so the supersede ran at all.
    const alicePending = await ap.overrideActions.listPending();
    expect(alicePending.filter((r) => r.symbol === 'SUPUSDT')).toHaveLength(1);

    await ap.overrideActions.deletePendingForSymbol('SUPUSDT');
    await bp.overrideActions.settle(bobRow.id, { status: 'applied' });
  });

  it('table-level invariant: every override_actions row resolves to its owning profile', async () => {
    // Belt-and-braces scan: every row must FK-resolve to a profile that
    // still exists. Catches a hypothetical migration regression that
    // orphans rows.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(overrideActions)
      .where(inArray(overrideActions.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
