import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { equitySnapshots } from '../../src/schema/equity-snapshots.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * `listForProfileInRange` must return every tier, `unknown` included.
 *
 * 0090 added `equity_snapshots.fees_quote_complete` as `not null default false` with no backfill and no writer ever set it, so 0093's `case when fees_quote_complete then 'exact' else 'unknown' end` stamps EVERY row that predates this release `unknown`. A tier filter on this read therefore does not withhold a handful of doubtful points, it withholds the entire curve — and permanently, because the tier a snapshot carries is folded over the profile's whole archive at capture and is never re-stamped afterwards, so no later evidence lifts it.
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

  it('caps a long window to the requested point budget by thinning it, not by truncating it', async () => {
    // The live profile already holds thousands of points over a couple of months and grows by ~96 a day, so "All time" has to come back bounded. Truncating to the newest N would draw a curve that silently starts in the middle of the window; the read buckets the span instead and keeps one real row per bucket.
    const capFrom = new Date('2033-01-01T00:00:00Z');
    const capTo = new Date('2033-01-02T00:00:00Z');
    const values = Array.from({ length: 25 }, (_, i) =>
      snapshotRow(
        fx.alice.profileId,
        new Date(capFrom.getTime() + i * 60 * 60 * 1000).toISOString(),
        'exact',
      ),
    );
    const inserted = await fx.db.insert(equitySnapshots).values(values).returning();
    const insertedIds = new Set(inserted.map((r) => r.id));

    const capped = await ap.equitySnapshots.listForProfileInRange('USDT', capFrom, capTo, 10);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThanOrEqual(10);
    // Real rows, not synthesised averages: every point on the curve is a snapshot that was actually captured.
    for (const row of capped) expect(insertedIds.has(row.id)).toBe(true);
    // Ascending, and spanning the window rather than clustering at one end.
    const times = capped.map((r) => r.capturedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // The newest snapshot in each bucket, so the last point is the state the window actually ended in — the one figure a cumulative curve must not approximate. The first point sits inside the first bucket rather than exactly on `capFrom` for the same reason.
    expect(times.at(-1)).toBe(capTo.getTime());
    expect(times[0]).toBeLessThan(capFrom.getTime() + 4 * 60 * 60 * 1000);
    // Thinned across the window, not the newest N: the oldest kept point is far from the newest.
    expect(times[0]).toBeLessThan(capFrom.getTime() + 12 * 60 * 60 * 1000);

    // Under the budget, the read is the plain one and nothing is dropped.
    const whole = await ap.equitySnapshots.listForProfileInRange('USDT', capFrom, capTo, 100);
    expect(whole).toHaveLength(25);
  });

  it('derives the bucket width from a rounded-UP span, so a fractional second cannot clip the curve', async () => {
    // `::int` on a numeric ROUNDS, so a 2.2-second span reported 2 and the width came out one second instead of two. The bound the width exists to hold is `width >= span / (limit - 1)`; under-report the span and it does not hold, the reduction returns MORE buckets than the budget, and the trim then drops the oldest — which is the clipped-start failure the whole downsample exists to prevent, arriving through the arithmetic instead of through a LIMIT.
    // Four points across four whole seconds but only three two-second buckets, with the earliest alone in its bucket under either width, so the assertion is about which points survive and not about how they were grouped.
    const base = new Date('2036-01-01T00:00:00Z').getTime();
    const at = (ms: number): string => new Date(base + ms).toISOString();
    const oldest = at(1_900);
    await fx.db
      .insert(equitySnapshots)
      .values([
        snapshotRow(fx.alice.profileId, oldest, 'exact'),
        snapshotRow(fx.alice.profileId, at(2_100), 'exact'),
        snapshotRow(fx.alice.profileId, at(3_100), 'exact'),
        snapshotRow(fx.alice.profileId, at(4_100), 'exact'),
      ]);

    const capped = await ap.equitySnapshots.listForProfileInRange(
      'USDT',
      new Date(base),
      new Date(base + 10_000),
      3,
    );
    expect(capped.length).toBeLessThanOrEqual(3);
    // The window's first snapshot is still the series' first point. Under the rounded-DOWN span this read returned four buckets against a budget of three and this row was the one trimmed away.
    expect(capped[0]?.capturedAt.toISOString()).toBe(oldest);
  });

  it('honours a budget of one, where the bucket arithmetic alone overshoots', async () => {
    // `limit = 1` collapses the `limit - 1` divisor to 1, so the bucket becomes the whole span — and `time_bucket` aligns to the EPOCH, not to the first row, so the two endpoints can fall either side of a boundary and come back as two rows against a cap of one. Every other limit is bounded by the arithmetic; this one is the arithmetic's blind spot, and it is a real request: a caller asking for a single representative point.
    const oneFrom = new Date('2034-01-01T00:00:00Z');
    const oneTo = new Date('2034-01-03T00:00:00Z');
    await fx.db
      .insert(equitySnapshots)
      .values([
        snapshotRow(fx.alice.profileId, '2034-01-01T00:00:00Z', 'exact'),
        snapshotRow(fx.alice.profileId, '2034-01-02T00:00:00Z', 'exact'),
        snapshotRow(fx.alice.profileId, '2034-01-03T00:00:00Z', 'exact'),
      ]);

    const one = await ap.equitySnapshots.listForProfileInRange('USDT', oneFrom, oneTo, 1);
    expect(one).toHaveLength(1);
    // And it is the window's LAST point. The rows arrive oldest bucket first, so trimming off the tail would hand back the older of the two and drop the newest bucket — the one value a single-point read of a cumulative curve can mean, and the one the reduction's own contract says it keeps.
    expect(one[0]?.capturedAt.getTime()).toBe(oneTo.getTime());
    // Two is the budget that already worked, asserted beside it so a fix that clamped every read to a single row would not pass.
    const two = await ap.equitySnapshots.listForProfileInRange('USDT', oneFrom, oneTo, 2);
    expect(two).toHaveLength(2);
  });
});
