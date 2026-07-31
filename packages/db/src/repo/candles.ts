// AST-CHECK-EXEMPT: candles is GLOBAL market data (no user_id / profile_id
// column). Functions in this module take `db` only; the `userId` rule does
// not apply. The exemption is enforced by name match in
// __tests__/repo/ast-check.test.ts (GLOBAL_REPO_MODULES).

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { candles, type CandleInsert, type CandleRow } from '../schema/candles.js';
import { computeMissingRanges, intervalToMs, type MsRange } from '../candle-intervals.js';
import type { Database } from './_db.js';

/**
 * Inserts closed candles, ignoring any whose (symbol, interval, open_time)
 * already exists. This is insert-or-ignore, not update-on-conflict: a row
 * already present is kept untouched. Closed candles are immutable, so that
 * makes a re-run over an overlapping range a no-op — the property the
 * gap-aware backfill relies on for idempotency.
 */
export async function insertNew(db: Database, rows: readonly CandleInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(candles)
    .values([...rows])
    .onConflictDoNothing();
}

/**
 * Returns the candles for a (symbol, interval) whose open-time falls in
 * `[from, to]`, ascending by open-time — the order a backtest replays them.
 */
export async function getRange(
  db: Database,
  symbol: string,
  interval: string,
  from: Date,
  to: Date,
): Promise<CandleRow[]> {
  return db
    .select()
    .from(candles)
    .where(
      and(
        eq(candles.symbol, symbol),
        eq(candles.interval, interval),
        gte(candles.openTime, from),
        lte(candles.openTime, to),
      ),
    )
    .orderBy(asc(candles.openTime));
}

/**
 * The open-times already stored for a (symbol, interval) in `[from, to]`,
 * as epoch-ms. Used by {@link findGaps}; exposed for callers that want the
 * raw grid.
 */
export async function listOpenTimes(
  db: Database,
  symbol: string,
  interval: string,
  from: Date,
  to: Date,
): Promise<number[]> {
  const rows = await db
    .select({ openTime: candles.openTime })
    .from(candles)
    .where(
      and(
        eq(candles.symbol, symbol),
        eq(candles.interval, interval),
        gte(candles.openTime, from),
        lte(candles.openTime, to),
      ),
    )
    .orderBy(asc(candles.openTime));
  return rows.map((r) => r.openTime.getTime());
}

/**
 * The contiguous open-time sub-ranges (epoch-ms) whose candles are missing
 * for a (symbol, interval) over `[fromMs, toMs]`. A backfill fetches only
 * these, so re-running over an already-filled range issues zero requests.
 */
export async function findGaps(
  db: Database,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<MsRange[]> {
  const intervalMs = intervalToMs(interval);
  const present = await listOpenTimes(db, symbol, interval, new Date(fromMs), new Date(toMs));
  return computeMissingRanges(present, fromMs, toMs, intervalMs);
}
