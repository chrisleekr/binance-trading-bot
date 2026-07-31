import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRepo, type AccountRepo } from '../../src/repo/index.js';
import { apiKeys } from '../../src/schema/api-keys.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/api-keys.ts`.
 * Api keys hang off the account (1 account : 1 key pair), so every exported fn
 * takes an `AccountScope` — a wrong-owner call cannot be expressed, ownership is
 * proven once by `scopeAccount`. Cross-account rejection lives in
 * `cross-account.test.ts`; this suite locks the owner-scoped read/write/delete
 * semantics. Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works
 * on workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('api-keys account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let aa: AccountRepo;
  let ba: AccountRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    aa = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
    ba = await accountRepo(fx.db, fx.bob.userId, fx.bob.accountId);
    // Seed one key per account. The unique(account_id) index means each
    // account holds exactly one key row.
    await aa.apiKeys.upsert({
      key: 'alice-key',
      secret: 'alice-sec',
      last4: 'A001',
      label: 'alice live',
    });
    await ba.apiKeys.upsert({
      key: 'bob-key',
      secret: 'bob-sec',
      last4: 'B001',
      label: 'bob live',
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('findForAccount returns null for the owner when no key is stored yet', async () => {
    // Alice already has a seeded key; delete and re-read to observe the
    // legitimate-empty-state branch returning null rather than throwing.
    await aa.apiKeys.removeForAccount();
    const aliceRow = await aa.apiKeys.findForAccount();
    expect(aliceRow).toBeNull();
    // Reseed for the remaining tests.
    await aa.apiKeys.upsert({
      key: 'alice-key',
      secret: 'alice-sec',
      last4: 'A001',
      label: 'alice live',
    });
  });

  it('findForAccount returns the correct account row on the happy path', async () => {
    const aliceRow = await aa.apiKeys.findForAccount();
    expect(aliceRow?.accountId).toBe(fx.alice.accountId);
    // Defence-in-depth: the secret returned must be Alice's, never Bob's.
    expect(aliceRow?.secret).toBe('alice-sec');
    expect(aliceRow?.last4).toBe('A001');
  });

  it('upsert succeeds on the owner happy path and replaces the row in place', async () => {
    const updated = await aa.apiKeys.upsert({
      key: 'alice-key-2',
      secret: 'alice-sec-2',
      last4: 'A002',
      label: 'alice rotated',
    });
    expect(updated.accountId).toBe(fx.alice.accountId);
    expect(updated.last4).toBe('A002');

    // Re-fetch to confirm the unique(account_id) constraint kept it as one row.
    const aliceRow = await aa.apiKeys.findForAccount();
    expect(aliceRow?.last4).toBe('A002');
  });

  it('removeForAccount succeeds on the owner happy path and is idempotent', async () => {
    // Self-contained — re-seed Bob's row inside this test so the destructive
    // assertion does not depend on whatever state earlier seed-mutating tests
    // left behind. Keeps the suite order-independent.
    await ba.apiKeys.upsert({
      key: 'bob-rm',
      secret: 'bob-rm',
      last4: 'BRM1',
      label: null,
    });
    const firstRemove = await ba.apiKeys.removeForAccount();
    expect(firstRemove).toBe(true);

    // Second call is idempotent: nothing to delete, returns false, no throw.
    const secondRemove = await ba.apiKeys.removeForAccount();
    expect(secondRemove).toBe(false);

    const gone = await ba.apiKeys.findForAccount();
    expect(gone).toBeNull();
  });

  it('table-level invariant: every api_keys row resolves to its owning account', async () => {
    // Belt-and-braces sanity check: scan every row, confirm the accountId chain
    // is intact via the FK to accounts. Catches a hypothetical migration
    // regression that orphans rows.
    // Scoped to this fixture's accounts (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose account is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(apiKeys)
      .where(inArray(apiKeys.accountId, [fx.alice.accountId, fx.bob.accountId]));
    for (const row of rows) {
      const owners = await fx.db.query.accounts.findMany({
        where: (a, { eq }) => eq(a.id, row.accountId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
