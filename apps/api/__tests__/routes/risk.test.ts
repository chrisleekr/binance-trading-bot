import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredRiskConfig } from '@app/contracts';
import { nextUtcMidnightMs, startOfUtcDayMs } from '@app/contracts';
import { profileKey, profileRepo } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the risk router: GET returns the effective config +
 * live circuit-breaker status, PATCH writes the daily-loss limit, the seeded
 * Redis halt flag surfaces as `halted` with a reset time, an out-of-range stored
 * config falls back to defaults + `configInvalid`, and both stay account-scoped.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

describeIfInfra('risk router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET returns an off breaker + zero P/L for a fresh profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { dailyLossLimitQuote: string };
      configInvalid: boolean;
      status: { halted: boolean; limitQuote: string | null; resetsAtMs: number | null };
    };
    expect(body.config.dailyLossLimitQuote).toBe('0');
    expect(body.configInvalid).toBe(false);
    expect(body.status.halted).toBe(false);
    expect(body.status.limitQuote).toBeNull();
    expect(body.status.resetsAtMs).toBeNull();
  });

  it('PATCH writes the daily-loss limit and a subsequent GET reflects it (armed, not halted)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ dailyLossLimitQuote: '20' }),
      },
    );
    expect(res.status).toBe(200);

    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    const body = (await after.json()) as {
      status: { halted: boolean; limitQuote: string | null };
    };
    expect(Number(body.status.limitQuote)).toBe(20);
    expect(body.status.halted).toBe(false);
  });

  it('reports halted with a reset time when the worker flag is set, and the day P/L', async () => {
    const now = Date.now();
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    // A realised loss archived today (UTC).
    await p.tradeArchive.insert({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      totalSellQuote: '92',
      profit: '-8',
      profitPercent: '-8',
      breakdown: {},
      source: 'manual',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date(now),
    });
    await p.profile.setRiskConfig({ dailyLossLimitQuote: '5' } as StoredRiskConfig);
    // The worker cron would set this; seed it directly to exercise the read path.
    await fx.di.redis
      .raw()
      .set(
        profileKey({ accountId: fx.bob.accountId, profileId: fx.bob.profileId }, 'entryHaltDaily'),
        JSON.stringify({ reason: 'daily-loss-limit' }),
        'EX',
        3600,
      );

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/risk`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { halted: boolean; todayRealizedPnl: string; resetsAtMs: number | null };
    };
    expect(body.status.halted).toBe(true);
    expect(Number(body.status.todayRealizedPnl)).toBe(-8);
    expect(body.status.resetsAtMs).toBe(nextUtcMidnightMs(startOfUtcDayMs(now)));
  });

  it('GET falls back to defaults + configInvalid when the stored config is out of range', async () => {
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // setRiskConfig writes raw JSON with no re-validation (mirrors a direct
    // jsonb_set), so a negative limit bypasses the PATCH body validator.
    await p.profile.setRiskConfig({ dailyLossLimitQuote: '-5' } as unknown as StoredRiskConfig);
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configInvalid: boolean;
      config: { dailyLossLimitQuote: string };
    };
    expect(body.configInvalid).toBe(true);
    expect(body.config.dailyLossLimitQuote).toBe('0');
  });

  it('PATCH rejects a negative limit (422 from the body validator)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({ dailyLossLimitQuote: '-1' }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('denies cross-account read and write', async () => {
    const read = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(read.status).toBe(404);
    const write = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`,
      {
        method: 'PATCH',
        headers: headers(fx.bob.userId),
        body: JSON.stringify({ dailyLossLimitQuote: '10' }),
      },
    );
    expect(write.status).toBe(404);
  });
});
