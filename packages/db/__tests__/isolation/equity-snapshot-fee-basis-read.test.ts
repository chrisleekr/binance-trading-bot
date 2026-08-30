import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { equitySnapshots } from '../../src/schema/equity-snapshots.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * `listForProfileInRange` must return every tier, `unknown` included.
 *
 * 0090 added `equity_snapshots.fees_quote_complete` as `not null default false` with no backfill and no writer ever set it, so 0093's `case when fees_quote_complete then 'exact' else 'unknown' end` stamps EVERY row that predates this release `unknown`. A tier filter on this read therefore does not withhold a handful of doubtful points, it withholds the entire curve — and permanently, because the tier a snapshot carries is folded over the profile's whole append-only archive and can only ever weaken.
 *
 * A unit test cannot see this: the defect is a `where` clause, so only a real query against real rows distinguishes "returned it" from "silently dropped it".
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const RANGE_FROM = new Date('2031-01-01T00:00:00Z');
const RANGE_TO = new Date('2032-01-01T00:00:00Z');

const snapshotRow = (profileId: string, capturedAt: string, feeBasis: string) => ({
  profileId,
  capturedAt: new Date(capturedAt),
  quoteAsset: 'USDT',
  netPnlQuote: '1',
  realizedNetQuote: '1',
  feeBasis: feeBasis as 'exact' | 'estimated' | 'unknown',
  positionValueQuote: '0',
  positionCostQuote: '0',
  benchmarkAsset: 'BTC',
  benchmarkPriceQuote: '0',
});

describeIfDb('equity-snapshot fee-basis read', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('returns every tier, so a point whose fees are unaccounted for still reaches the caller', async () => {
    const rows = await fx.db
      .insert(equitySnapshots)
      .values([
        snapshotRow(fx.alice.profileId, '2031-03-01T00:00:00Z', 'unknown'),
        snapshotRow(fx.alice.profileId, '2031-03-02T00:00:00Z', 'estimated'),
        snapshotRow(fx.alice.profileId, '2031-03-03T00:00:00Z', 'exact'),
      ])
      .returning();

    const read = await ap.equitySnapshots.listForProfileInRange('USDT', RANGE_FROM, RANGE_TO, 100);
    const ids = read.map((r) => r.id);
    for (const row of rows) {
      expect(ids).toContain(row.id);
    }
    // Named individually rather than by count: the caller has to be able to TELL the tiers apart to mark the line, and a read that returned three rows with one tier collapsed would pass a count assertion.
    expect(read.map((r) => r.feeBasis)).toEqual(['unknown', 'estimated', 'exact']);
  });
});
