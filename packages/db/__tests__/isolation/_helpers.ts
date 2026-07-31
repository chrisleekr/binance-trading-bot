import { randomUUID } from 'node:crypto';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { migrate } from '../../src/migrate.js';
import { assertTestDatabaseUrl } from '../../src/test-guard.js';
import * as schema from '../../src/schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface IsolationFixture {
  pool: Pool;
  db: Db;
  alice: {
    userId: ReturnType<typeof asUserId>;
    accountId: ReturnType<typeof asAccountId>;
    profileId: ReturnType<typeof asProfileId>;
  };
  bob: {
    userId: ReturnType<typeof asUserId>;
    accountId: ReturnType<typeof asAccountId>;
    profileId: ReturnType<typeof asProfileId>;
  };
  cleanup: () => Promise<void>;
}

export const TEST_DB_URL = process.env['DATABASE_TEST_URL'];

/**
 * Builds a two-user fixture (Alice, Bob) on a fresh connection. Each call
 * mints *random* user/profile UUIDs and tears down only its own rows on
 * cleanup, so test files that share the `binance_test` database can run in
 * parallel without one suite's seed colliding with another's. The FK from
 * every account-scoped table to `profiles` is `ON DELETE CASCADE`, so
 * deleting the two `users` rows reclaims the whole subtree.
 */
export async function setupFixture(): Promise<IsolationFixture> {
  if (!TEST_DB_URL) {
    throw new Error('DATABASE_TEST_URL is required for isolation tests');
  }
  // These suites delete rows (CASCADE) on TEST_DB_URL — refuse a non-`_test`
  // target so a stray DATABASE_TEST_URL aimed at the live DB cannot wipe it.
  assertTestDatabaseUrl(TEST_DB_URL);
  await migrate({ connectionString: TEST_DB_URL, log: () => undefined });

  const pool = new Pool({ connectionString: TEST_DB_URL });
  const db = drizzle(pool, { schema });

  const aliceUser = randomUUID();
  const aliceAccount = randomUUID();
  const aliceProfile = randomUUID();
  const bobUser = randomUUID();
  const bobAccount = randomUUID();
  const bobProfile = randomUUID();

  // One operator → one account → one profile per side. The Binance env
  // (`binance_mode`) lives on the account now; the profile hangs off it.
  const seedUser = async (userId: string, email: string, accountId: string, profileId: string) => {
    await db.insert(schema.users).values({ id: userId, email });
    await db
      .insert(schema.accounts)
      .values({ id: accountId, ownerId: userId, name: 'demo', binanceMode: 'test' });
    await db.insert(schema.profiles).values({
      id: profileId,
      accountId,
      name: 'demo',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
  };

  await seedUser(aliceUser, `alice-${aliceUser}@local`, aliceAccount, aliceProfile);
  await seedUser(bobUser, `bob-${bobUser}@local`, bobAccount, bobProfile);

  const cleanup = async (): Promise<void> => {
    // `finally` so a failing delete still releases the pool handle.
    try {
      // action_logs is a TimescaleDB hypertable with no FK to profiles, so it
      // is not reclaimed by the cascade — delete its rows explicitly first.
      await db
        .delete(schema.actionLogs)
        .where(inArray(schema.actionLogs.profileId, [aliceProfile, bobProfile]));
      // Delete this fixture's users; the ON DELETE CASCADE FK chain reclaims
      // every account-scoped row beneath them. audit_logs are user-scoped and
      // also cascade from `users`.
      await db.delete(schema.users).where(inArray(schema.users.id, [aliceUser, bobUser]));
    } finally {
      await pool.end();
    }
  };

  return {
    pool,
    db,
    alice: {
      userId: asUserId(aliceUser),
      accountId: asAccountId(aliceAccount),
      profileId: asProfileId(aliceProfile),
    },
    bob: {
      userId: asUserId(bobUser),
      accountId: asAccountId(bobAccount),
      profileId: asProfileId(bobProfile),
    },
    cleanup,
  };
}
