import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { profileNotifiers } from '../../src/schema/profile-notifiers.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped happy-path matrix for `packages/db/src/repo/profile-notifiers.ts`.
 * Every exported fn takes a `ProfileScope`, so a wrong-owner call cannot be
 * expressed — ownership is proven once by `scopeProfile`. Cross-account
 * rejection lives in `cross-account.test.ts`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available; the suite runs in CI where the
 * service container is online.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('profile-notifiers account-scoped reads and writes', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // Seed one notifier row per account. The (profile, provider) unique
    // index means each profile gets exactly one slack row.
    await ap.profileNotifiers.upsertByProvider('slack', {
      config: {},
      secrets: { webhookUrl: 'alice-secret' },
      enabled: true,
    });
    await bp.profileNotifiers.upsertByProvider('slack', {
      config: {},
      secrets: { webhookUrl: 'bob-secret' },
      enabled: true,
    });
  });

  afterAll(async () => {
    // Guard against `beforeAll` having thrown before `fx` was assigned, so the
    // teardown never masks the original setup failure with a TypeError.
    if (fx) await fx.cleanup();
  });

  it('listForProfile returns only the owner-scoped rows on the happy path', async () => {
    const rows = await ap.profileNotifiers.listForProfile();
    expect(rows.map((r) => r.profileId)).toEqual([fx.alice.profileId]);
    // Defence-in-depth: assert the returned secret is Alice's, never Bob's.
    expect(rows[0]?.secrets).toEqual({ webhookUrl: 'alice-secret' });
  });

  it('findByProvider never returns the other account row even with the same provider name', async () => {
    const aliceRow = await ap.profileNotifiers.findByProvider('slack');
    expect(aliceRow?.secrets).toEqual({ webhookUrl: 'alice-secret' });
    expect(aliceRow?.profileId).toBe(fx.alice.profileId);
  });

  it('insert lands the row on the owner profile', async () => {
    await ap.profileNotifiers.insert({
      provider: 'telegram',
      config: {},
      secrets: { botToken: 'alice-tg' },
      enabled: true,
    });
    const rows = await ap.profileNotifiers.listForProfile();
    expect(rows.find((r) => r.provider === 'telegram')?.profileId).toBe(fx.alice.profileId);
  });

  it('setEnabled flips the owner-scoped row on the happy path', async () => {
    const slackRow = await ap.profileNotifiers.findByProvider('slack');
    if (!slackRow) throw new Error('seeded Alice slack row missing');
    await ap.profileNotifiers.setEnabled(slackRow.id, false);
    const after = await ap.profileNotifiers.findByProvider('slack');
    expect(after?.enabled).toBe(false);
    // Restore for any later test.
    await ap.profileNotifiers.setEnabled(slackRow.id, true);
  });

  it('upsertByProvider replaces the owner-scoped row in place', async () => {
    await bp.profileNotifiers.upsertByProvider('slack', {
      config: {},
      secrets: { webhookUrl: 'bob-secret-2' },
      enabled: true,
    });
    const bobsRow = await bp.profileNotifiers.findByProvider('slack');
    expect(bobsRow?.secrets).toEqual({ webhookUrl: 'bob-secret-2' });
    expect(bobsRow?.enabled).toBe(true);
  });

  it('table-level invariant: every profile_notifiers row resolves to its owner profile', async () => {
    // Belt-and-braces sanity check: scan every row, look up its profile, and
    // confirm the userId chain is intact. Catches a hypothetical ON DELETE
    // CASCADE or migration regression where rows orphan from their profile.
    // Scoped to this fixture's profiles (#487 flake class, see trade-archive.test.ts):
    // parallel isolation files share one DB, so an unscoped scan can capture a foreign
    // row whose profile is CASCADE-deleted by another file's teardown mid-test.
    const rows = await fx.db
      .select()
      .from(profileNotifiers)
      .where(inArray(profileNotifiers.profileId, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owners = await fx.db.query.profiles.findMany({
        where: (p, { eq }) => eq(p.id, row.profileId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});
