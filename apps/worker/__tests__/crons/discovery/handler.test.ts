import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { asProfileId, asUserId, DiscoveryConfigSchema } from '@app/contracts';
import type { Ticker24hrDto } from '@app/binance';
import type { ActiveProfile } from '../../../src/profile-manager/profile-manager.js';
import { discoveryHandler, withTestModeFallback } from '../../../src/crons/discovery/handler.js';

const NOW = 1_700_000_000_000;

const profile = (id: string, accountId = 'acct-default'): ActiveProfile => ({
  profileId: asProfileId(`00000000-0000-4000-8000-${id.padStart(12, '0')}`),
  userId: asUserId('00000000-0000-4000-8000-000000000099'),
  accountId: accountId as never,
  candleInterval: '1h',
  symbols: [],
  technicalsIntervals: [],
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const ticker = (over: Partial<Ticker24hrDto>): Ticker24hrDto => ({
  symbol: 'AAAUSDT',
  lastPrice: '1',
  priceChange: '0',
  priceChangePercent: '10',
  highPrice: '1',
  lowPrice: '1',
  openPrice: '1',
  volume: '1',
  quoteVolume: '1',
  bidPrice: '1',
  askPrice: '1',
  ...over,
});

const permissiveConfig = () =>
  DiscoveryConfigSchema.parse({
    enabled: true,
    minAgeDays: 1,
    maxAutoSymbols: 5,
    minHoldMinutes: 60,
    min24hPairVolumeUsd: '1',
    min24hAssetVolumeUsd: '1',
    maxSpreadRatio: '1',
    changeMinPercent: '0',
    rankTopPercent: 100,
    rankExcludeTopPercent: 0,
    trendConfirm: {
      adxPeriod: 2,
      adxMin: '0',
      emaPeriod: 2,
      volSmaPeriod: 2,
      volMultiple: '0.0001',
    },
  });

describe('discoveryHandler', () => {
  const deps = (over: Partial<Parameters<typeof discoveryHandler>[0]>) => ({
    logger,
    listActive: () => [profile('1')],
    loadConfig: async () => ({ cfg: permissiveConfig(), quoteAsset: 'USDT', name: 'Alpha' }),
    shouldRun: async () => true,
    runForProfile: vi.fn(async () => ({ added: 1, removed: 0 })),
    fetchAllTickers: vi.fn(async () => [ticker({ symbol: 'AAAUSDT' })]),
    fetchSymbolStatuses: vi.fn(
      async (_mode: string) => new Map<string, string>([['AAAUSDT', 'TRADING']]),
    ),
    resolveBinanceMode: vi.fn(async () => 'live'),
    clock: { nowMs: () => NOW },
    ...over,
  });

  it('skips a profile with no/disabled discovery config', async () => {
    const runForProfile = vi.fn(async () => ({ added: 0, removed: 0 }));
    await discoveryHandler(deps({ loadConfig: async () => null, runForProfile }))({} as Job);
    expect(runForProfile).not.toHaveBeenCalled();

    const disabled = DiscoveryConfigSchema.parse({ enabled: false });
    const run2 = vi.fn(async () => ({ added: 0, removed: 0 }));
    await discoveryHandler(
      deps({
        loadConfig: async () => ({ cfg: disabled, quoteAsset: 'USDT', name: 'Alpha' }),
        runForProfile: run2,
      }),
    )({} as Job);
    expect(run2).not.toHaveBeenCalled();
  });

  it('skips when the refresh period has not elapsed', async () => {
    const runForProfile = vi.fn(async () => ({ added: 0, removed: 0 }));
    await discoveryHandler(deps({ shouldRun: async () => false, runForProfile }))({} as Job);
    expect(runForProfile).not.toHaveBeenCalled();
  });

  it('runs an enabled, due profile and forwards the profile name', async () => {
    const runForProfile = vi.fn(async () => ({ added: 2, removed: 1 }));
    await discoveryHandler(deps({ runForProfile }))({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(1);
    // The name reaches runForProfile so its notify wrapper can prefix it.
    expect(runForProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'USDT',
      'Alpha',
      NOW,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('fail-safe: a throwing profile is caught and does not abort the others', async () => {
    const runForProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error('binance down'))
      .mockResolvedValueOnce({ added: 1, removed: 0 });
    await discoveryHandler(deps({ listActive: () => [profile('1'), profile('2')], runForProfile }))(
      {} as Job,
    );
    expect(runForProfile).toHaveBeenCalledTimes(2); // second profile still ran
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fetches the all-symbols ticker once per wake, shared across profiles', async () => {
    const fetchAllTickers = vi.fn(async () => [ticker({ symbol: 'AAAUSDT' })]);
    // Each profile pulls tickers through the shared getter (as the real port does).
    const runForProfile = vi.fn(
      async (_p, _cfg, _quoteAsset, _name, _now, getAllTickers: () => Promise<unknown>) => {
        await getAllTickers();
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({ listActive: () => [profile('1'), profile('2')], fetchAllTickers, runForProfile }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2);
    expect(fetchAllTickers).toHaveBeenCalledTimes(1); // one fetch, shared
  });

  it('builds the symbol-status map once per wake, shared across same-mode profiles (#635)', async () => {
    // Both profiles resolve to the same mode (the default resolveBinanceMode →
    // 'live'), so the per-mode memo collapses them to a single scan.
    const fetchSymbolStatuses = vi.fn(
      async (_mode: string) => new Map<string, string>([['AAAUSDT', 'TRADING']]),
    );
    // Each profile resolves statuses through the shared getter, as the real port does.
    const runForProfile = vi.fn(
      async (
        _p,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        getSymbolStatuses: () => Promise<ReadonlyMap<string, string>>,
      ) => {
        await getSymbolStatuses();
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({ listActive: () => [profile('1'), profile('2')], fetchSymbolStatuses, runForProfile }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2);
    expect(fetchSymbolStatuses).toHaveBeenCalledTimes(1); // one scan, shared
  });

  it('scopes the symbol-status admission map to each profile-account binance_mode (#662)', async () => {
    // Three profiles: one live, two testnet (distinct accounts). The admission
    // map must be resolved per-mode: a testnet profile must never be admitted
    // against live-only symbols (REUSDT here) that do not exist on testnet, or
    // every one of its ticks DLQs on an unknown symbol. The per-mode memo must
    // fetch each distinct mode once and collapse the repeated 'test' mode to a
    // single fetch (2 fetches for {live, test, test}).
    const pLive = profile('p-live', 'acct-live');
    const pTest = profile('p-test', 'acct-test');
    const pTest2 = profile('p-test2', 'acct-test2');
    const testAccounts = new Set(['acct-test', 'acct-test2']);
    const resolveBinanceMode = vi.fn(async (p: ActiveProfile) =>
      testAccounts.has(p.accountId as never as string) ? 'test' : 'live',
    );
    const fetchSymbolStatuses = vi.fn(async (mode?: string) =>
      mode === 'test'
        ? new Map<string, string>([['BTCUSDT', 'TRADING']])
        : new Map<string, string>([
            ['BTCUSDT', 'TRADING'],
            ['REUSDT', 'TRADING'],
          ]),
    );
    // Per call, capture the profile's 7th arg (the getSymbolStatuses thunk) keyed
    // by profile identity so each profile's resolved admission map is inspectable.
    const captured = new Map<string, () => Promise<ReadonlyMap<string, string>>>();
    const runForProfile = vi.fn(
      async (
        p: ActiveProfile,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        getSymbolStatuses: () => Promise<ReadonlyMap<string, string>>,
      ) => {
        const key = p === pTest ? 'p-test' : p === pTest2 ? 'p-test2' : 'p-live';
        captured.set(key, getSymbolStatuses);
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({
        listActive: () => [pLive, pTest, pTest2],
        resolveBinanceMode,
        fetchSymbolStatuses,
        runForProfile,
      }),
    )({} as Job);

    // The testnet profiles' admission maps exclude the live-only REUSDT; the live
    // profile's includes it.
    expect((await captured.get('p-test')!()).has('REUSDT')).toBe(false);
    expect((await captured.get('p-test2')!()).has('REUSDT')).toBe(false);
    expect((await captured.get('p-live')!()).has('REUSDT')).toBe(true);
    // Each mode's exchangeInfo status set was fetched under its own mode.
    expect(fetchSymbolStatuses).toHaveBeenCalledWith('test');
    expect(fetchSymbolStatuses).toHaveBeenCalledWith('live');
    // Distinct modes fetch once each; the repeated 'test' mode collapses to one.
    expect(fetchSymbolStatuses).toHaveBeenCalledTimes(2);
  });

  it('fails closed on an empty admission map for a test-mode profile, but stays open for live (#662)', async () => {
    // Test-mode candidates come from the live ticker feed, so an empty status map
    // is the wrong direction to fail open — it re-admits live-only symbols. Skip
    // the test profile; a live profile with the same empty map still runs (#635).
    const pLive = profile('p-live', 'acct-live');
    const pTest = profile('p-test', 'acct-test');
    const resolveBinanceMode = vi.fn(async (p: ActiveProfile) =>
      p.accountId === ('acct-test' as never) ? 'test' : 'live',
    );
    const fetchSymbolStatuses = vi.fn(async () => new Map<string, string>()); // unprimed
    const ran: string[] = [];
    const runForProfile = vi.fn(async (p: ActiveProfile) => {
      ran.push(p === pTest ? 'p-test' : 'p-live');
      return { added: 0, removed: 0 };
    });
    const warn = vi.fn();
    await discoveryHandler(
      deps({
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
        listActive: () => [pLive, pTest],
        resolveBinanceMode,
        fetchSymbolStatuses,
        runForProfile,
      }),
    )({} as Job);

    expect(ran).toEqual(['p-live']); // test profile skipped, live profile ran
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('withTestModeFallback', () => {
  it('defaults a null (unresolved) account mode to the most-restrictive testnet universe', () => {
    expect(withTestModeFallback(null)).toBe('test');
  });
  it('passes a resolved mode through unchanged', () => {
    expect(withTestModeFallback('live')).toBe('live');
    expect(withTestModeFallback('test')).toBe('test');
  });
});
