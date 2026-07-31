import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { auditLogs } from '../../src/schema/audit-logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('audit_logs profile-scoped pagination', () => {
  let fx: IsolationFixture;
  let bob: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    bob = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('listForProfile only returns rows tagged with this profile', async () => {
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const mine = randomUUID();
      await local.db.insert(auditLogs).values([
        {
          id: mine,
          operatorId: local.alice.userId,
          actor: 'alice',
          event: 'profile.update',
          payload: { profileId: local.alice.profileId },
        },
        {
          // Same user, different profile in payload — must be excluded.
          id: randomUUID(),
          operatorId: local.alice.userId,
          actor: 'alice',
          event: 'profile.update',
          payload: { profileId: randomUUID() },
        },
        {
          // User-scoped event (no profileId) — must be excluded.
          id: randomUUID(),
          operatorId: local.alice.userId,
          actor: 'alice',
          event: 'auth.login',
          payload: {},
        },
      ]);

      const rows = await localAlice.auditLogs.listForProfile(50, null, []);
      expect(rows.map((r) => r.id)).toEqual([mine]);
    } finally {
      await local.cleanup();
    }
  });

  it('listForProfile paginates across a same-millisecond microsecond boundary with no skip', async () => {
    // audit_logs.created_at is microsecond precision; the cursor must carry the
    // full µs resolution (cursorToken), or two rows sharing a millisecond but
    // differing in the sub-ms digits collapse to one cursor value and the row
    // with the smaller fraction is skipped on the next page.
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const r1 = randomUUID();
      const r2 = randomUUID();
      const r3 = randomUUID();
      const r4 = randomUUID();
      const allIds = new Set([r1, r2, r3, r4]);

      const row = (id: string, createdAt: ReturnType<typeof sql>) => ({
        id,
        operatorId: local.alice.userId,
        actor: 'alice',
        event: 'profile.update',
        payload: { profileId: local.alice.profileId },
        createdAt,
      });

      await local.db.insert(auditLogs).values([
        row(r1, sql`'2026-06-19T00:00:00.100900Z'::timestamptz`), // newest
        row(r2, sql`'2026-06-19T00:00:00.100100Z'::timestamptz`),
        row(r3, sql`'2026-06-19T00:00:00.100050Z'::timestamptz`), // same ms .100, smaller µs
        row(r4, sql`'2026-06-19T00:00:00.099000Z'::timestamptz`), // earlier ms
      ]);

      const page1 = await localAlice.auditLogs.listForProfile(2, null, []);
      expect(page1.length).toBe(2);

      const cursor = { createdAt: page1[1].cursorToken, id: page1[1].id };
      const page2 = await localAlice.auditLogs.listForProfile(2, cursor, []);

      const seen = new Set([...page1.map((r) => r.id), ...page2.map((r) => r.id)]);
      expect(seen.size).toBe(4);
      expect(seen).toEqual(allIds);
    } finally {
      await local.cleanup();
    }
  });

  it('listForProfile still paginates correctly given a legacy millisecond-only cursor', async () => {
    // Cursors emitted before the µs fix carry only millisecond resolution.
    // Such a cursor must still cast to timestamptz and page without error or
    // row loss.
    const local = await setupFixture();
    try {
      const localAlice = await profileRepo(
        local.db,
        local.alice.userId,
        local.alice.accountId,
        local.alice.profileId,
      );
      const r1 = randomUUID();
      const r2 = randomUUID();
      const allIds = new Set([r1, r2]);
      const row = (id: string, createdAt: ReturnType<typeof sql>) => ({
        id,
        operatorId: local.alice.userId,
        actor: 'alice',
        event: 'profile.update',
        payload: { profileId: local.alice.profileId },
        createdAt,
      });
      await local.db
        .insert(auditLogs)
        .values([
          row(r1, sql`'2026-06-19T00:00:00.100900Z'::timestamptz`),
          row(r2, sql`'2026-06-19T00:00:00.050000Z'::timestamptz`),
        ]);

      const legacyCursor = { createdAt: '2026-06-19T00:00:00.101Z', id: r1 };
      const rows = await localAlice.auditLogs.listForProfile(10, legacyCursor, []);
      expect(new Set(rows.map((r) => r.id))).toEqual(allIds);
    } finally {
      await local.cleanup();
    }
  });

  it("a row tagged for alice's profile is invisible to bob's scope", async () => {
    const id = randomUUID();
    await fx.db.insert(auditLogs).values({
      id,
      operatorId: fx.alice.userId,
      actor: 'alice',
      event: 'profile.update',
      payload: { profileId: fx.alice.profileId },
    });
    const bobRows = await bob.auditLogs.listForProfile(50, null, []);
    expect(bobRows.some((r) => r.id === id)).toBe(false);
  });
});
