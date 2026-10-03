// A restore brings back the dump's own sessions and security epoch, so a session revoked after the dump was taken would work again. The route signs everything out afterwards; this pins that step against a real database. The restore itself (pg_restore) is not run here, because it would overwrite the database every other suite shares.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signOutEverythingAfterRestore } from '../../src/routes/backup.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('after a restore', () => {
  let fx: ApiFixture;

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
  });
  afterAll(async () => {
    await fx.cleanup();
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
