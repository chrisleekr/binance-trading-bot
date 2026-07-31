import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as repo from '../../src/repo/index.js';
import {
  ProfileNotOwnedError,
  profileRepo,
  scopeAccount,
  scopeProfile,
} from '../../src/repo/index.js';
import { auditLogs } from '../../src/schema/audit-logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

// Central cross-account isolation matrix. Ownership is now checked exactly
// once — by `scopeProfile` — so per-function wrong-owner rejection is
// structurally impossible to express (a `ProfileScope` cannot be forged
// across accounts). This file owns the single rejection check for the
// whole repo layer, plus the user-scoped audit_logs cases. Skipped when
// DATABASE_TEST_URL is not set so `bun run test` works on workstations
// without a Postgres available.
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('cross-account isolation', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('profiles.listForAccount does not leak across accounts', async () => {
    const aliceScope = await scopeAccount(fx.db, fx.alice.userId, fx.alice.accountId);
    const alicesProfiles = await repo.profiles.listForAccount(aliceScope);
    expect(alicesProfiles.map((p) => p.accountId)).toEqual([fx.alice.accountId]);
  });

  it('scopeProfile rejects a cross-account scope with ProfileNotOwnedError', async () => {
    // The one and only ownership assertion in the repo layer. Every scoped
    // repo function trusts the `ProfileScope` it receives, so this single
    // check guards the entire account-scoped surface.
    await expect(
      scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.alice.profileId),
    ).rejects.toBeInstanceOf(ProfileNotOwnedError);
  });

  it('profileRepo rejects a cross-account scope with ProfileNotOwnedError', async () => {
    await expect(
      profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.alice.profileId),
    ).rejects.toBeInstanceOf(ProfileNotOwnedError);
  });

  it('audit_logs are user-scoped: cross-user listing returns nothing', async () => {
    await repo.auditLogs.append(fx.db, fx.alice.userId, {
      actor: 'user',
      event: 'sign-in',
      ip: null,
      userAgent: null,
      payload: null,
    });
    // Read bob's audit rows directly off the operator-keyed table. audit_logs
    // has no production operator-scoped reader (the app is profile-scoped), so
    // this direct query is the read-back proving append() stamps operatorId and
    // one operator's rows never surface under another's filter.
    const bobsLogs = await fx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.operatorId, fx.bob.userId));
    expect(bobsLogs).toEqual([]);
  });

  it('audit_logs.pruneOlderThan only deletes rows for the supplied user', async () => {
    await repo.auditLogs.append(fx.db, fx.alice.userId, {
      actor: 'user',
      event: 'sign-in',
      ip: null,
      userAgent: null,
      payload: null,
    });
    await repo.auditLogs.append(fx.db, fx.bob.userId, {
      actor: 'user',
      event: 'sign-in',
      ip: null,
      userAgent: null,
      payload: null,
    });

    await repo.auditLogs.pruneOlderThan(fx.db, fx.bob.userId, new Date());

    const alicesLogs = await fx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.operatorId, fx.alice.userId));
    expect(alicesLogs.length).toBeGreaterThan(0);
  });
});
