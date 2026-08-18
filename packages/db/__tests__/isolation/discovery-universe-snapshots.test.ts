import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as repo from '../../src/repo/index.js';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import {
  discoveryUniverseSnapshots,
  type DiscoveryUniverseSnapshotPayload,
} from '../../src/schema/discovery-universe-snapshots.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for
 * `packages/db/src/repo/discovery-universe-snapshots.ts` plus the global
 * retention sweep. `record`/`listForProfile` take a `ProfileScope`, so a
 * wrong-owner call cannot be expressed; the cross-profile read here is the
 * positive check that a scoped read sees only its own rows.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const payload = (tag: string): DiscoveryUniverseSnapshotPayload => ({
  universe: [{ symbol: 'AAAUSDT', priceChangePercent: '10', quoteVolume: '1000000' }],
  shortlist: ['AAAUSDT'],
  add: [tag === 'add' ? 'AAAUSDT' : ''].filter(Boolean),
  remove: [],
  desired: ['AAAUSDT'],
  configDigest: {
    quoteAsset: 'USDT',
    maxAutoSymbols: 5,
    changeMinPercent: '0',
    rankTopPercent: 30,
    rankExcludeTopPercent: 5,
    marketBreadthMinPercent: '0',
  },
  funnel: {
    universe: 1,
    quote: 1,
    assetPolicy: 1,
    blacklist: 1,
    liquidity: 1,
    activity: 1,
    spread: 1,
    changeBand: 1,
    age: 1,
    trend: 1,
    eligible: 1,
    added: tag === 'add' ? 1 : 0,
    kept: 0,
    removed: 0,
    breadthOk: true,
  },
});

describeIfDb('discovery-universe-snapshots account-scoped reads, writes, and prune', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('record round-trips the payload on the owner profile', async () => {
    const row = await ap.discoveryUniverseSnapshots.record(payload('add'));
    expect(row.profileId).toBe(fx.alice.profileId);
    expect(row.snapshot).toEqual(payload('add'));
    expect(row.capturedAt).toBeInstanceOf(Date);
  });

  it('listForProfile returns newest-first and honours the limit, scoped to the owner', async () => {
    // Two snapshots with explicit, increasing capture times so DESC is
    // observable. Far-future timestamps so these are unambiguously the two
    // newest rows even though the shared fixture already holds the `record`
    // test's now()-stamped row (which would otherwise out-sort these).
    await fx.db.insert(discoveryUniverseSnapshots).values({
      profileId: fx.alice.profileId,
      snapshot: { ...payload('a'), shortlist: ['OLD'] },
      capturedAt: new Date('2099-06-10T00:00:00Z'),
    });
    await fx.db.insert(discoveryUniverseSnapshots).values({
      profileId: fx.alice.profileId,
      snapshot: { ...payload('a'), shortlist: ['NEW'] },
      capturedAt: new Date('2099-06-10T00:01:00Z'),
    });
    const rows = await ap.discoveryUniverseSnapshots.listForProfile(2);
    expect(rows).toHaveLength(2);
    // All returned rows belong to Alice.
    expect(rows.every((r) => r.profileId === fx.alice.profileId)).toBe(true);
    // Newest first: the row with capturedAt 00:01 (shortlist NEW) precedes 00:00.
    const newest = rows[0]?.snapshot as DiscoveryUniverseSnapshotPayload;
    expect(newest.shortlist).toEqual(['NEW']);
  });

  it("a scoped read never sees another profile's snapshots", async () => {
    await bp.discoveryUniverseSnapshots.record({ ...payload('add'), shortlist: ['BOBONLY'] });
    const alicesRows = await ap.discoveryUniverseSnapshots.listForProfile(100);
    expect(
      alicesRows.every(
        (r) => (r.snapshot as DiscoveryUniverseSnapshotPayload).shortlist[0] !== 'BOBONLY',
      ),
    ).toBe(true);
    expect(alicesRows.every((r) => r.profileId === fx.alice.profileId)).toBe(true);
  });

  it('pruneOlderThan deletes only aged rows across all profiles', async () => {
    // One ancient row (well past any horizon) and one fresh row for Bob.
    await fx.db.insert(discoveryUniverseSnapshots).values({
      profileId: fx.bob.profileId,
      snapshot: { ...payload('a'), shortlist: ['ANCIENT'] },
      capturedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const freshBefore = await bp.discoveryUniverseSnapshots.record({
      ...payload('a'),
      shortlist: ['FRESH'],
    });

    const deleted = await repo.discoveryUniverseSnapshots.pruneOlderThan(
      fx.db,
      new Date('2021-01-01T00:00:00Z'),
    );
    expect(deleted).toBeGreaterThanOrEqual(1);

    // The fresh row survives; the ancient one is gone.
    const survivors = await fx.db
      .select()
      .from(discoveryUniverseSnapshots)
      .where(eq(discoveryUniverseSnapshots.id, freshBefore.id));
    expect(survivors).toHaveLength(1);
    const bobsRows = await bp.discoveryUniverseSnapshots.listForProfile(100);
    expect(
      bobsRows.every(
        (r) => (r.snapshot as DiscoveryUniverseSnapshotPayload).shortlist[0] !== 'ANCIENT',
      ),
    ).toBe(true);
  });
});
