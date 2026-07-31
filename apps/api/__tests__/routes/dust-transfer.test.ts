import { asProfileId, type ProfileId } from '@app/contracts';
import { profileRepo } from '@app/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Happy-path composition test for `GET /profiles/{id}/dust-transfer/history`.
 * The route glue — listDustTransferHistory(50) -> toDustConversionRecord ->
 * DustConversionHistory.parse -> c.json(200) — is only covered per-component
 * elsewhere (mapper unit test, repo DB test, web render test). This exercises
 * the whole chain end-to-end: a real seeded conversion returns a correct 200
 * body shape, dust-only filtering excludes other actions, and rows come back
 * newest-first.
 *
 * Locally-seeded profile with a real v4 UUID: the shared fixture's profile ids
 * are sentinels that fail the route's `z.uuid()` param.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('dust-transfer history route', () => {
  let fx: ApiFixture;
  const PROFILE_ID: ProfileId = asProfileId('22222222-2222-4222-8222-222222222222');

  beforeAll(async () => {
    fx = await setupApp();
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'dust-history-test', 'trailing-trade', '1.0.0', '{}', '{}')`,
      [PROFILE_ID, fx.alice.accountId],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  afterEach(async () => {
    await fx.di.pool.query('delete from override_actions');
  });

  const path = (): string =>
    `/api/accounts/${fx.alice.accountId}/profiles/${PROFILE_ID}/dust-transfer/history`;
  const headers = (): Record<string, string> => ({ 'x-test-user-id': fx.alice.userId });
  const repo = (): ReturnType<typeof profileRepo> =>
    profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, PROFILE_ID);

  const recordDust = async (assets: string[]): Promise<string> => {
    const p = await repo();
    const row = await p.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets },
      triggeredBy: 'user',
    });
    return row.id;
  };

  it('returns [] when the profile has no conversions', async () => {
    const res = await fx.app.request(path(), { headers: headers() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns dust conversions newest-first with the finalised outcome mapped', async () => {
    const p = await repo();
    // Older: a finalised (done) conversion carrying Binance's convertDust result.
    const doneId = await recordDust(['TRX', 'DOGE']);
    expect(await p.overrideActions.claimAction(doneId, new Date())).toBe(true);
    expect(
      await p.overrideActions.finalize(doneId, {
        totalTransfered: '0.01230000',
        transferResult: [{ fromAsset: 'TRX' }, { fromAsset: 'DOGE' }],
      }),
    ).toBe(true);
    // Newer: a still-pending conversion (no result yet).
    const pendingId = await recordDust(['SHIB']);
    // A non-dust action must be excluded by the dust-only filter.
    await p.overrideActions.record({
      symbol: 'BTCUSDT',
      action: 'buy',
      actionAt: new Date(),
      payload: { tag: 'not-dust' },
      triggeredBy: 'user',
    });

    const res = await fx.app.request(path(), { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      status: string;
      requestedAssets: string[];
      convertedAssets: string[] | null;
      bnbReceived: string | null;
      consumedAt: string | null;
    }>;

    // Newest-first (desc createdAt): the pending row was recorded last.
    expect(body.map((r) => r.id)).toEqual([pendingId, doneId]);

    const [pending, done] = body;
    expect(pending.status).toBe('pending');
    expect(pending.requestedAssets).toEqual(['SHIB']);
    expect(pending.convertedAssets).toBeNull();
    expect(pending.bnbReceived).toBeNull();
    expect(pending.consumedAt).toBeNull();

    expect(done.status).toBe('done');
    expect(done.requestedAssets).toEqual(['TRX', 'DOGE']);
    expect(done.convertedAssets).toEqual(['TRX', 'DOGE']);
    expect(done.bnbReceived).toBe('0.01230000');
    expect(done.consumedAt).not.toBeNull();
  });
});
