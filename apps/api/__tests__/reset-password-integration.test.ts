// End-to-end coverage for the reset-password recovery against real Postgres and Redis. The unit suite (`reset-password.test.ts`) locks the argument parsing and the password generator; this one proves the recovery actually restores sole access: the new password signs in, the old one does not, and nothing an intruder held (sessions, agent grants, a lockout) survives. The command-line wrapper is covered here too, because it opens its own connections: its exit codes, stdout carrying only the password, and that an unreachable Redis never hides a password that has already changed.

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ResetPasswordError,
  runReset,
  runResetPassword,
  type ResetOptions,
  type RunDeps,
} from '../scripts/reset-password.js';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const EMAIL = 'reset-cli@local.test';
const ORIGINAL_PW = 'original-password-1234';
const NAME = 'Reset CLI Test';

const options = (overrides: Partial<ResetOptions> = {}): ResetOptions => ({
  email: EMAIL,
  unlinkSingleSignOn: false,
  clearLockoutOnly: false,
  ...overrides,
});

describeIfInfra('reset-password recovery — runReset()', () => {
  let fx: ApiFixture;
  let redis: Redis;
  let userId: string;
  let password = ORIGINAL_PW;

  const signIn = async (pw: string): Promise<Response> =>
    fx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify({ email: EMAIL, password: pw }),
    });
  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await fx.di.pool.query(sql, params)).rowCount ?? 0;
  const reset = async (overrides: Partial<ResetOptions> = {}, publisher: Redis = redis) => {
    const result = await runReset(
      { db: fx.di.db, redis: publisher, security: fx.di.security },
      options(overrides),
    );
    if (result.newPassword !== null) password = result.newPassword;
    return result;
  };
  const lockOut = async (): Promise<void> => {
    for (let i = 0; i < 21; i += 1)
      await fx.di.security.protection.recordPasswordFailure(
        { ipAddress: `192.0.2.${i + 1}`, userAgent: null, knownDevice: false },
        EMAIL,
      );
  };
  // A fresh address per probe: while the site-wide backoff runs, each address gets one attempt per period, so reusing one would read as a lockout after the clear.
  let probe = 100;
  const lockedOut = async (): Promise<boolean> => {
    probe += 1;
    return (
      (await fx.di.security.protection.checkPasswordAttempt(
        { ipAddress: `198.51.100.${probe}`, userAgent: null, knownDevice: false },
        EMAIL,
      )) !== null
    );
  };
  // Runs the command the way the container shell does, capturing both streams.
  const runCli = async (
    overrides: Partial<ResetOptions> = {},
    env: Partial<RunDeps['env']> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = '';
    let stderr = '';
    const code = await runResetPassword(options(overrides), {
      env: { ...fx.di.env, ...env },
      out: { write: (s) => void (stdout += s) },
      err: { write: (s) => void (stderr += s) },
    });
    const printed = stdout.trim();
    if (code === 0 && printed !== '') password = printed;
    return { code, stdout, stderr };
  };
  // Nothing listens on port 1, so every Redis command fails the way it does during an outage.
  const UNREACHABLE_REDIS = 'redis://127.0.0.1:1/0';

  beforeAll(async () => {
    // The real limiter, so the lockout case exercises the keys the recovery must clear.
    fx = await setupApp({ seed: false, realLimiter: true });
    redis = new Redis(fx.redisUrl);
    const res = await fx.app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: ORIGINAL_PW, name: NAME }),
    });
    if (res.status !== 200)
      throw new Error(`sign-up failed for fixture user: ${res.status} ${await res.text()}`);
    userId =
      (await fx.di.pool.query<{ id: string }>(`select id from "user" limit 1`)).rows[0]?.id ?? '';
  });
  beforeEach(async () => {
    // Limits are not what these cases are about, except where a case sets them up itself.
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
    if (fx) await fx.cleanup();
  });

  it('rotates the credential, and the old password stops working', async () => {
    const result = await reset();
    expect(result.userId).toBe(userId);
    expect(result.newPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await signIn(password)).status).toBe(200);
    const old = await signIn(ORIGINAL_PW);
    expect(old.status).toBeGreaterThanOrEqual(400);
    expect(old.status).toBeLessThan(500);
  });

  it('signs out every session, raises the security epoch and records the reset', async () => {
    await signIn(password);
    expect(await count(`select 1 from session`)).toBeGreaterThan(0);
    const epochBefore =
      (
        await fx.di.pool.query<{ e: number }>(
          `select security_epoch as e from auth_security_settings`,
        )
      ).rows[0]?.e ?? 0;
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
    await reset();
    expect(await count(`select 1 from session`)).toBe(0);
    const epochAfter =
      (
        await fx.di.pool.query<{ e: number }>(
          `select security_epoch as e from auth_security_settings`,
        )
      ).rows[0]?.e ?? 0;
    expect(epochAfter).toBe(epochBefore + 1);
    expect(
      await count(
        `select 1 from audit_logs where category = 'security' and event = 'reset-password-cli'`,
      ),
    ).toBe(1);
  });

  it('revokes every agent grant and stamps the cutoff that invalidates tokens already issued', async () => {
    await fx.di.pool.query(
      `insert into "oauthClient" (id, "clientId", "redirectUris", "userId") values ('reset-client', 'reset-client', array['https://agent.example.test/cb'], $1) on conflict do nothing`,
      [userId],
    );
    await fx.di.pool.query(
      `insert into "oauthRefreshToken" (id, token, "clientId", "userId", scopes) values ('reset-refresh', 'reset-refresh-token', 'reset-client', $1, array['read'])`,
      [userId],
    );
    await fx.di.pool.query(
      `insert into "oauthAccessToken" (id, token, "clientId", "userId", scopes) values ('reset-access', 'reset-access-token', 'reset-client', $1, array['read'])`,
      [userId],
    );
    await fx.di.pool.query(
      `insert into "oauthConsent" (id, "clientId", "userId", scopes) values ('reset-consent', 'reset-client', $1, array['read'])`,
      [userId],
    );
    await fx.di.pool.query(`update auth_security_settings set agent_access_not_before = null`);
    const startedAt = Date.now();
    await reset();
    expect(await count(`select 1 from "oauthConsent" where "userId" = $1`, [userId])).toBe(0);
    expect(await count(`select 1 from "oauthAccessToken" where "userId" = $1`, [userId])).toBe(0);
    expect(await count(`select 1 from "oauthRefreshToken" where "userId" = $1`, [userId])).toBe(0);
    const cutoff = (
      await fx.di.pool.query<{ t: Date | null }>(
        `select agent_access_not_before as t from auth_security_settings`,
      )
    ).rows[0]?.t;
    expect(cutoff).not.toBeNull();
    expect(cutoff?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
  });

  it('still returns the new password when the live-connection notice cannot be published, because the old password is already gone', async () => {
    const failingPublisher = {
      publish: async () => {
        throw new Error('redis down');
      },
    } as unknown as Redis;
    const result = await reset({}, failingPublisher);
    expect(result.newPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('redis down');
    expect(result.warnings[0]).toContain('60 seconds');
    expect((await signIn(password)).status).toBe(200);
    expect(
      await count(
        `select 1 from audit_logs where category = 'security' and event = 'reset-password-cli'`,
      ),
    ).toBeGreaterThan(0);
  });

  it('creates a password sign-in for an operator who only had single sign-on', async () => {
    await fx.di.pool.query(
      `delete from account where "userId" = $1 and "providerId" = 'credential'`,
      [userId],
    );
    await reset();
    expect(
      await count(`select 1 from account where "userId" = $1 and "providerId" = 'credential'`, [
        userId,
      ]),
    ).toBe(1);
    expect((await signIn(password)).status).toBe(200);
  });

  it('repairs a missing domain user row, which every account-scoped route needs', async () => {
    await fx.di.pool.query(`delete from accounts where owner_id = $1`, [userId]);
    await fx.di.pool.query(`delete from users where id = $1`, [userId]);
    await reset();
    expect(await count(`select 1 from users where id = $1`, [userId])).toBe(1);
    expect(await count(`select 1 from accounts where owner_id = $1`, [userId])).toBe(1);
  });

  it('removes the single sign-on identity only when asked', async () => {
    const link = async (): Promise<void> => {
      await fx.di.pool.query(
        `insert into account (id, "userId", "providerId", "accountId", "createdAt", "updatedAt") values ($1, $2, 'oidc', 'https://idp.example.test/|sub-1', now(), now()) on conflict do nothing`,
        [`oidc-${userId}`, userId],
      );
    };
    await link();
    await reset();
    expect(await count(`select 1 from account where "providerId" = 'oidc'`)).toBe(1);
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
    const result = await reset({ unlinkSingleSignOn: true });
    expect(result.singleSignOnUnlinked).toBe(true);
    expect(await count(`select 1 from account where "providerId" = 'oidc'`)).toBe(0);
    expect(
      await count(
        `select 1 from audit_logs where category = 'security' and event = 'single-sign-on-unlinked-by-cli'`,
      ),
    ).toBe(1);
  });

  it('--clear-lockout lifts a lockout and the site-wide backoff without touching the password', async () => {
    const attempt = { ipAddress: '192.0.2.50', userAgent: null, knownDevice: false };
    await lockOut();
    expect((await fx.di.security.protection.checkPasswordAttempt(attempt, EMAIL))?.limit).toBe(
      'account_lockout',
    );
    const before = password;
    const result = await reset({ clearLockoutOnly: true });
    expect(result.newPassword).toBeNull();
    expect(password).toBe(before);
    expect(await redis.exists('auth:backoff:site')).toBe(0);
    expect(await lockedOut()).toBe(false);
    expect((await signIn(password)).status).toBe(200);
  });

  describe('the command', () => {
    it('prints only the new password on stdout and exits 0', async () => {
      const { code, stdout, stderr } = await runCli();
      expect(code).toBe(0);
      expect(stdout).toMatch(/^[A-Za-z0-9_-]{32}\n$/);
      expect(stderr).toBe('');
      expect((await signIn(password)).status).toBe(200);
    });

    it('--clear-lockout deletes the lockout from Redis itself, not from a process-local fallback', async () => {
      await lockOut();
      expect(await lockedOut()).toBe(true);
      const before = password;
      const { code, stdout } = await runCli({ clearLockoutOnly: true });
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(password).toBe(before);
      expect(await lockedOut()).toBe(false);
    });

    it('--clear-lockout also lifts a block on the address the operator signs in from, which the host cannot name', async () => {
      const blocked = { ipAddress: '198.51.100.250', userAgent: null, knownDevice: false };
      let refusal = null;
      for (let i = 0; i < 4 && refusal === null; i += 1)
        refusal = await fx.di.security.protection.checkPasswordAttempt(
          blocked,
          `x${i}@example.test`,
        );
      expect(refusal?.limit).toBe('sign_in_ip_address');
      const { code } = await runCli({ clearLockoutOnly: true });
      expect(code).toBe(0);
      expect(await fx.di.security.protection.checkPasswordAttempt(blocked, EMAIL)).toBeNull();
    });

    it('warns on stderr when password sign-in is turned off, since the printed password cannot be used yet', async () => {
      const { code, stdout, stderr } = await runCli({}, { PASSWORD_SIGN_IN_ENABLED: false });
      expect(code).toBe(0);
      expect(stdout).toMatch(/^[A-Za-z0-9_-]{32}\n$/);
      expect(stderr).toContain('PASSWORD_SIGN_IN_ENABLED=1');
    });

    it('exits 3 and prints nothing on stdout for an email that is not the operator', async () => {
      const { code, stdout, stderr } = await runCli({ email: 'someone-else@local.test' });
      expect(code).toBe(3);
      expect(stdout).toBe('');
      expect(stderr).toContain('no operator');
    });

    it('with Redis unreachable, still prints the new password and exits 0, warning that the lockout and the live-connection notice failed', async () => {
      const { code, stdout, stderr } = await runCli({}, { REDIS_URL: UNREACHABLE_REDIS });
      expect(code).toBe(0);
      expect(stdout).toMatch(/^[A-Za-z0-9_-]{32}\n$/);
      expect(stderr).toContain('warning: the sign-in lockout could not be cleared');
      expect(stderr).toContain('warning: running api replicas could not be told');
      expect((await signIn(password)).status).toBe(200);
    }, 20_000);

    it('with Redis unreachable, --clear-lockout exits 4 and records no lockout-cleared event, because nothing was cleared', async () => {
      await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
      const { code, stdout, stderr } = await runCli(
        { clearLockoutOnly: true },
        { REDIS_URL: UNREACHABLE_REDIS },
      );
      expect(code).toBe(4);
      expect(stdout).toBe('');
      expect(stderr).toContain('could not clear the sign-in lockout');
      expect(
        await count(
          `select 1 from audit_logs where category = 'security' and event = 'account-lockout-cleared'`,
        ),
      ).toBe(0);
    });
  });

  it('refuses an email that is not the operator', async () => {
    await expect(reset({ email: 'someone-else@local.test' })).rejects.toBeInstanceOf(
      ResetPasswordError,
    );
  });
});
