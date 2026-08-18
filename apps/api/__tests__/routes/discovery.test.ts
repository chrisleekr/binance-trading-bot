import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredDiscoveryConfig } from '@app/contracts';
import { GLOBAL_KEYS, profileKey, profileRepo } from '@app/db';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';
import { recordPoolCheckouts } from '../_pool-checkouts.js';

/**
 * Integration coverage for the discovery operator-dashboard surface: the GET
 * returns the effective config + scoreboard + gauge, the PATCH writes the
 * config (pause / blocklist), and both stay account-scoped.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const headers = (userId: string): Record<string, string> => ({
  'x-test-user-id': userId,
  'content-type': 'application/json',
});

const fullConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  refreshPeriodMs: 900_000,
  blacklist: [],
  min24hPairVolumeUsd: '500000',
  min24hAssetVolumeUsd: '50000000',
  maxSpreadRatio: '0.003',
  changeMinPercent: '0',
  rankTopPercent: 30,
  rankExcludeTopPercent: 5,
  minAgeDays: 30,
  maxAutoSymbols: 5,
  minHoldMinutes: 120,
  trendConfirm: {
    adxPeriod: 14,
    adxMin: '25',
    emaPeriod: 20,
    volSmaPeriod: 20,
    volMultiple: '1.5',
  },
  ...over,
});

describeIfInfra('discovery router', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('GET returns a disabled default config + zeroed scoreboard/gauge for a fresh profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { enabled: boolean };
      scoreboard: { tradeCount: number; winRate: number };
      gauge: { autoSymbolCount: number };
      universe: unknown;
      activity: unknown[];
    };
    expect(body.config.enabled).toBe(false);
    expect(body.scoreboard.tradeCount).toBe(0);
    expect(body.scoreboard.winRate).toBe(0);
    expect(body.gauge.autoSymbolCount).toBe(0);
    // No cron has scanned this fresh profile yet, and no discovery events logged.
    expect(body.universe).toBeNull();
    expect(body.activity).toEqual([]);
    // No auto symbol holds a position on a fresh profile.
    expect((body as { holdings: unknown[] }).holdings).toEqual([]);
  });

  it('GET /discovery-scoreboard windows the auto trade-archive by period (#504)', async () => {
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const base = {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '100',
      breakdown: {},
      source: 'auto' as const,
    };
    // One win and one loss, both archived last month.
    await p.tradeArchive.insert({
      ...base,
      totalSellQuote: '105',
      profit: '5',
      profitPercent: '5',
      orders: [{ side: 'BUY' }],
      archivedAt: new Date('2026-05-10T00:00:00Z'),
    });
    await p.tradeArchive.insert({
      ...base,
      totalSellQuote: '97',
      profit: '-3',
      profitPercent: '-3',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date('2026-05-11T00:00:00Z'),
    });
    // A manual win — invisible to the auto-attributed top-level fields, but it
    // must surface as its own slice in bySource.
    await p.tradeArchive.insert({
      ...base,
      source: 'manual' as const,
      totalSellQuote: '110',
      profit: '10',
      profitPercent: '10',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date('2026-05-12T00:00:00Z'),
    });
    // A cycle closed under a PREVIOUS quote asset, inside the same window. Every assertion below is written as if this row did not exist, so the scoreboard's quote filter is what holds them: drop it and the magnitudes move by 999. Without this row the suite cannot tell "reads the profile's quote" from "hardcodes USDT" from "does not filter at all", because the fixture profile also settles in USDT.
    await p.tradeArchive.insert({
      ...base,
      symbol: 'ETHBTC',
      baseAsset: 'ETH',
      quoteAsset: 'BTC',
      totalSellQuote: '999',
      profit: '999',
      profitPercent: '999',
      orders: [{ side: 'SELL' }],
      archivedAt: new Date('2026-05-13T00:00:00Z'),
    });

    const url = (period: string): string =>
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery-scoreboard?period=${period}&tz=UTC`;

    interface SourceSlice {
      source: string;
      realizedProfit: string;
      tradeCount: number;
      wins: number;
      losses: number;
      grossProfit: string;
      grossLoss: string;
    }

    // All-time: top-level stays auto-only — one win of two auto rows, net +2.
    const all = await fx.app.request(url('a'), { headers: headers(fx.alice.userId) });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      period: string;
      tradeCount: number;
      winRate: number;
      realizedProfit: string;
      bySource: SourceSlice[];
    };
    expect(allBody.period).toBe('a');
    expect(allBody.tradeCount).toBe(2);
    expect(allBody.winRate).toBe(0.5);
    expect(Number(allBody.realizedProfit)).toBe(2);

    // bySource carries both sources, ordered auto then manual, each with its
    // own win/loss split and gross magnitudes for the band's win% + PF.
    expect(allBody.bySource.map((s) => s.source)).toEqual(['auto', 'manual']);
    const auto = allBody.bySource.find((s) => s.source === 'auto');
    expect(auto).toMatchObject({ tradeCount: 2, wins: 1, losses: 1 });
    expect(Number(auto?.grossProfit)).toBe(5);
    expect(Number(auto?.grossLoss)).toBe(3);
    const manual = allBody.bySource.find((s) => s.source === 'manual');
    expect(manual).toMatchObject({ tradeCount: 1, wins: 1, losses: 0 });
    expect(Number(manual?.realizedProfit)).toBe(10);
    expect(Number(manual?.grossLoss)).toBe(0);

    // Today's window excludes the May rows → empty top-level and empty bySource.
    const day = await fx.app.request(url('d'), { headers: headers(fx.alice.userId) });
    const dayBody = (await day.json()) as {
      tradeCount: number;
      winRate: number;
      bySource: SourceSlice[];
    };
    expect(dayBody.tradeCount).toBe(0);
    expect(dayBody.winRate).toBe(0);
    expect(dayBody.bySource).toEqual([]);
  });

  it('reports only auto symbols that hold a position in `holdings`, with cost basis', async () => {
    // Seed two auto symbols: one with a real position, one subscribed-but-flat.
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await p.profileSymbols.upsert('HOLDUSDT', 'HOLD', { overrideConfig: null });
    await p.profileSymbols.setSource('HOLDUSDT', 'auto');
    await p.avgEntryPrices.upsert('HOLDUSDT', { avgEntryPrice: '2', quantity: '3' });
    await p.profileSymbols.upsert('WAITUSDT', 'WAIT', { overrideConfig: null });
    await p.profileSymbols.setSource('WAITUSDT', 'auto');

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/discovery`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gauge: { autoSymbolCount: number };
      holdings: { symbol: string; quantity: string; quoteCostBasis: string }[];
      autoSymbols: string[];
    };
    // Both are auto; only the one with quantity > 0 appears in holdings.
    expect(body.gauge.autoSymbolCount).toBe(2);
    // The live auto-set carries both, including the flat one (for reconciling
    // a stale universe row against current membership).
    expect([...body.autoSymbols].sort()).toEqual(['HOLDUSDT', 'WAITUSDT']);
    expect(body.holdings).toHaveLength(1);
    const h = body.holdings[0];
    expect(h?.symbol).toBe('HOLDUSDT');
    // numeric(38,18) reads back scale-padded; compare on value, not string form.
    expect(Number(h?.quantity)).toBe(3);
    expect(Number(h?.avgEntryPrice)).toBe(2);
    // quoteCostBasis is computed via decimalMul -> canonical Decimal string.
    expect(h?.quoteCostBasis).toBe('6');
  });

  it('surfaces the per-symbol entry-blocker for an auto candidate in the universe', async () => {
    // Seed an auto symbol whose persisted strategy state carries an
    // entry-blocker, plus a non-auto one. The cron-written universe snapshot has
    // entryBlocker null on every row; the route enriches auto rows from state.
    const p = await profileRepo(fx.di.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await p.profileSymbols.upsert('BLOCKUSDT', 'BLOCK', { overrideConfig: null });
    await p.profileSymbols.setSource('BLOCKUSDT', 'auto');
    await p.symbolStates.upsert('BLOCKUSDT', {
      state: {
        entryBlocker: { reason: 'awaiting-trigger-price', detail: { windowLow: '95' } },
      },
      strategyVersion: 1,
    });
    // A non-auto symbol carrying a blocker must NOT be surfaced (entryBlocker
    // stays null — discovery does not manage non-auto entry).
    await p.profileSymbols.upsert('MANUALUSDT', 'MANUAL', { overrideConfig: null });
    await p.symbolStates.upsert('MANUALUSDT', {
      state: { entryBlocker: { reason: 'technicals-sell' } },
      strategyVersion: 1,
    });

    await fx.di.redis.raw().set(
      GLOBAL_KEYS.discoveryExplain(fx.alice.profileId),
      JSON.stringify({
        computedAtMs: 1_700_000_000_000,
        candidates: [
          {
            symbol: 'BLOCKUSDT',
            gainerScore: '22',
            passed: [
              'quote',
              'assetPolicy',
              'blacklist',
              'liquidity',
              'spread',
              'changeBand',
              'age',
              'trend',
            ],
            failedAt: null,
            disposition: 'added',
          },
          {
            symbol: 'MANUALUSDT',
            gainerScore: '5',
            passed: [
              'quote',
              'assetPolicy',
              'blacklist',
              'liquidity',
              'spread',
              'changeBand',
              'age',
              'trend',
            ],
            failedAt: null,
            disposition: 'rejected',
          },
        ],
      }),
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      universe: {
        candidates: { symbol: string; entryBlocker: { reason: string } | null }[];
      } | null;
    };
    const candidates = body.universe?.candidates ?? [];
    const blocked = candidates.find((c) => c.symbol === 'BLOCKUSDT');
    const manual = candidates.find((c) => c.symbol === 'MANUALUSDT');
    expect(blocked?.entryBlocker?.reason).toBe('awaiting-trigger-price');
    // Non-auto candidate's blocker is not surfaced.
    expect(manual?.entryBlocker).toBeNull();
  });

  it('PATCH writes the config and a subsequent GET reflects it', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery-config`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify(fullConfig({ enabled: true, maxAutoSymbols: 7 })),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).config.enabled).toBe(true);

    const after = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
      {
        headers: headers(fx.alice.userId),
      },
    );
    const body = (await after.json()) as { config: { enabled: boolean; maxAutoSymbols: number } };
    expect(body.config.enabled).toBe(true);
    expect(body.config.maxAutoSymbols).toBe(7);
  });

  it('PATCH rejects a malformed config (422 from the body validator)', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery-config`,
      {
        method: 'PATCH',
        headers: headers(fx.alice.userId),
        body: JSON.stringify(fullConfig({ maxAutoSymbols: -1 })),
      },
    );
    expect(res.status).toBe(422);
  });

  it('GET falls back to safe defaults + configInvalid when the stored config is out of range', async () => {
    // Simulate an out-of-band DB edit that wrote a value the schema rejects
    // (minAgeDays is capped at 40). setDiscoveryConfig writes raw JSON with no
    // re-validation, so this bypasses the PATCH body validator exactly as a
    // direct `jsonb_set` would.
    const p = await profileRepo(fx.di.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await p.profile.setDiscoveryConfig(
      fullConfig({ minAgeDays: 90 }) as unknown as StoredDiscoveryConfig,
    );

    const res = await fx.app.request(
      `/api/accounts/${fx.bob.accountId}/profiles/${fx.bob.profileId}/discovery`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configInvalid: boolean;
      config: { enabled: boolean; minAgeDays: number };
    };
    expect(body.configInvalid).toBe(true);
    // Defaults stand in for the unparseable config, and discovery reads paused.
    expect(body.config.enabled).toBe(false);
    expect(body.config.minAgeDays).toBe(30);
  });

  // Momentum hangs its account cap at the config root with a `percentOfAccount`
  // mode, where trailing-trade nests `buy.accountCap` with mode `percent`. The
  // gauge duck-reads the cap (invariant #1 forbids importing the strategy), and
  // it used to match only TT's shape — so a momentum profile whose reserve cap
  // was actively downsizing entries displayed "no cap" to the operator.
  it('reports the account cap for a momentum profile whose cap lives at the config root', async () => {
    const momentum = buildStrategyRegistry().get('momentum');
    if (!momentum) throw new Error('expected momentum to be registered');
    const MOMENTUM_PROFILE = '00000000-0000-4000-8000-00000000a501';
    await fx.di.pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'momentum cap demo', 'momentum', $3, $4, '{}')`,
      [
        MOMENTUM_PROFILE,
        fx.alice.accountId,
        momentum.version,
        JSON.stringify({ accountCap: { mode: 'percentOfAccount', percent: '0.5' } }),
      ],
    );
    // Equity = quote cash + deployed cost-basis. No positions, so 1000 USDT of
    // free cash is the whole equity and the 50% cap resolves to 500.
    await fx.di.redis
      .raw()
      .set(
        profileKey({ accountId: fx.alice.accountId, profileId: MOMENTUM_PROFILE }, 'accountInfo'),
        JSON.stringify({ balances: { USDT: { free: '1000', locked: '0' } } }),
      );

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${MOMENTUM_PROFILE}/discovery`,
      { headers: headers(fx.alice.userId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gauge: { maxAccountExposureQuote: string | null } };
    expect(body.gauge.maxAccountExposureQuote).toBe('500');
  });

  it('serves the dashboard on one pooled connection', async () => {
    // The api shares a pool of ten. This route resolves its dashboard by firing its reads concurrently, and node-postgres takes one pooled connection per concurrent query, so a single dashboard load holds most of the pool while it runs and every other route queues behind it. Two operators on two tabs is then an app-wide stall, not a slow panel.
    // Asserted from the pool rather than from the response: peak concurrent checkouts is the property that caps the blast radius, and it is invisible in a body that renders correctly either way.
    const { peak } = await recordPoolCheckouts(fx.di.pool, async () => {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
        { headers: headers(fx.alice.userId) },
      );
      expect(res.status).toBe(200);
    });

    // Not "at most one query" — the reads may be as many as they like, as long as one request cannot occupy more than one connection at a time.
    expect(peak).toBe(1);
  });

  it('denies cross-account access to another user profile', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery`,
      {
        headers: headers(fx.bob.userId),
      },
    );
    expect(res.status).toBe(404);
  });

  it('denies a cross-account write to another user discovery config', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/discovery-config`,
      {
        method: 'PATCH',
        headers: headers(fx.bob.userId),
        body: JSON.stringify(fullConfig({ enabled: true })),
      },
    );
    expect(res.status).toBe(404);
  });
});
