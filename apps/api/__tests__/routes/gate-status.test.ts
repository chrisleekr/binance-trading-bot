import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo } from '@app/db';
import { configFingerprint } from '@app/strategy-core';
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
  failedChecks: string[];
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
    expect(body.failure).toBe('no-matching-backtest');
    expect(body.failedChecks).toEqual([]);
  });

  it('lists the failed thresholds when the matching backtest misses the bar', async () => {
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await fx.di.pool.query(`update accounts set binance_mode = 'live' where id = $1`, [
      fx.bob.accountId,
    ]);
    const row = await p.profile.findById();
    const plugin = fx.di.strategies.get(row?.strategyName ?? '');
    if (!row || !plugin) throw new Error('fixture profile or its strategy is missing');
    // The fixture's stored config does not parse, which the route reports as no match; a valid config is what gives the gate a fingerprint to match.
    await p.profile.update({
      enablementPolicy: { enabled: true },
      config: plugin.defaultConfig as Record<string, unknown>,
    });
    // The gate matches a run by the fingerprint of the profile's parsed config, so the run must carry exactly that one.
    const fingerprint = configFingerprint(plugin.configSchema.parse(plugin.defaultConfig));
    const params = {
      symbols: ['BTCUSDT'],
      fromMs: 1_000,
      toMs: 2_000,
      strategyInterval: '1h',
      detailInterval: '5m',
      initialQuoteBalance: '1000',
      fees: { makerBps: 10, takerBps: 10 },
      slippageBps: 5,
    };
    // Clean data but too few trades and no edge, so only the threshold checks can fail it.
    const metrics = {
      startingBalance: '1000',
      finalBalance: '1000',
      absoluteProfit: '0',
      totalReturnPct: 0,
      cagrPct: 0,
      marketChangePct: 0,
      dcaChangePct: 0,
      alphaVsHoldPct: -5,
      alphaVsDcaPct: 0,
      sharpe: null,
      sortino: null,
      calmar: 0,
      sqn: null,
      maxDrawdownPct: 0,
      absoluteDrawdown: '0',
      drawdownStartMs: null,
      drawdownEndMs: null,
      totalTrades: 3,
      winRate: 0,
      wins: 0,
      losses: 0,
      profitFactor: null,
      expectancy: '0',
      bestTradePct: null,
      worstTradePct: null,
      avgTradePnl: '0',
      avgTradeDurationMs: null,
    };
    const run = await p.backtestRuns.create({ symbols: ['BTCUSDT'], params });
    await p.backtestRuns.markRunning(run.id);
    await p.backtestRuns.complete(
      run.id,
      { params, metrics, equityCurve: [], drawdownSeries: [], trades: [], perSymbol: [] },
      fingerprint,
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/gate-status`,
      { headers: headers(fx.bob.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.applicability).toBe('gated');
    expect(body.ok).toBe(false);
    expect(body.failure).toBe('thresholds');
    expect(body.failedChecks.length).toBeGreaterThan(0);
    expect(body.failedChecks.some((line) => line.startsWith('closed trades 3 '))).toBe(true);
  });
});
