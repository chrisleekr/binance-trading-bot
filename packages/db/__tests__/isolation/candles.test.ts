import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from '../../src/migrate.js';
import * as schema from '../../src/schema/index.js';
import { candles as candlesRepo } from '../../src/repo/index.js';
import type { CandleInsert } from '../../src/schema/candles.js';

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// `candles` is global market data (no profile_id), so unlike the account-
// scoped suites this test does not seed users. It mints a random symbol so
// parallel runs against the shared test DB never collide on the
// (symbol, interval, open_time) primary key, and deletes only its own rows.
describeIfDb('candles global candle store', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const SYMBOL = `TEST${randomUUID().slice(0, 8).toUpperCase()}USDT`;
  const INTERVAL = '1m';
  const MIN = 60_000;

  // open-time base aligned to the minute grid
  const base = 1_700_000_000_000 - (1_700_000_000_000 % MIN);

  const row = (openMs: number, close: string): CandleInsert => ({
    symbol: SYMBOL,
    interval: INTERVAL,
    openTime: new Date(openMs),
    open: '100',
    high: '110',
    low: '90',
    close,
    volume: '1.5',
    closeTime: new Date(openMs + MIN - 1),
  });

  beforeAll(async () => {
    if (!TEST_DB_URL) throw new Error('DATABASE_TEST_URL is required for isolation tests');
    await migrate({ connectionString: TEST_DB_URL, log: () => undefined });
    pool = new Pool({ connectionString: TEST_DB_URL });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    try {
      await db.delete(schema.candles).where(eq(schema.candles.symbol, SYMBOL));
    } finally {
      await pool.end();
    }
  });

  it('insertNew then getRange returns rows ascending, decimals as strings', async () => {
    await candlesRepo.insertNew(db, [
      row(base + 2 * MIN, '102'),
      row(base, '100'),
      row(base + MIN, '101'),
    ]);
    const rows = await candlesRepo.getRange(
      db,
      SYMBOL,
      INTERVAL,
      new Date(base),
      new Date(base + 2 * MIN),
    );
    expect(rows.map((r) => r.openTime.getTime())).toEqual([base, base + MIN, base + 2 * MIN]);
    expect(rows[0]?.close).toBe('100.000000000000000000');
    expect(typeof rows[0]?.open).toBe('string');
  });

  it('insertNew is idempotent on overlapping closed candles', async () => {
    // re-insert the same open_time with a different close; do-nothing keeps original
    await candlesRepo.insertNew(db, [row(base, '999')]);
    const [first] = await candlesRepo.getRange(
      db,
      SYMBOL,
      INTERVAL,
      new Date(base),
      new Date(base),
    );
    expect(first?.close).toBe('100.000000000000000000');
  });

  it('insertNew([]) is a no-op', async () => {
    await expect(candlesRepo.insertNew(db, [])).resolves.toBeUndefined();
  });

  it('findGaps reports the missing open-time runs', async () => {
    // present: base, base+MIN, base+2*MIN. Ask for base..base+5*MIN.
    const gaps = await candlesRepo.findGaps(db, SYMBOL, INTERVAL, base, base + 5 * MIN);
    expect(gaps).toEqual([{ fromMs: base + 3 * MIN, toMs: base + 5 * MIN }]);
  });

  it('findGaps returns [] when the range is fully populated', async () => {
    const gaps = await candlesRepo.findGaps(db, SYMBOL, INTERVAL, base, base + 2 * MIN);
    expect(gaps).toEqual([]);
  });

  it('listOpenTimes returns stored open-times for the window', async () => {
    const times = await candlesRepo.listOpenTimes(
      db,
      SYMBOL,
      INTERVAL,
      new Date(base),
      new Date(base + MIN),
    );
    expect(times).toEqual([base, base + MIN]);
  });

  it('getRange isolates by symbol', async () => {
    const rows = await candlesRepo.getRange(
      db,
      `${SYMBOL}X`,
      INTERVAL,
      new Date(base),
      new Date(base + 5 * MIN),
    );
    expect(rows).toEqual([]);
  });
});
