// Keyset paging over `action_logs`, against a real database.
//
// The interesting case is not "does a page come back" but the boundary the
// drainer creates on every pass: it bulk-inserts a whole batch, so many rows
// share a `time` down to the microsecond. A cursor made of `time` alone leaves
// the rest of a same-timestamp group unreachable, and a cursor round-tripped
// through a JS `Date` loses the sub-millisecond digits that separate them. Both
// failures look identical from the outside — rows silently missing from a page —
// so they are pinned here rather than left to the reader's shape.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionLogs, scopeProfile } from '../../src/repo/index.js';
import type { ActionLogCursor } from '../../src/repo/action-logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('action-logs keyset paging', () => {
  let fx: IsolationFixture;
  let scope: Awaited<ReturnType<typeof scopeProfile>>;

  const BASE = new Date('2026-08-01T00:00:00.000Z');

  beforeAll(async () => {
    fx = await setupFixture();
    scope = await scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);

    // Ten rows sharing ONE timestamp, mimicking a single drain batch, plus two
    // rows a second apart so the ordering across timestamps is covered too.
    await actionLogs.insertMany(
      fx.db,
      Array.from({ length: 10 }, (_, i) => ({
        time: BASE,
        profileId: fx.alice.profileId,
        symbol: i % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT',
        level: i === 0 ? 'error' : 'info',
        msg: `batch row ${i}`,
        ctx: { source: 'tick', i },
      })),
    );
    await actionLogs.insertMany(fx.db, [
      {
        time: new Date(BASE.getTime() + 1_000),
        profileId: fx.alice.profileId,
        symbol: 'BTCUSDT',
        level: 'warn',
        msg: 'later row',
        ctx: { source: 'entry-blocker' },
      },
      {
        time: new Date(BASE.getTime() - 1_000),
        profileId: fx.alice.profileId,
        symbol: 'BTCUSDT',
        level: 'debug',
        msg: 'earlier row',
        ctx: { source: 'tick' },
      },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const walkAll = async (limit: number): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: ActionLogCursor | null = null;
    for (;;) {
      const rows = await actionLogs.listPage(scope, limit, cursor);
      seen.push(...rows.map((r) => r.msg));
      const last = rows.at(-1);
      if (rows.length < limit || !last) break;
      cursor = { time: last.cursorToken, id: last.id };
    }
    return seen;
  };

  it('walks every row exactly once across pages that split a same-timestamp batch', async () => {
    const seen = await walkAll(3);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('returns the same set whatever the page size', async () => {
    // A page size that divides the batch evenly and one that does not: an
    // off-by-one in the cursor bound shows up in exactly one of them.
    expect((await walkAll(4)).sort()).toEqual((await walkAll(5)).sort());
  });

  it('orders newest-first across timestamps', async () => {
    const rows = await actionLogs.listPage(scope, 12, null);
    expect(rows[0]?.msg).toBe('later row');
    expect(rows.at(-1)?.msg).toBe('earlier row');
  });

  it('carries a microsecond-precision cursor token, not a millisecond one', async () => {
    const [row] = await actionLogs.listPage(scope, 1, null);
    expect(row?.cursorToken).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('pages through rows that differ only below the millisecond', async () => {
    // The rows above all sit on a whole millisecond, so they exercise the `id`
    // tie-breaker but not the token's precision. These two differ only in the
    // microsecond digits — a JS `Date` cannot even express the difference, so a
    // cursor round-tripped through one collapses them to the same instant and
    // the second row is skipped. Postgres has to write them.
    const at = (us: string) => sql.raw(`'2026-08-02T00:00:00.${us}Z'::timestamptz`);
    await scope.db.execute(sql`
      insert into action_logs (time, profile_id, symbol, level, msg, ctx) values
        (${at('000001')}, ${scope.profileId}, 'BTCUSDT', 'info', 'micro one', '{}'::jsonb),
        (${at('000002')}, ${scope.profileId}, 'BTCUSDT', 'info', 'micro two', '{}'::jsonb)
    `);

    const first = await actionLogs.listPage(scope, 1, null, {
      from: new Date('2026-08-02T00:00:00Z'),
    });
    expect(first[0]?.msg).toBe('micro two');
    expect(first[0]?.cursorToken).toBe('2026-08-02T00:00:00.000002Z');

    const second = await actionLogs.listPage(
      scope,
      1,
      { time: first[0]!.cursorToken, id: first[0]!.id },
      { from: new Date('2026-08-02T00:00:00Z') },
    );
    expect(second[0]?.msg).toBe('micro one');
  });

  it('filters by level, symbol, ctx source and message substring', async () => {
    expect(await actionLogs.listPage(scope, 50, null, { levels: ['error'] })).toHaveLength(1);
    expect(await actionLogs.listPage(scope, 50, null, { symbols: ['ETHUSDT'] })).toHaveLength(5);
    expect(await actionLogs.listPage(scope, 50, null, { source: 'entry-blocker' })).toHaveLength(1);
    expect(await actionLogs.listPage(scope, 50, null, { q: 'batch row' })).toHaveLength(10);
  });

  it('treats LIKE metacharacters in the search as literal text', async () => {
    // An operator pasting a Binance reason containing `%` must not match every
    // row; unescaped, `%` would.
    expect(await actionLogs.listPage(scope, 50, null, { q: '%' })).toHaveLength(0);
  });

  it('bounds by time window', async () => {
    const rows = await actionLogs.listPage(scope, 50, null, {
      from: BASE,
      to: new Date(BASE.getTime() + 500),
    });
    expect(rows).toHaveLength(10);
  });

  it('lists the distinct symbols present in the window', async () => {
    const symbols = await actionLogs.listLoggedSymbols(
      scope,
      new Date(BASE.getTime() - 10_000),
      new Date(BASE.getTime() + 10_000),
    );
    expect(symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('never returns another profile’s rows', async () => {
    const bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await actionLogs.insertMany(fx.db, [
      {
        time: BASE,
        profileId: fx.bob.profileId,
        symbol: 'BTCUSDT',
        level: 'error',
        msg: 'bob row',
        ctx: {},
      },
    ]);
    const mine = await actionLogs.listPage(scope, 50, null);
    expect(mine.some((r) => r.msg === 'bob row')).toBe(false);
    expect(await actionLogs.listPage(bobScope, 50, null)).toHaveLength(1);
  });
});
