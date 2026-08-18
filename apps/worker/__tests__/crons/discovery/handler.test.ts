import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { asAccountId, asProfileId, asUserId, DiscoveryConfigSchema } from '@app/contracts';
import type { Ticker24hrDto } from '@app/binance';
import type { ActiveProfile } from '../../../src/profile-manager/profile-manager.js';
import { discoveryHandler, withTestModeFallback } from '../../../src/crons/discovery/handler.js';
import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';
import {
  createAssetPolicyResolver,
  type AssetPolicy,
} from '../../../src/crons/discovery/asset-policy.js';
import type { ProfileWakeContext } from '../../../src/crons/discovery/handler.js';
import { readAccountPermissions } from '../../../src/lib/account-permissions.js';

const NOW = 1_700_000_000_000;

/** exchangeInfo facts for one fixture symbol; base/quote are required, so a fixture states its own split. */
const adm = (baseAsset: string, quoteAsset = 'USDT', status = 'TRADING'): SymbolAdmission => ({
  status,
  baseAsset,
  quoteAsset,
});

/** A usable classification: non-empty veto set, and a symbol set the handler's admission fixtures match. */
const assetPolicy = (symbols: readonly string[]): AssetPolicy => ({
  stablecoinOrFiatBases: new Set(['RLUSD', 'ZWL']),
  taggedStablecoinBases: new Set(['RLUSD']),
  fiatQuoteAssets: new Set(['ZWL']),
  tradingSymbols: new Set(symbols),
});

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
    fetchSymbolAdmission: vi.fn(
      async (_mode: string) => new Map<string, SymbolAdmission>([['AAAUSDT', adm('AAA')]]),
    ),
    fetchAccountPermissions: vi.fn(async () => ['SPOT']),
    getAssetPolicy: vi.fn(async () => assetPolicy(['AAAUSDT'])),
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
      expect.objectContaining({
        admissionBySymbol: expect.any(Map),
        liveAdmission: expect.any(Map),
        assetPolicy: expect.objectContaining({ stablecoinOrFiatBases: expect.any(Set) }),
        accountPermissions: ['SPOT'],
      }),
    );
  });

  it('resolves the account permission tags once per account, shared across its profiles', async () => {
    // The tags belong to the key pair, so two profiles on one account must not
    // each pay a Redis read for the same answer.
    const fetchAccountPermissions = vi.fn(async () => ['SPOT']);
    const runForProfile = vi.fn(
      async (
        _p,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        ctx: ProfileWakeContext,
      ) => {
        expect(ctx.accountPermissions).toEqual(['SPOT']);
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({
        listActive: () => [profile('1'), profile('2')],
        fetchAccountPermissions,
        runForProfile,
      }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2);
    expect(fetchAccountPermissions).toHaveBeenCalledTimes(1);
  });

  it('a Redis fault on the permission read costs the cut, not the profiles', async () => {
    // The production reader degrades a fault to the unknown list rather than
    // rejecting. That matters here because this promise is memoized per account
    // for the whole wake: a rejection would replay to every remaining profile on
    // the account and skip each one, so a Redis blip would cost the whole wake.
    const fetchAccountPermissions = vi.fn(() =>
      readAccountPermissions(
        {
          get: async () => {
            throw new Error('redis unreachable');
          },
        },
        logger,
        asAccountId('00000000-0000-4000-8000-0000000000aa'),
        'cron discovery',
      ),
    );
    const seen: (readonly string[])[] = [];
    const runForProfile = vi.fn(
      async (
        _p,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        ctx: ProfileWakeContext,
      ) => {
        seen.push(ctx.accountPermissions);
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({
        listActive: () => [profile('1'), profile('2')],
        fetchAccountPermissions,
        runForProfile,
      }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2);
    // Empty ⇒ unknown ⇒ the permission cut is disabled for the wake, not a refusal.
    expect(seen).toEqual([[], []]);
  });

  it('fail-safe: a throwing profile is caught and does not abort the others', async () => {
    // A local warn mock, not the module-scoped `logger`: that one accumulates calls across the whole file (nothing clears it between tests), and an earlier case here already drives a warn through it. Asserting on the shared mock therefore passes even if the catch below stops logging entirely, which is the one thing this test exists to prevent.
    const warn = vi.fn();
    const runForProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error('binance down'))
      .mockResolvedValueOnce({ added: 1, removed: 0 });
    await discoveryHandler(
      deps({
        listActive: () => [profile('1'), profile('2')],
        runForProfile,
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2); // second profile still ran
    expect(warn).toHaveBeenCalledTimes(1);
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

  it('builds the symbol-admission map once per wake, shared across same-mode profiles (#635)', async () => {
    // Both profiles resolve to the same mode (the default resolveBinanceMode →
    // 'live'), so the per-mode memo collapses them to a single scan.
    const fetchSymbolAdmission = vi.fn(
      async (_mode: string) => new Map<string, SymbolAdmission>([['AAAUSDT', adm('AAA')]]),
    );
    const runForProfile = vi.fn(async () => ({ added: 0, removed: 0 }));
    await discoveryHandler(
      deps({ listActive: () => [profile('1'), profile('2')], fetchSymbolAdmission, runForProfile }),
    )({} as Job);
    expect(runForProfile).toHaveBeenCalledTimes(2);
    expect(fetchSymbolAdmission).toHaveBeenCalledTimes(1); // one scan, shared
  });

  it('scopes the symbol-admission map to each profile-account binance_mode (#662)', async () => {
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
    const fetchSymbolAdmission = vi.fn(async (mode?: string) =>
      mode === 'test'
        ? new Map<string, SymbolAdmission>([['BTCUSDT', adm('BTC')]])
        : new Map<string, SymbolAdmission>([
            ['BTCUSDT', adm('BTC')],
            ['REUSDT', adm('RE')],
          ]),
    );
    // Capture each profile's wake context, keyed by profile identity, so the map
    // it was actually given is inspectable.
    const captured = new Map<string, ProfileWakeContext>();
    const runForProfile = vi.fn(
      async (
        p: ActiveProfile,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        ctx: ProfileWakeContext,
      ) => {
        const key = p === pTest ? 'p-test' : p === pTest2 ? 'p-test2' : 'p-live';
        captured.set(key, ctx);
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({
        listActive: () => [pLive, pTest, pTest2],
        resolveBinanceMode,
        fetchSymbolAdmission,
        runForProfile,
      }),
    )({} as Job);

    // The testnet profiles' admission maps exclude the live-only REUSDT; the live
    // profile's includes it.
    expect(captured.get('p-test')!.admissionBySymbol.has('REUSDT')).toBe(false);
    expect(captured.get('p-test2')!.admissionBySymbol.has('REUSDT')).toBe(false);
    expect(captured.get('p-live')!.admissionBySymbol.has('REUSDT')).toBe(true);
    // Their cross-check reference is the LIVE map regardless: the classification
    // covers the live exchange, and checking it against a testnet subset would
    // pass while the feed was gutted.
    expect(captured.get('p-test')!.liveAdmission.has('REUSDT')).toBe(true);
    expect(captured.get('p-live')!.liveAdmission.has('REUSDT')).toBe(true);
    // Each mode's exchangeInfo status set was fetched under its own mode.
    expect(fetchSymbolAdmission).toHaveBeenCalledWith('test');
    expect(fetchSymbolAdmission).toHaveBeenCalledWith('live');
    // Distinct modes fetch once each; the repeated 'test' mode collapses to one.
    expect(fetchSymbolAdmission).toHaveBeenCalledTimes(2);
  });

  it('fails closed on an empty admission map, whatever the profile mode', async () => {
    // Was test-mode-only. Test-mode candidates come from the live ticker feed, so
    // an empty status map re-admits live-only symbols — but the live half was
    // never safe either: with no admission map there is no status cut, no
    // base/quote split, and no base to classify, so a "still runs" live profile
    // would score the raw ticker feed. One rule now covers both, because two
    // spellings of it is how the live half stayed open.
    const pLive = profile('p-live', 'acct-live');
    const pTest = profile('p-test', 'acct-test');
    const resolveBinanceMode = vi.fn(async (p: ActiveProfile) =>
      p.accountId === ('acct-test' as never) ? 'test' : 'live',
    );
    const fetchSymbolAdmission = vi.fn(async () => new Map<string, SymbolAdmission>()); // unprimed
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
        fetchSymbolAdmission,
        runForProfile,
      }),
    )({} as Job);

    expect(ran).toEqual([]); // neither profile ran
    expect(runForProfile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2); // one per skipped profile
  });

  it('never touches the asset-policy feed on a wake with nothing due', async () => {
    // Composed with the REAL resolver, not a stub: this is what keeps the
    // hermetic e2e stack from reaching www.binance.com, and a stubbed accessor
    // would prove only that the stub was not called.
    const fetchImpl = vi.fn(async () => {
      throw new Error('the product feed must not be reached on a gated wake');
    });
    const getAssetPolicy = createAssetPolicyResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: { nowMs: () => NOW },
      logger,
    });
    const runForProfile = vi.fn(async () => ({ added: 0, removed: 0 }));
    await discoveryHandler(
      deps({
        listActive: () => [profile('1'), profile('2')],
        shouldRun: async () => false,
        getAssetPolicy,
        runForProfile,
      }),
    )({} as Job);
    expect(runForProfile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips every due profile when the classification cannot be fetched, and keeps the wake alive', async () => {
    // The accessor rejects on a failed refresh rather than serving a stale
    // snapshot, so this is the shape a feed outage actually takes. The per-profile
    // catch has to absorb it: a cycle that cannot classify must add and remove
    // nothing, and must not take the wake down with it.
    const getAssetPolicy = vi.fn(async () => {
      throw new Error('product feed unreachable');
    });
    const runForProfile = vi.fn(async () => ({ added: 0, removed: 0 }));
    const warn = vi.fn();
    await discoveryHandler(
      deps({
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
        listActive: () => [profile('1'), profile('2')],
        getAssetPolicy,
        runForProfile,
      }),
    )({} as Job);
    expect(runForProfile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2); // one per profile, none aborted the loop
    // Once per due profile, NOT once per wake. There is deliberately no negative
    // cache: a failed fetch is not an answer to remember, and a later profile in
    // the same wake may well be the one that succeeds. Anyone adding failure
    // caching has to change this number, which is the point of asserting it.
    expect(getAssetPolicy).toHaveBeenCalledTimes(2);
  });

  it('fetches the asset classification at most once per wake, shared across due profiles', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      // Required since the fetch path reads `content-length`: a stub without
      // headers throws inside the resolver, which the per-profile catch would
      // then swallow into a green-looking wake that ran no profile at all.
      headers: new Headers(),
      json: async () => ({
        data: [
          { s: 'AAAUSDT', st: 'TRADING', b: 'AAA', q: 'USDT', pm: 'USDT', pn: 'USDT', tags: [] },
          {
            s: 'RLUSDUSDT',
            st: 'TRADING',
            b: 'RLUSD',
            q: 'USDT',
            pm: 'USDT',
            pn: 'USDT',
            tags: ['stablecoin'],
          },
        ],
      }),
    }));
    const getAssetPolicy = createAssetPolicyResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: { nowMs: () => NOW },
      logger,
    });
    const seen: AssetPolicy[] = [];
    const runForProfile = vi.fn(
      async (
        _p,
        _cfg,
        _quoteAsset,
        _name,
        _now,
        _getAllTickers: () => Promise<unknown>,
        ctx: ProfileWakeContext,
      ) => {
        seen.push(ctx.assetPolicy);
        return { added: 0, removed: 0 };
      },
    );
    await discoveryHandler(
      deps({
        listActive: () => [profile('1'), profile('2'), profile('3')],
        getAssetPolicy,
        runForProfile,
      }),
    )({} as Job);
    expect(seen).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Every profile scored against the same classification, not three reads of a
    // feed that could have moved between them.
    expect(seen.every((p) => p === seen[0])).toBe(true);
    expect([...(seen[0] as AssetPolicy).stablecoinOrFiatBases]).toEqual(['RLUSD']);
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
