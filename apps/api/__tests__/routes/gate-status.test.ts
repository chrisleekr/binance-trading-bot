import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the gate-status router: a testnet profile reports
 * `not-live`; a live profile with the gate off reports `gate-off`; a live profile
 * with the gate on but no passing backtest reports `gated` + `ok:false`. The route
 * is advisory-only — it never reports a paused state. Cross-account reads 404.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

interface GateBody {
  applicability: 'gated' | 'not-live' | 'gate-off';
  ok: boolean;
  failure: string | null;
  detail: string;
}

describeIfInfra('gate-status router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('reports not-live for a testnet profile (the gate guards real money only)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/gate-status`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.applicability).toBe('not-live');
    expect(body.ok).toBe(true);
  });

  it('denies cross-account read', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/gate-status`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('reports gate-off when a live profile has the gate turned off', async () => {
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await fx.di.pool.query(`update accounts set binance_mode = 'live' where id = $1`, [
      fx.bob.accountId,
    ]);
    await p.profile.update({ enablementPolicy: { enabled: false } });

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/gate-status`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.applicability).toBe('gate-off');
    expect(body.ok).toBe(true);
  });

  it('reports gated + unproven for a live, gated profile with no passing backtest', async () => {
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await fx.di.pool.query(`update accounts set binance_mode = 'live' where id = $1`, [
      fx.bob.accountId,
    ]);
    await p.profile.update({ enablementPolicy: { enabled: true } });

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/gate-status`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.applicability).toBe('gated');
    expect(body.ok).toBe(false);
  });
});
