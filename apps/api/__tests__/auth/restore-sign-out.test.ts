// A restore brings back the dump's own sessions and security epoch, so a session revoked after the dump was taken would work again. The route signs everything out afterwards; this pins that step against a real database. The real pg_restore is never run here, because it would overwrite the database every other suite shares; the route cases drive a faked one that fails.

import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { repo } from '@app/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { signOutEverythingAfterRestore } from '../../src/routes/backup.js';

// pg_restore is replaced by a child that records its arguments and fails, so the route's failure path runs without overwriting the shared database. Every other command keeps the real spawn.
const restoreCalls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawn: (cmd: string, args: readonly string[], opts: unknown) => {
      if (cmd !== 'pg_restore')
        return (orig.spawn as (...a: unknown[]) => unknown)(cmd, args, opts);
      restoreCalls.push([...args]);
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdin: { end: () => undefined },
      });
      setImmediate(() => child.emit('exit', 1));
      return child;
    },
  };
});

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('after a restore', () => {
  let fx: ApiFixture;
  // A real Better Auth session: re-authentication checks the password against the caller's own session, which the test header shortcut does not create.
  let cookie = '';

  beforeAll(async () => {
    fx = await setupApp({ seed: false });
    const res = await fx.app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'restore@example.test',
        password: 'restore-operator-password',
        name: 'Operator',
      }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .filter((c) => c.includes('session_token'))
      .join('; ');
  });
  afterAll(async () => {
    await fx.cleanup();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const restoreDirs = async (): Promise<string[]> =>
    (await readdir(tmpdir())).filter((d) => d.startsWith('restore-'));
  const postRestore = (
    reauthentication: string | null = JSON.stringify({
      method: 'password',
      password: 'restore-operator-password',
    }),
  ): Promise<Response> => {
    const form = new FormData();
    form.append('archive', new File([new Uint8Array([1, 2, 3])], 'backup.dump'));
    if (reauthentication !== null) form.append('reauthentication', reauthentication);
    return Promise.resolve(
      fx.app.request('/api/restore', {
        method: 'POST',
        // The header admits the request through the fixture's user shortcut; the cookie is what the password check reads.
        headers: { 'x-test-user-id': fx.alice.userId, cookie },
        body: form,
      }),
    );
  };

  it('refuses a restore without a valid confirmation before writing the archive or running pg_restore', async () => {
    // A restore replaces the password hash and the single sign-on identity, so a stolen session alone must not be able to plant its own.
    const dirsBefore = await restoreDirs();
    restoreCalls.length = 0;
    expect((await postRestore(null)).status).toBe(422);
    expect((await postRestore('{"method":"password"}')).status).toBe(422);
    const wrong = await postRestore(
      JSON.stringify({ method: 'password', password: 'not-the-operator-password' }),
    );
    expect(wrong.ok).toBe(false);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PASSWORD',
    );
    expect(restoreCalls).toHaveLength(0);
    expect(await restoreDirs()).toEqual(dirsBefore);
  });

  it('restores in one transaction, so a failed restore changes nothing and removes the uploaded archive', async () => {
    const dirsBefore = await restoreDirs();
    restoreCalls.length = 0;
    const res = await postRestore();
    expect(res.ok).toBe(false);
    expect(restoreCalls).toHaveLength(1);
    // Without it pg_restore continues past errors and leaves the dump's sessions and older epoch in place while the route reports failure and skips the sign-out.
    expect(restoreCalls[0]).toContain('--single-transaction');
    expect(await restoreDirs()).toEqual(dirsBefore);
  });

  it('removes the uploaded archive when the pre-restore epoch cannot be read', async () => {
    const dirsBefore = await restoreDirs();
    restoreCalls.length = 0;
    vi.spyOn(repo.authSecuritySettings, 'get').mockRejectedValueOnce(new Error('database down'));
    const res = await postRestore();
    expect(res.ok).toBe(false);
    expect(restoreCalls).toHaveLength(0);
    expect(await restoreDirs()).toEqual(dirsBefore);
  });

  it('signs out every session and revokes agent access, because the dump brought back its own', async () => {
    const epochOf = async (): Promise<number> =>
      (
        await fx.di.pool.query<{ e: number }>(
          `select security_epoch as e from auth_security_settings`,
        )
      ).rows[0]?.e ?? -1;
    const before = await epochOf();
    expect((await fx.di.pool.query(`select 1 from session`)).rowCount).toBeGreaterThan(0);
    await signOutEverythingAfterRestore(fx.di, before);
    expect(await epochOf()).toBe(before + 1);
    expect((await fx.di.pool.query(`select 1 from session`)).rowCount).toBe(0);
    const cutoff = await fx.di.pool.query<{ t: Date | null }>(
      `select agent_access_not_before as t from auth_security_settings`,
    );
    expect(cutoff.rows[0]?.t).not.toBeNull();
    expect((await fx.di.security.settings.get()).securityEpoch).toBe(before + 1);
  });

  it('raises the epoch past the pre-restore one when the dump carried an older epoch', async () => {
    // A dump taken at epoch 2 restored over a live epoch of 4: a plain bump would land on 3 and re-validate known-device cookies issued at 3.
    await fx.di.pool.query(`update auth_security_settings set security_epoch = 2`);
    await signOutEverythingAfterRestore(fx.di, 4);
    const rows = await fx.di.pool.query<{ e: number }>(
      `select security_epoch as e from auth_security_settings`,
    );
    expect(rows.rows[0]?.e).toBe(5);
  });
});
