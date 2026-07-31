import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Verifies the per-profile action-log reader keeps only this profile's
 * warn+error rows, orders them newest-first, and honours `limit`.
 *
 * Skipped when the test infra (DATABASE_TEST_URL) isn't present so the
 * vitest run still passes locally without a docker postgres on hand.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('GET /profiles/:profileId/action-logs', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // action_logs is a TimescaleDB hypertable and is not in the shared
    // truncate list, so rows survive across runs. Clear this suite's
    // profiles up front so order/limit assertions are deterministic.
    await fx.di.pool.query(`delete from action_logs where profile_id = any($1)`, [
      [fx.alice.profileId, fx.bob.profileId],
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // `agoSeconds` lets a test order rows on the `time` column deterministically.
  const seed = async (
    profileId: string,
    level: string,
    msg: string,
    agoSeconds: number,
  ): Promise<void> => {
    await fx.di.pool.query(
      `insert into action_logs (time, profile_id, symbol, level, msg, ctx)
       values (now() - ($4 || ' seconds')::interval, $1, 'WLDUSDT', $2, $3, '{}'::jsonb)`,
      [profileId, level, msg, String(agoSeconds)],
    );
  };

  it('returns only this profile warn+error rows, newest-first', async () => {
    await seed(fx.alice.profileId, 'info', 'alice-info', 30);
    await seed(fx.alice.profileId, 'warn', 'alice-warn', 20);
    await seed(fx.alice.profileId, 'error', 'alice-error', 10);
    // Another profile's error must not leak in.
    await seed(fx.bob.profileId, 'error', 'bob-error', 5);

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/action-logs`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { level: string; msg: string }[] };
    // info dropped, bob dropped; error (newest) before warn.
    expect(body.items.map((i) => i.msg)).toEqual(['alice-error', 'alice-warn']);
    expect(body.items.every((i) => i.level === 'warn' || i.level === 'error')).toBe(true);
  });

  it('respects the limit query parameter', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/action-logs?limit=1`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { msg: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.msg).toBe('alice-error');
  });

  it('returns 404 when the profile is not owned by the caller', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/action-logs`,
      {
        headers: { 'x-test-user-id': fx.alice.userId },
      },
    );
    expect(res.status).toBe(404);
  });
});
