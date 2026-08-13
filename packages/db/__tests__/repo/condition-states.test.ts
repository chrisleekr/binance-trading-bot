// `recordCondition` against a real database. Skipped without `DATABASE_TEST_URL`
// so workstations with no Postgres still see `bun run test` go green.
//
// A real database rather than a mock because the two properties that matter are
// both database behaviour, not call bookkeeping. "Unchanged writes nothing" is
// only meaningful if no row appears -- a spy on the repo would pass even while
// an upsert rewrote the row every tick. And retention-immunity is the whole
// reason this table exists: it is proven by deleting the log and finding the
// duration still exact, which needs both tables present.

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { conditionStates, scopeProfile, type ProfileScope } from '../../src/repo/index.js';
import { actionLogs as actionLogsTable } from '../../src/schema/action-logs.js';
import { conditionStates as conditionStatesTable } from '../../src/schema/condition-states.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const T0 = new Date('2026-08-01T00:00:00.000Z');
const T1 = new Date('2026-08-02T00:00:00.000Z');
const T2 = new Date('2026-08-03T00:00:00.000Z');

describeIfDb('condition-states repo', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    scope = await scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    await fx.db
      .delete(conditionStatesTable)
      .where(inArray(conditionStatesTable.profileId, [fx.alice.profileId, fx.bob.profileId]));
    await fx.db
      .delete(actionLogsTable)
      .where(inArray(actionLogsTable.profileId, [fx.alice.profileId, fx.bob.profileId]));
  });

  const logs = async () =>
    fx.db.select().from(actionLogsTable).where(eq(actionLogsTable.profileId, fx.alice.profileId));

  const states = async () =>
    fx.db
      .select()
      .from(conditionStatesTable)
      .where(eq(conditionStatesTable.profileId, fx.alice.profileId));

  it('opening a condition writes one state row and one log edge', async () => {
    const result = await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      detail: { dropPercent: 4.2 },
      now: T0,
    });

    expect(result).toEqual({ changed: true, previousCode: null, sinceMs: T0.getTime() });

    const rows = await states();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('knife-guard');
    expect(rows[0]?.since.getTime()).toBe(T0.getTime());
    expect(rows[0]?.detail).toEqual({ dropPercent: 4.2 });

    const edges = await logs();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.ctx).toMatchObject({
      source: 'condition',
      condition: 'entry-blocked',
      code: 'knife-guard',
      previousCode: null,
      sinceMs: T0.getTime(),
    });
  });

  it('an unchanged code writes NOTHING at all', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });

    // The per-tick hot path. Re-reporting the same reason must not touch either
    // table -- this is what keeps a reason held for 4,000 ticks at one row, and
    // what stops the ~86k rows/day this design exists to avoid.
    for (const now of [T1, T2]) {
      const again = await conditionStates.recordCondition(scope, {
        condition: 'entry-blocked',
        symbol: 'BTCUSDT',
        code: 'knife-guard',
        now,
      });
      expect(again).toEqual({ changed: false });
    }

    expect(await logs()).toHaveLength(1);
    const rows = await states();
    expect(rows).toHaveLength(1);
    // `since` must still be the ORIGINAL open, not the latest report -- an upsert
    // that refreshed it would silently reset every duration to ~one tick.
    expect(rows[0]?.since.getTime()).toBe(T0.getTime());
    expect(rows[0]?.updatedAt.getTime()).toBe(T0.getTime());
  });

  // The tick assembler dedups blockers on `changeKey ?? reason`, where the key
  // encodes the reason PLUS the threshold. Comparing codes only here made the
  // two layers disagree: the assembler called the writer on a moved threshold,
  // the writer dropped it as a no-op, and `detail` then held the level the
  // position first waited at for the whole span while the diagnosis rendered it
  // as the live gate.
  describe('changeKey identity', () => {
    const armedAt = (armPrice: string, now: Date) =>
      conditionStates.recordCondition(scope, {
        condition: 'exit-blocked',
        symbol: 'BTCUSDT',
        code: 'awaiting-sell-arm',
        changeKey: `awaiting-sell-arm|armPrice=${armPrice}`,
        detail: { armPrice },
        now,
      });

    it('a moved changeKey under the same code rewrites detail without restarting the span', async () => {
      await armedAt('105', T0);
      const result = await armedAt('110', T1);

      expect(result).toEqual({
        changed: true,
        previousCode: 'awaiting-sell-arm',
        sinceMs: T0.getTime(),
      });

      const rows = await states();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code).toBe('awaiting-sell-arm');
      expect(rows[0]?.detail).toEqual({ armPrice: '110' });
      expect(rows[0]?.changeKey).toBe('awaiting-sell-arm|armPrice=110');
      // Same blocker, moved level. Restarting `since` would report a position
      // blocked for nine days as blocked for a tick on every re-average.
      expect(rows[0]?.since.getTime()).toBe(T0.getTime());
      expect(rows[0]?.updatedAt.getTime()).toBe(T1.getTime());

      // C5 wants the edge: the operator is watching the level, so the move is
      // exactly the thing worth one row.
      const edges = await logs();
      expect(edges).toHaveLength(2);
      expect(
        edges.filter(
          (e) => (e.ctx as { detail?: { armPrice?: string } } | null)?.detail?.armPrice === '110',
        ),
      ).toHaveLength(1);
    });

    it('an unchanged changeKey writes nothing, even as detail moves under it', async () => {
      await armedAt('105', T0);
      const again = await conditionStates.recordCondition(scope, {
        condition: 'exit-blocked',
        symbol: 'BTCUSDT',
        code: 'awaiting-sell-arm',
        changeKey: 'awaiting-sell-arm|armPrice=105',
        // The live price ticks every second. Keying on the whole detail would
        // put this back to a row per tick.
        detail: { armPrice: '105', currentPrice: '99.4' },
        now: T1,
      });

      expect(again).toEqual({ changed: false });
      expect(await logs()).toHaveLength(1);
      const rows = await states();
      expect(rows[0]?.detail).toEqual({ armPrice: '105' });
      expect(rows[0]?.since.getTime()).toBe(T0.getTime());
    });

    it('a changed code still restarts the span, whatever the key does', async () => {
      await armedAt('105', T0);
      const result = await conditionStates.recordCondition(scope, {
        condition: 'exit-blocked',
        symbol: 'BTCUSDT',
        code: 'no-exit-configured',
        changeKey: 'awaiting-sell-arm|armPrice=105',
        now: T1,
      });

      expect(result).toEqual({
        changed: true,
        previousCode: 'awaiting-sell-arm',
        sinceMs: T1.getTime(),
      });
      const rows = await states();
      expect(rows[0]?.since.getTime()).toBe(T1.getTime());
    });

    it('a caller that never sends a key is unaffected by one stored earlier', async () => {
      await armedAt('105', T0);
      // Dropping the key without changing the code leaves the identity at the
      // code, which the stored key no longer matches: one write, no more.
      const first = await conditionStates.recordCondition(scope, {
        condition: 'exit-blocked',
        symbol: 'BTCUSDT',
        code: 'awaiting-sell-arm',
        now: T1,
      });
      expect(first).toEqual({
        changed: true,
        previousCode: 'awaiting-sell-arm',
        sinceMs: T0.getTime(),
      });

      const again = await conditionStates.recordCondition(scope, {
        condition: 'exit-blocked',
        symbol: 'BTCUSDT',
        code: 'awaiting-sell-arm',
        now: T2,
      });
      expect(again).toEqual({ changed: false });
      expect(await logs()).toHaveLength(2);
      expect((await states())[0]?.changeKey).toBeNull();
    });
  });

  it('a changed code restarts the span and records the previous one', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });
    const result = await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'awaiting-trigger-price',
      now: T1,
    });

    expect(result).toEqual({ changed: true, previousCode: 'knife-guard', sinceMs: T1.getTime() });

    const rows = await states();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('awaiting-trigger-price');
    expect(rows[0]?.since.getTime()).toBe(T1.getTime());

    const edges = await logs();
    expect(edges).toHaveLength(2);
  });

  it('clearing deletes the state row and logs the resolution', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });
    const result = await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: null,
      now: T1,
    });

    // The resolution edge reports when the span STARTED, not when it ended --
    // that is what lets a reader say "blocked for a day" from the edge alone.
    expect(result).toEqual({ changed: true, previousCode: 'knife-guard', sinceMs: T0.getTime() });
    expect(await states()).toHaveLength(0);

    const edges = await logs();
    expect(edges).toHaveLength(2);
    expect(edges.some((e) => (e.ctx as { code?: unknown } | null)?.code === null)).toBe(true);
  });

  it('clearing a condition that was never open writes nothing', async () => {
    const result = await conditionStates.recordCondition(scope, {
      condition: 'discovery-stale',
      code: null,
      now: T0,
    });
    expect(result).toEqual({ changed: false });
    expect(await logs()).toHaveLength(0);
    expect(await states()).toHaveLength(0);
  });

  it('profile-level and per-symbol conditions are separate subjects', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'discovery-stale',
      code: 'no-recent-scan',
      now: T0,
    });
    await conditionStates.recordCondition(scope, {
      condition: 'discovery-stale',
      symbol: 'BTCUSDT',
      code: 'no-recent-scan',
      now: T0,
    });

    expect(await states()).toHaveLength(2);
    // The profile-level row carries a NULL symbol into the log even though the
    // state row uses '' -- readers filtering `symbol is null` must still find it.
    const edges = await logs();
    expect(edges.filter((e) => e.symbol === null)).toHaveLength(1);
    expect(edges.filter((e) => e.symbol === 'BTCUSDT')).toHaveLength(1);
  });

  it('listOpen returns only this profile rows', async () => {
    const bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });
    await conditionStates.recordCondition(bobScope, {
      condition: 'entry-blocked',
      symbol: 'ETHUSDT',
      code: 'cap-reached',
      now: T0,
    });

    const mine = await conditionStates.listOpen(scope);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.symbol).toBe('BTCUSDT');
  });

  it('duration survives a full action_logs sweep -- the regression this table exists for', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });

    // Simulate the prune cron at any horizon: every edge is gone.
    await fx.db.delete(actionLogsTable).where(eq(actionLogsTable.profileId, fx.alice.profileId));
    expect(await logs()).toHaveLength(0);

    // The state, and therefore the exact duration, is untouched. If this ever
    // needs a surviving log row to pass, state is being read from the wrong store.
    const open = await conditionStates.findOne(scope, 'entry-blocked', 'BTCUSDT');
    expect(open?.code).toBe('knife-guard');
    expect(open?.since.getTime()).toBe(T0.getTime());
  });

  it('the primary key keeps one row per condition and subject', async () => {
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'knife-guard',
      now: T0,
    });
    await conditionStates.recordCondition(scope, {
      condition: 'entry-blocked',
      symbol: 'BTCUSDT',
      code: 'cap-reached',
      now: T1,
    });

    const rows = await fx.db
      .select()
      .from(conditionStatesTable)
      .where(
        and(
          eq(conditionStatesTable.profileId, fx.alice.profileId),
          eq(conditionStatesTable.condition, 'entry-blocked'),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
