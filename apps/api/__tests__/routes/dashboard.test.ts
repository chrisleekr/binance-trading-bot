import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/**
 * Integration coverage for the profile-dashboard entry-blocker enrichment: each
 * symbol row must carry its persisted entry-blocker (or null), and the
 * enrichment must read every symbol's state in one batch query (no N+1).
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

interface DashboardSymbol {
  symbol: string;
  enabled: boolean;
  entryBlocker: { reason: string; detail?: Record<string, unknown> } | null;
}

describeIfInfra('dashboard router — entry-blocker enrichment', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // Attach three symbols directly so the dashboard projection lists them.
    // BLOCKED carries an entry-blocker state, WATCH has no state row at all,
    // PAUSED is disabled (a disable-action key) but still enriched.
    for (const symbol of ['BLOCKEDUSDT', 'WATCHUSDT', 'PAUSEDUSDT']) {
      await fx.di.pool.query(
        `insert into profile_symbols (profile_id, symbol, base_asset, source)
         values ($1, $2, left($2, length($2) - 4), 'manual')`,
        [fx.alice.profileId, symbol],
      );
    }
    // Persisted strategy state with an entry-blocker for BLOCKEDUSDT only.
    await fx.di.pool.query(
      `insert into symbol_states (profile_id, symbol, state, strategy_version)
       values ($1, $2, $3::jsonb, '1.0.0')`,
      [
        fx.alice.profileId,
        'BLOCKEDUSDT',
        JSON.stringify({ entryBlocker: { reason: 'awaiting-trigger-price', detail: {} } }),
      ],
    );
    // Disable PAUSEDUSDT via the disable-action key the projection reads.
    await fx.di.redis
      .raw()
      .set(
        `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:disable-action:PAUSEDUSDT`,
        '1',
      );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const fetchSymbols = async (): Promise<DashboardSymbol[]> => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/dashboard`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { symbols: DashboardSymbol[] };
    return body.symbols;
  };

  it('surfaces entryBlocker for a symbol whose state has one', async () => {
    const blocked = (await fetchSymbols()).find((s) => s.symbol === 'BLOCKEDUSDT');
    expect(blocked?.entryBlocker).toEqual({ reason: 'awaiting-trigger-price', detail: {} });
  });

  it('reports null entryBlocker for a symbol with no blocker state', async () => {
    const watch = (await fetchSymbols()).find((s) => s.symbol === 'WATCHUSDT');
    expect(watch?.entryBlocker).toBe(null);
  });

  it('still enriches a disabled symbol (entryBlocker null when no state)', async () => {
    const paused = (await fetchSymbols()).find((s) => s.symbol === 'PAUSEDUSDT');
    expect(paused?.enabled).toBe(false);
    expect(paused?.entryBlocker).toBe(null);
  });

  it('reads all symbol states in exactly one query (no N+1)', async () => {
    // Attach enough symbols to make an N+1 obvious, then assert findBySymbols
    // fires once for the whole profile. Spy before the request so the per-
    // request profileRepo bind captures the spied module function.
    const extra = Array.from({ length: 7 }, (_, i) => `BULK${i}USDT`);
    for (const symbol of extra) {
      await fx.di.pool.query(
        `insert into profile_symbols (profile_id, symbol, base_asset, source)
         values ($1, $2, left($2, length($2) - 4), 'manual')`,
        [fx.alice.profileId, symbol],
      );
    }
    // Bust the dashboard cache so this read recomputes the symbol list.
    await fx.di.redis
      .raw()
      .del(`tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:dashboard:cache`);

    // Count the Postgres queries that touch symbol_states for this request.
    // The enrichment must fire exactly one batch select, not one per symbol.
    const querySpy = vi.spyOn(fx.di.pool, 'query');
    try {
      const symbols = await fetchSymbols();
      expect(symbols.length).toBeGreaterThanOrEqual(10);
      const symbolStateQueries = querySpy.mock.calls.filter((call) => {
        const text = typeof call[0] === 'string' ? call[0] : (call[0] as { text?: string }).text;
        return typeof text === 'string' && text.includes('symbol_states');
      });
      expect(symbolStateQueries).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
    }
  });
});
