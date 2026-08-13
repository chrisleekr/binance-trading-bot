// Global age sweep over `action_logs`, against a real database.
//
// `action_logs` is a TimescaleDB hypertable chunked at one hour, so a horizon
// measured in days always leaves the bulk of the expired rows in chunks that are
// wholly past it, plus exactly one boundary chunk straddling the cutoff. A sweep
// that walks rows instead of dropping those whole chunks is what put the cron in
// the DLQ with "job stalled more than allowable limit", and a sweep that drops
// only chunks would silently keep the expired half of the boundary chunk. Both
// halves are pinned here.
//
// Every timestamp below sits in 2019 and the cutoff with it. The sweep is global
// and cross-tenant by design, so a 2026-dated fixture would delete rows other
// suites seeded on this shared database; nothing else writes 2019 rows, so the
// chunks this suite touches are its own.

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionLogs } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const HOUR_MS = 3_600_000;
// Deliberately NOT on a chunk boundary: the 12:00–13:00 chunk then holds both
// expired and live rows, which is the case whole-chunk dropping cannot serve.
const CUTOFF = new Date('2019-03-05T12:30:00.000Z');

describeIfDb('action-logs age sweep across hypertable chunks', () => {
  let fx: IsolationFixture;

  const seed = async (rows: readonly { at: Date; msg: string }[]): Promise<void> => {
    await actionLogs.insertMany(
      fx.db,
      rows.map((r) => ({
        time: r.at,
        profileId: fx.alice.profileId,
        symbol: 'ETHBTC',
        level: 'info',
        msg: r.msg,
        ctx: { source: 'tick' },
      })),
    );
  };

  /** Chunks whose whole time range is already past the cutoff. */
  const expiredChunks = async (): Promise<number> => {
    const res = await fx.db.execute<{ count: string }>(
      sql`select count(*)::text as count
          from show_chunks('action_logs', older_than => ${CUTOFF.toISOString()}::timestamptz)`,
    );
    return Number(res.rows[0]?.count ?? '-1');
  };

  const survivors = async (): Promise<string[]> => {
    const res = await fx.db.execute<{ msg: string }>(
      sql`select msg from action_logs where profile_id = ${fx.alice.profileId}
          order by time asc`,
    );
    return res.rows.map((r) => r.msg);
  };

  beforeAll(async () => {
    fx = await setupFixture();
  });

  // Re-seeded per test: each case runs the sweep, so sharing one seed would let
  // the first case's delete satisfy the second without the sweep doing anything.
  beforeEach(async () => {
    await fx.db.execute(sql`delete from action_logs where profile_id = ${fx.alice.profileId}`);
    await seed([
      { at: new Date(CUTOFF.getTime() - 5 * HOUR_MS), msg: 'expired 07:30' },
      { at: new Date(CUTOFF.getTime() - 4 * HOUR_MS), msg: 'expired 08:30' },
      { at: new Date(CUTOFF.getTime() - 3 * HOUR_MS), msg: 'expired 09:30' },
      // Same chunk as the two survivors below, so this row can only go by a
      // row-level delete.
      { at: new Date(CUTOFF.getTime() - 20 * 60_000), msg: 'expired 12:10' },
      { at: new Date(CUTOFF.getTime() + 15 * 60_000), msg: 'live 12:45' },
      { at: new Date(CUTOFF.getTime() + 2 * HOUR_MS), msg: 'live 14:30' },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('leaves no chunk sitting wholly past the horizon', async () => {
    // Anchors the assertion below: without these the post-sweep count of 0 would
    // pass on an empty table.
    expect(await expiredChunks()).toBeGreaterThanOrEqual(3);

    await actionLogs.pruneOlderThan(fx.db, CUTOFF);

    // A row-by-row DELETE empties those chunks but leaves them attached — the
    // sweep then re-scans them on every run, which is what made it stall.
    expect(await expiredChunks()).toBe(0);
  });

  it('retains no row older than the cutoff, including the boundary chunk', async () => {
    await actionLogs.pruneOlderThan(fx.db, CUTOFF);
    expect(await survivors()).toEqual(['live 12:45', 'live 14:30']);
  });

  it('reports chunks and rows apart, so the cheap half of the sweep is still visible', async () => {
    const swept = await actionLogs.pruneOlderThan(fx.db, CUTOFF);

    // Three expired rows in three hourly chunks left whole; only the one sharing
    // the boundary chunk with live rows can be counted row by row. Reporting the
    // sum would call this a one-row night.
    expect(swept.chunksDropped).toBeGreaterThanOrEqual(3);
    expect(swept.rowsDeleted).toBe(1);
  });

  it('keeps batching until a batch comes back short', async () => {
    // The case above exits the loop on its first pass, so with production's
    // 5,000-row batch nothing ever proved the loop goes round again, that the
    // (time, id) seek does not revisit a row it already deleted, or that a final
    // batch of exactly the batch size still terminates. An off-by-one in that
    // exit is an infinite loop inside the cron whose production failure mode was
    // a stall, so the batch size is injectable purely to reach it with six rows
    // instead of 5,001.
    //
    // All five sit inside the 12:00-13:00 chunk that straddles the cutoff, so
    // drop_chunks cannot take them and every one must go through the loop.
    await seed(
      Array.from({ length: 5 }, (_, i) => ({
        at: new Date(CUTOFF.getTime() - (i + 1) * 60_000),
        msg: `boundary ${i}`,
      })),
    );

    const swept = await actionLogs.pruneOlderThan(fx.db, CUTOFF, 3);

    // Six expired rows in the boundary chunk at three per batch: two full passes
    // that each ask for more, then an empty one that ends it. Reaching six is
    // only possible by going round, and exceeding it is impossible unless the
    // seek re-reads rows the previous batch deleted.
    expect(swept.rowsDeleted).toBe(6);
    expect(await survivors()).toEqual(['live 12:45', 'live 14:30']);
  });
});

// A source-level check rather than a behavioural one: `RETURNING` is invisible
// from the outside except as memory pressure, and the failure mode is a sweep of
// a few million expired rows materialising a few million result rows on the way
// to a count nobody reads per-row.
describe('action-logs prune statements do not materialise deleted rows', () => {
  const SOURCE = readFileSync(new URL('../../src/repo/action-logs.ts', import.meta.url), 'utf8');

  const bodyOf = (name: string): string => {
    const start = SOURCE.indexOf(`export async function ${name}`);
    if (start === -1) throw new Error(`${name} is not an exported function of action-logs.ts`);
    const rest = SOURCE.slice(start + 1);
    const end = rest.indexOf('\nexport ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  // The anchor is per function because the two delete in different dialects: the
  // age sweep needs a raw statement to key its batches on `(time, id)`, the row
  // cap stays in the query builder.
  it.each([
    ['pruneOlderThan', 'delete from action_logs'],
    ['pruneBeyondRowCap', 'delete(actionLogs)'],
  ])('%s issues no RETURNING clause', (name, anchor) => {
    const body = bodyOf(name);
    // Anchor: proves the slice actually caught the delete, so the assertion
    // below cannot pass on an empty or misaligned extract.
    expect(body).toContain(anchor);
    expect(body).not.toContain('.returning(');
  });
});
