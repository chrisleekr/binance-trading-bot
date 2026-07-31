import type { ConfigLintResponse } from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * End-to-end coverage for the profile-scoped lint-config route, the surface the
 * config form polls on every edit. The per-symbol order-feasibility findings are
 * only worth producing if they reach the operator, so this asserts them through
 * the real router rather than through the library that builds them.
 * Integration-level because the route resolves the profile's bound symbols and
 * its account's Binance mode from the database.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const symbolInfo = JSON.stringify({
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.001',
    maxQty: '9000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
});
const ticker = JSON.stringify({ price: '100', ts: 1 });

// Deliberately sized below the seeded minNotional of 10, so a run that actually
// reads the snapshots MUST return a block. That block is the positive anchor for
// the cached case: without it, "no unavailable codes" would also be satisfied by
// a route that stopped reading snapshots, stopped parsing the config, or lost
// the symbol binding entirely.
const config = {
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: { enabled: true, entrySizing: { mode: 'fixed', amount: '5' } },
  sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
};

describeIfInfra('profiles lint-config route — order feasibility', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source)
       values ($1, 'BTCUSDT', 'BTC', 'auto')`,
      [fx.alice.profileId],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // Alice's seeded account is test-mode, so the filters live in the testnet
  // keyspace; the ticker feed is global and shared by both modes.
  const SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT', 'test');
  const TICKER_KEY = GLOBAL_KEYS.ticker('BTCUSDT');

  const lint = async (): Promise<{
    status: number;
    diagnostics: ConfigLintResponse['diagnostics'];
  }> => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/lint-config`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      },
    );
    return {
      status: res.status,
      diagnostics: ((await res.json()) as ConfigLintResponse).diagnostics,
    };
  };

  it('reports an uncheckable symbol to the form instead of a clean pass', async () => {
    // No cached market snapshot: the sizing check cannot run. A 200 with an empty
    // list would tell the operator the config was validated when it never was.
    await fx.di.redis.raw().del(SYM_KEY, TICKER_KEY);
    const { status, diagnostics } = await lint();
    // 200, not 422 — a degraded check is advisory and must never reject a save.
    expect(status).toBe(200);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'filters-unavailable' }),
    );
    expect(diagnostics.find((d) => d.code === 'filters-unavailable')?.message).toMatch(
      /^BTCUSDT: /,
    );
  });

  it('explains settings it cannot parse instead of going blank', async () => {
    // This is the operator's remediation surface. Returning an empty list for
    // settings the strategy schema rejects reads as "nothing wrong here" on the
    // one screen that exists to say what is wrong.
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/lint-config`,
      {
        method: 'POST',
        headers: { 'x-test-user-id': fx.alice.userId, 'content-type': 'application/json' },
        body: JSON.stringify({ config: { buy: 'not-a-config' } }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ConfigLintResponse).diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', code: 'config-unverified' }),
    ]);
  });

  it('checks against the cached snapshots instead of reporting them unavailable', async () => {
    const r = fx.di.redis.raw();
    await r.set(SYM_KEY, symbolInfo);
    await r.set(TICKER_KEY, ticker);
    const { status, diagnostics } = await lint();
    expect(status).toBe(200);
    const codes = diagnostics.map((d) => d.code);
    // The block proves the seeded snapshots were genuinely read; the two
    // absences then mean "checked", not "silently skipped".
    expect(codes).toContain('order-below-min-notional');
    expect(codes).not.toContain('filters-unavailable');
    expect(codes).not.toContain('price-unavailable');
  });
});
