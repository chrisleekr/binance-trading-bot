import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredRiskConfig } from '@app/contracts';
import { nextUtcMidnightMs, startOfUtcDayMs } from '@app/contracts';
import { entryHaltKeys, profileKey, profileRepo } from '@app/db';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the risk router: GET returns the effective config +
 * live circuit-breaker status, PATCH writes the daily-loss limit, the seeded
 * Redis halt flag surfaces as `halted` with a reset time, an out-of-range stored
 * config falls back to defaults + `configInvalid`, PATCH round-trips the nested
 * guard blocks and merges a partial body over the stored config instead of
 * replacing it, a nested partial replaces its whole block back to schema
 * defaults, and both stay account-scoped.
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
      breakdown: {},
      source: 'manual',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date(now),
    });
    // A same-day loss closed under a PREVIOUS quote asset. `todayRealizedPnl` is compared against a limit denominated in the CURRENT quote, so this row must not reach it — the -8 assertion below is the gate. Its magnitude is far from -8 so a dropped filter cannot pass by coincidence.
    await p.tradeArchive.insert({
      symbol: 'ETHBTC',
      baseAsset: 'ETH',
      quoteAsset: 'BTC',
      totalBuyQuote: '1',
      totalSellQuote: '0.5',
      profit: '-500',
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

  it('names a guard halt and takes its lift time from the key’s own TTL', async () => {
    const keys = entryHaltKeys({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
    });
    await fx.di.redis
      .raw()
      .set(keys['loss-streak'], JSON.stringify({ reason: 'loss-streak' }), 'EX', 3600);
    const before = Date.now();

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      { headers: headers(fx.alice.userId) },
    );
    const body = (await res.json()) as {
      status: { halted: boolean; haltKinds: string[]; resetsAtMs: number | null };
    };
    expect(body.status.halted).toBe(true);
    expect(body.status.haltKinds).toEqual(['loss-streak']);
    // From the TTL, not from UTC midnight: a guard pause has nothing to do with
    // the day boundary, and telling the operator otherwise misstates when buying
    // resumes by up to a day in either direction.
    expect(body.status.resetsAtMs).toBeGreaterThan(before + 3_599_000);
    expect(body.status.resetsAtMs).toBeLessThanOrEqual(Date.now() + 3_600_000);

    await fx.di.redis.raw().del(keys['loss-streak']);
  });

  it('reports resetsAtMs as the LAST halt to lift when two are active', async () => {
    const keys = entryHaltKeys({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
    });
    await fx.di.redis.raw().set(keys['loss-streak'], '{}', 'EX', 60);
    await fx.di.redis.raw().set(keys.drawdown, '{}', 'EX', 7200);
    const before = Date.now();

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      { headers: headers(fx.alice.userId) },
    );
    const body = (await res.json()) as {
      status: { haltKinds: string[]; resetsAtMs: number | null };
    };
    // Enum order, so two surfaces cannot disagree about which breaker is first.
    expect(body.status.haltKinds).toEqual(['loss-streak', 'drawdown']);
    // Buying resumes only once BOTH have lifted, so the soonest one is the wrong
    // answer even though it is the one that changes first.
    expect(body.status.resetsAtMs).toBeGreaterThan(before + 7_199_000);

    await fx.di.redis.raw().del(keys['loss-streak'], keys.drawdown);
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

  it('PATCH round-trips the nested guard blocks instead of defaulting them away', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify({
          dailyLossLimitQuote: '30',
          lossStreak: { maxLosingExits: 4, lookbackHours: 12, pauseHours: 6 },
          drawdown: { maxDrawdownQuote: '15', lookbackHours: 48, pauseHours: 8 },
        }),
      },
    );
    expect(res.status).toBe(200);

    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      { headers: headers(fx.alice.userId) },
    );
    const body = (await after.json()) as { config: StoredRiskConfig; configInvalid: boolean };
    expect(body.configInvalid).toBe(false);
    expect(body.config.dailyLossLimitQuote).toBe('30');
    expect(body.config.lossStreak).toEqual({
      maxLosingExits: 4,
      lookbackHours: 12,
      pauseHours: 6,
    });
    expect(body.config.drawdown).toEqual({
      maxDrawdownQuote: '15',
      lookbackHours: 48,
      pauseHours: 8,
    });
  });

  it('PATCH of one field leaves the other guards armed (a partial body is a patch, not a replace)', async () => {
    const url = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`;
    const arm = await fx.app.request(url, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({
        dailyLossLimitQuote: '10',
        lossStreak: { maxLosingExits: 3, lookbackHours: 12, pauseHours: 6 },
        drawdown: { maxDrawdownQuote: '25', lookbackHours: 48, pauseHours: 8 },
      }),
    });
    expect(arm.status).toBe(200);

    // The whole point: the body names ONLY the daily limit. Zod fills the two guard blocks with their OFF defaults on the way in, so a handler that writes the validated body whole disarms both breakers here with no error and no audit trace.
    const partial = await fx.app.request(url, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ dailyLossLimitQuote: '25' }),
    });
    expect(partial.status).toBe(200);

    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      { headers: headers(fx.alice.userId) },
    );
    const body = (await after.json()) as { config: StoredRiskConfig };
    expect(body.config.dailyLossLimitQuote).toBe('25');
    expect(body.config.lossStreak).toEqual({
      maxLosingExits: 3,
      lookbackHours: 12,
      pauseHours: 6,
    });
    expect(body.config.drawdown).toEqual({
      maxDrawdownQuote: '25',
      lookbackHours: 48,
      pauseHours: 8,
    });
  });

  it('PATCH of a nested field REPLACES that block, resetting its siblings to schema defaults', async () => {
    const url = `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk-config`;
    const arm = await fx.app.request(url, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({
        drawdown: { maxDrawdownQuote: '25', lookbackHours: 48, pauseHours: 8 },
      }),
    });
    expect(arm.status).toBe(200);

    // The merge is one level deep, so naming the block at all replaces it whole. Pinning the DEFAULTS is the whole assertion: a deep merge would keep 48/8 here and satisfy a test that only checked the field the body named.
    const nested = await fx.app.request(url, {
      method: 'PATCH',
      headers: headers(fx.alice.userId),
      body: JSON.stringify({ drawdown: { maxDrawdownQuote: '5' } }),
    });
    expect(nested.status).toBe(200);

    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/risk`,
      { headers: headers(fx.alice.userId) },
    );
    const body = (await after.json()) as { config: StoredRiskConfig };
    expect(body.config.drawdown).toEqual({
      maxDrawdownQuote: '5',
      lookbackHours: 72,
      pauseHours: 24,
    });
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
