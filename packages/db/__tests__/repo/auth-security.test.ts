// Repository functions behind the hardened sign-in system, against a real database.
//
// Better Auth's `"user"` table holds at most one row (migration 0097), and the api suites sign an operator up on this same database, so every case that touches the sign-in tables runs inside a transaction that is rolled back. That keeps the single-operator index from colliding with rows another suite left behind, and leaves nothing behind for the next one.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/repo/_db.js';
import { auditLogs, authIdentity, authSecuritySettings } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

class Rollback extends Error {}

describeIfDb('sign-in repository functions', () => {
  let fx: IsolationFixture;

  /** Runs `body` in a transaction that is always rolled back. */
  const rolledBack = async (body: (tx: Database) => Promise<void>): Promise<void> => {
    await fx.db
      .transaction(async (tx) => {
        // Clears whatever another suite left in the sign-in tables, inside this transaction only.
        await tx.execute(sql`delete from "user"`);
        await body(tx as unknown as Database);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  };

  const insertUser = async (tx: Database, email = 'op@example.test'): Promise<string> => {
    const id = randomUUID();
    await tx.execute(
      sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, 'Operator', ${email}, false, now(), now())`,
    );
    return id;
  };

  const insertSession = async (
    tx: Database,
    userId: string,
    id = randomUUID(),
  ): Promise<string> => {
    await tx.execute(
      sql`insert into session (id, "userId", token, "expiresAt", "createdAt", "updatedAt") values (${id}, ${userId}, ${`token-${id}`}, now() + interval '1 day', now(), now())`,
    );
    return id;
  };

  beforeAll(async () => {
    fx = await setupFixture();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('refuses a second sign-in user at the database, whatever path tries to create it', async () => {
    await rolledBack(async (tx) => {
      await insertUser(tx);
      // A different email, so the refusal can only come from the single-operator index and not from the email being taken.
      await expect(insertUser(tx, 'second@example.test')).rejects.toMatchObject({
        cause: { constraint: 'user_single_operator_uidx' },
      });
    });
  });

  it('creates a password credential when there is none and replaces the hash when there is', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      expect(await authIdentity.listSignInProviders(tx, userId)).toEqual([]);
      expect(await authIdentity.upsertPasswordCredential(tx, userId, 'hash-1')).toBe(true);
      expect(await authIdentity.upsertPasswordCredential(tx, userId, 'hash-2')).toBe(false);
      const rows = await tx.execute<{ password: string }>(
        sql`select password from account where "userId" = ${userId} and "providerId" = 'credential'`,
      );
      expect(rows.rows.map((r) => r.password)).toEqual(['hash-2']);
      expect(await authIdentity.listSignInProviders(tx, userId)).toEqual(['credential']);
    });
  });

  it('does not count a credential row without a password as a way to sign in', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      await tx.execute(
        sql`insert into account (id, "userId", "providerId", "accountId", "createdAt", "updatedAt") values (${randomUUID()}, ${userId}, 'credential', ${userId}, now(), now())`,
      );
      expect(await authIdentity.listSignInProviders(tx, userId)).toEqual([]);
    });
  });

  it('lists sessions without ever selecting the token, and deletes all but the ones kept', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      const keep = await insertSession(tx, userId);
      await insertSession(tx, userId);
      await insertSession(tx, userId);
      const listed = await authIdentity.listSessions(tx, userId);
      expect(listed).toHaveLength(3);
      for (const row of listed) expect(Object.keys(row)).not.toContain('token');
      expect(await authIdentity.deleteSessionsExcept(tx, userId, [keep])).toBe(2);
      expect((await authIdentity.listSessions(tx, userId)).map((r) => r.id)).toEqual([keep]);
      expect(await authIdentity.deleteAllSessions(tx, userId)).toBe(1);
    });
  });

  it('revoking agent access stamps the cutoff the agent endpoint checks, because issued tokens have no row to delete', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      const at = new Date('2026-01-02T03:04:05.000Z');
      await authIdentity.revokeAgentAccess(tx, userId, at);
      expect((await authSecuritySettings.get(tx)).agentAccessNotBefore?.toISOString()).toBe(
        at.toISOString(),
      );
    });
  });

  it('never moves the agent cutoff backwards when an older revocation commits later', async () => {
    // A slow request or a retried reset can carry an older `at`; letting it win would re-admit tokens issued between the two cutoffs.
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      const newer = new Date('2026-01-02T03:04:05.000Z');
      await authIdentity.revokeAgentAccess(tx, userId, newer);
      await authIdentity.revokeAgentAccess(tx, userId, new Date('2026-01-01T00:00:00.000Z'));
      expect((await authSecuritySettings.get(tx)).agentAccessNotBefore?.toISOString()).toBe(
        newer.toISOString(),
      );
    });
  });

  it('refuses to report agent access revoked when the settings row is missing', async () => {
    // Deleting grants alone leaves issued tokens valid; only the cutoff ends them, so a missing row must fail loudly.
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      await tx.execute(sql`delete from auth_security_settings`);
      await expect(authIdentity.revokeAgentAccess(tx, userId, new Date())).rejects.toThrow(
        /auth_security_settings row missing/,
      );
    });
  });

  it('deletes every session when none is kept', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      await insertSession(tx, userId);
      await insertSession(tx, userId);
      expect(await authIdentity.deleteSessionsExcept(tx, userId, [])).toBe(2);
      expect(await authIdentity.listSessions(tx, userId)).toEqual([]);
    });
  });

  it('re-stamps only the session whose token it is given, and only for its owner', async () => {
    await rolledBack(async (tx) => {
      const userId = await insertUser(tx);
      const kept = await insertSession(tx, userId);
      const other = await insertSession(tx, userId);
      expect(await authIdentity.setSessionEpochByToken(tx, randomUUID(), `token-${kept}`, 7)).toBe(
        false,
      );
      expect(await authIdentity.setSessionEpochByToken(tx, userId, `token-${kept}`, 7)).toBe(true);
      const epochs = new Map(
        (await authIdentity.listSessions(tx, userId)).map((r) => [r.id, r.securityEpoch]),
      );
      expect(epochs.get(kept)).toBe(7);
      expect(epochs.get(other)).toBe(0);
    });
  });

  it('bumps the security epoch by exactly one per call', async () => {
    await rolledBack(async (tx) => {
      const before = (await authSecuritySettings.get(tx)).securityEpoch;
      expect(await authSecuritySettings.bumpSecurityEpoch(tx)).toBe(before + 1);
      expect(await authSecuritySettings.bumpSecurityEpoch(tx)).toBe(before + 2);
    });
  });

  it('removes only expired verification rows', async () => {
    await rolledBack(async (tx) => {
      await tx.execute(sql`delete from verification`);
      await tx.execute(
        sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") values ('old', 'state-1', 'v', now() - interval '1 minute', now(), now()), ('live', 'state-2', 'v', now() + interval '10 minutes', now(), now())`,
      );
      expect(await authIdentity.pruneExpiredVerifications(tx, new Date())).toBe(1);
      const left = await tx.execute<{ id: string }>(sql`select id from verification`);
      expect(left.rows.map((r) => r.id)).toEqual(['live']);
    });
  });

  it('prunes general and security audit rows on separate horizons, so general retention cannot erase security evidence', async () => {
    await rolledBack(async (tx) => {
      const old = new Date('2019-01-01T00:00:00.000Z');
      await auditLogs.append(tx, fx.alice.userId, {
        actor: 'user',
        event: 'config-change',
        category: 'general',
        createdAt: old,
      });
      await auditLogs.append(tx, fx.alice.userId, {
        actor: 'anonymous',
        event: 'sign-in-failed',
        category: 'security',
        createdAt: old,
      });
      const cutoff = new Date('2020-01-01T00:00:00.000Z');
      expect(await auditLogs.pruneAllOlderThan(tx, cutoff)).toBe(1);
      expect(await auditLogs.pruneOlderThan(tx, fx.alice.userId, cutoff)).toBe(0);
      expect(await auditLogs.pruneSecurityOlderThan(tx, cutoff)).toBe(1);
    });
  });

  it('pages security events newest first and never mixes in general rows', async () => {
    await rolledBack(async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        await auditLogs.append(tx, fx.alice.userId, {
          actor: 'user',
          event: `security-${i}`,
          category: 'security',
          createdAt: new Date(Date.UTC(2019, 5, 1, 0, 0, i)),
        });
      }
      await auditLogs.append(tx, fx.alice.userId, {
        actor: 'user',
        event: 'general',
        category: 'general',
        createdAt: new Date(Date.UTC(2019, 5, 1, 0, 0, 9)),
      });
      const first = await auditLogs.listSecurityForOperator(tx, fx.alice.userId, 2, null);
      expect(first.map((r) => r.event)).toEqual(['security-2', 'security-1']);
      const last = first.at(-1);
      const next = await auditLogs.listSecurityForOperator(
        tx,
        fx.alice.userId,
        2,
        last ? { createdAt: last.cursorToken, id: last.id } : null,
      );
      expect(next.map((r) => r.event)).toEqual(['security-0']);
    });
  });

  it('only ever raises the count on an aggregated security row', async () => {
    await rolledBack(async (tx) => {
      const row = await auditLogs.append(tx, fx.alice.userId, {
        actor: 'anonymous',
        event: 'rate-limited',
        category: 'security',
        payload: { count: 1 },
      });
      await auditLogs.raiseSecurityCount(tx, row.id, 8);
      await auditLogs.raiseSecurityCount(tx, row.id, 4);
      const stored = await tx.execute<{ n: number }>(
        sql`select (payload->>'count')::int as n from audit_logs where id = ${row.id}`,
      );
      expect(stored.rows[0]?.n).toBe(8);
    });
  });
});
