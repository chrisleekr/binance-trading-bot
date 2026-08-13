import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actionLogs } from '../../src/repo/index.js';
import { actionLogs as actionLogsTable } from '../../src/schema/action-logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('action-logs audit idempotency', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const row = (id: string, time: Date, msg: string) => ({
    id,
    time,
    profileId: fx.alice.profileId,
    symbol: 'BTCUSDT',
    level: 'info',
    msg,
    ctx: { source: 'tick', tickId: id },
  });

  it('ignores a replay with the same profile, time and producer id', async () => {
    const audit = row(
      '00000000-0000-4000-8000-000000000793',
      new Date('2026-08-11T00:00:00Z'),
      'replayed audit',
    );

    await expect(actionLogs.insertMany(fx.db, [audit])).resolves.toBe(1);
    await expect(actionLogs.insertMany(fx.db, [audit])).resolves.toBe(0);

    const stored = await fx.db
      .select()
      .from(actionLogsTable)
      .where(eq(actionLogsTable.id, audit.id));
    expect(stored).toHaveLength(1);
  });

  it('reports only the new row in a mixed replay and new batch', async () => {
    const replay = row(
      '00000000-0000-4000-8000-000000000794',
      new Date('2026-08-11T00:00:01Z'),
      'existing audit',
    );
    const fresh = row(
      '00000000-0000-4000-8000-000000000795',
      new Date('2026-08-11T00:00:02Z'),
      'new audit',
    );
    await expect(actionLogs.insertMany(fx.db, [replay])).resolves.toBe(1);

    await expect(actionLogs.insertMany(fx.db, [replay, fresh])).resolves.toBe(1);
  });

  it('rejects database errors unrelated to the idempotency conflict', async () => {
    const invalid = row('not-a-uuid', new Date('2026-08-11T00:00:03Z'), 'invalid audit');

    await expect(actionLogs.insertMany(fx.db, [invalid])).rejects.toThrow();
  });
});
