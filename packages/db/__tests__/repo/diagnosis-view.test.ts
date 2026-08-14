// The discovery-funnel projection: the jsonb → diagnosis-input mapper, and the
// scoped read that feeds the always-visible funnel panel.
//
// The mapper is pure and runs everywhere; the read needs a real database and is
// skipped without `DATABASE_TEST_URL`, matching the other repo suites.

import { inArray } from 'drizzle-orm';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { scopeProfile, type ProfileScope } from '../../src/repo/index.js';
import {
  getDiscoveryFunnelView,
  toDiagnosisSnapshots,
} from '../../src/repo/projections/diagnosis-view.js';
import { discoveryUniverseSnapshots } from '../../src/schema/discovery-universe-snapshots.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const T0 = new Date('2026-08-01T00:00:00.000Z');
const NOW_MS = T0.getTime() + 60_000;

const funnel = {
  universe: 100,
  quote: 80,
  blacklist: 78,
  liquidity: 40,
  activity: 30,
  spread: 25,
  changeBand: 12,
  probed: 12,
  age: 12,
  trend: 6,
  eligible: 3,
  added: 1,
  kept: 2,
  removed: 0,
  breadthOk: true,
};

describe('toDiagnosisSnapshots', () => {
  it('lifts the stored funnel and its breadth flag onto the snapshot', () => {
    const [snap] = toDiagnosisSnapshots([{ capturedAt: T0, snapshot: { funnel } }]);

    expect(snap?.capturedAtMs).toBe(T0.getTime());
    expect(snap?.breadthOk).toBe(true);
    expect(snap?.funnel?.eligible).toBe(3);
  });

  it('leaves the funnel absent, not zeroed, for a scan that recorded no counts', () => {
    // Zeroing here would render as "nothing survived every filter" when the
    // truth is "this scan predates the counts", which is the opposite verdict.
    const [snap] = toDiagnosisSnapshots([{ capturedAt: T0, snapshot: { shortlist: [] } }]);

    expect(snap?.funnel).toBeUndefined();
    expect(snap?.breadthOk).toBeUndefined();
    expect('funnel' in (snap ?? {})).toBe(false);
  });

  it('survives a snapshot column that is not an object', () => {
    // `snapshot` is jsonb, so a null column or a scalar row reaches the mapper
    // as something without properties. The report must not die reading it.
    const mapped = toDiagnosisSnapshots([
      { capturedAt: T0, snapshot: null },
      { capturedAt: T0, snapshot: 7 },
    ]);

    expect(mapped).toHaveLength(2);
    expect(mapped.every((s) => s.funnel === undefined)).toBe(true);
  });
});

describeIfDb('getDiscoveryFunnelView', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;
  let bobScope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    scope = await scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    await fx.db
      .delete(discoveryUniverseSnapshots)
      .where(inArray(discoveryUniverseSnapshots.profileId, [fx.alice.profileId, fx.bob.profileId]));
  });

  const record = async (profileId: string, capturedAt: Date, snapshot: unknown) =>
    fx.db.insert(discoveryUniverseSnapshots).values({ profileId, capturedAt, snapshot });

  it('reads the ladder from the newest scan that carries counts', async () => {
    await record(fx.alice.profileId, T0, { funnel });
    // Newer but countless: skipping it is what keeps a recent pre-funnel scan
    // from blanking a panel the older scan can still fill.
    await record(fx.alice.profileId, new Date(T0.getTime() + 30_000), { shortlist: [] });

    const view = await getDiscoveryFunnelView(scope, 10, NOW_MS);

    expect(view?.source).toBe('stored');
    expect(view?.latestAtMs).toBe(T0.getTime());
    expect(view?.ticker.at(0)).toEqual({ stage: 'universe', survivors: 100 });
    // Each ladder leads with its own denominator; the candidate one is `probed`.
    expect(view?.candidate.at(0)).toEqual({ stage: 'probed', survivors: 12 });
    expect(view?.candidate.at(-1)).toEqual({ stage: 'eligible', survivors: 3 });
    // Oldest first: the strip is read left to right as time.
    expect(view?.history.map((h) => h.atMs)).toEqual([T0.getTime(), T0.getTime() + 30_000]);
  });

  it('is null when no scan carries counts', async () => {
    await record(fx.alice.profileId, T0, { shortlist: [] });

    expect(await getDiscoveryFunnelView(scope, 10, NOW_MS)).toBeNull();
  });

  it('does not read another profile scans', async () => {
    await record(fx.bob.profileId, T0, { funnel });

    expect(await getDiscoveryFunnelView(scope, 10, NOW_MS)).toBeNull();
    expect(await getDiscoveryFunnelView(bobScope, 10, NOW_MS)).not.toBeNull();
  });

  it('honours the limit so the strip cannot grow without bound', async () => {
    for (const n of [1, 2, 3]) {
      await record(fx.alice.profileId, new Date(T0.getTime() + n * 60_000), { funnel });
    }

    const view = await getDiscoveryFunnelView(scope, 2, NOW_MS);
    expect(view?.history).toHaveLength(2);
  });
});
