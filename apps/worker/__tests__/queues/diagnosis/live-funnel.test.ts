// The live re-probe's bail-out rules.
//
// Every one of them returns null rather than throwing, because the probe is an
// enhancement over the stored scan: losing it downgrades the answer's freshness
// and must never fail the investigation the operator is waiting on.

import { describe, expect, it, vi } from 'vitest';
import { DiscoveryConfigSchema } from '@app/contracts';
import type { BinanceMode, Ticker24hrDto } from '@app/binance';
import type { Logger } from 'pino';

import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';
import type { AssetPolicy } from '../../../src/crons/discovery/asset-policy.js';
import { probeLiveFunnel, type LiveFunnelDeps } from '../../../src/queues/diagnosis/live-funnel.js';

const stored = DiscoveryConfigSchema.parse({});

/** exchangeInfo facts for one fixture symbol; base/quote are required, so a fixture states its own split. */
const adm = (baseAsset: string, over: Partial<SymbolAdmission> = {}): SymbolAdmission => ({
  status: 'TRADING',
  baseAsset,
  quoteAsset: 'USDT',
  ...over,
});

/** An admission map plus the matching classification, derived from one symbol list so the completeness cross-check passes. */
const primed = (
  entries: readonly (readonly [string, SymbolAdmission])[],
): { admission: Map<string, SymbolAdmission>; policy: AssetPolicy } => ({
  admission: new Map(entries),
  policy: {
    stablecoinOrFiatBases: new Set(['RLUSD', 'ZWL']),
    taggedStablecoinBases: new Set(['RLUSD']),
    fiatQuoteAssets: new Set(['ZWL']),
    tradingSymbols: new Set(entries.map(([symbol]) => symbol)),
  },
});

const DEFAULT_PRIMED = primed([
  ['AAAUSDT', adm('AAA')],
  ['ETHUSDT', adm('ETH')],
  ['BNBUSDT', adm('BNB')],
]);

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

const makeDeps = (over: Partial<LiveFunnelDeps> = {}): LiveFunnelDeps => ({
  getAllTickers: vi.fn(async () => []),
  getKlines: vi.fn(async () => []),
  mode: 'live' as BinanceMode,
  symbolAdmission: vi.fn(async () => DEFAULT_PRIMED.admission),
  liveSymbolAdmission: vi.fn(async () => DEFAULT_PRIMED.admission),
  assetPolicy: vi.fn(async () => DEFAULT_PRIMED.policy),
  accountPermissions: vi.fn(async () => []),
  rotatableSymbols: [],
  pinnedSymbols: [],
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  nowMs: 1_700_000_000_000,
  ...over,
});

describe('probeLiveFunnel', () => {
  it('fails closed when exchangeInfo is not primed, in either mode', async () => {
    // An empty admission map leaves the universe UNFILTERED, which is a
    // confident second opinion about a universe the profile does not trade. It
    // was already the rule on testnet; it is no less wrong on live, where the
    // unfiltered set carries every delisted pair and every stablecoin, and the
    // cron itself now refuses to run on it.
    for (const mode of ['test', 'live'] as const) {
      const deps = makeDeps({ mode, symbolAdmission: async () => new Map() });
      expect(await probeLiveFunnel(deps, stored, 'USDT')).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalled();
    }
  });

  it('returns null rather than a funnel the cron never had when the classification is untrustworthy', async () => {
    // The probe exists so its ladder and the cron's agree. A classification the
    // cron would have refused must not produce a ladder here either, or the
    // operator is shown a measurement the bot never took.
    const deps = makeDeps({
      assetPolicy: async () => ({
        // The merged set is non-empty; only the stablecoin route is dead. The
        // cron refuses this, so the probe must refuse it too, or it reports a
        // ladder the bot never produced.
        stablecoinOrFiatBases: new Set(['ZWL']),
        taggedStablecoinBases: new Set<string>(),
        fiatQuoteAssets: new Set(['ZWL']),
        tradingSymbols: new Set(['AAAUSDT']),
      }),
    });
    expect(await probeLiveFunnel(deps, stored, 'USDT')).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('returns null when the quote asset has no USD reference market', async () => {
    // Every volume floor is denominated in USD, so an unknown scale makes the
    // whole ladder meaningless rather than merely imprecise.
    expect(await probeLiveFunnel(makeDeps(), stored, 'TRY')).toBeNull();
  });

  it('applies the account permission cut, so the probe cannot report a candidate the cron never admits', async () => {
    // The permission cut only runs when the admission map is POPULATED, so the
    // empty-map default leaves this branch dead in every other case here. With
    // both inputs real, a symbol the account cannot trade must never reach the
    // funnel: reporting it would show the operator a candidate they can never get.
    const accountPermissions = vi.fn(async () => ['SPOT']);
    const deps = makeDeps({
      getAllTickers: async () => [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
      ...(() => {
        const p = primed([
          ['ETHUSDT', adm('ETH', { permissionSets: [['SPOT']] })],
          ['CRCLBUSDT', adm('CRCLB', { permissionSets: [['TRD_GRP_005']] })],
        ]);
        return {
          symbolAdmission: async () => p.admission,
          liveSymbolAdmission: async () => p.admission,
          assetPolicy: async () => p.policy,
        };
      })(),
      accountPermissions,
    });
    const funnel = await probeLiveFunnel(deps, stored, 'USDT');
    expect(accountPermissions).toHaveBeenCalled();
    // Both are TRADING and quote-matched; only the permission cut separates them.
    expect(funnel?.universe).toBe(1);
  });

  // A symbol fat enough to clear every ticker-stage floor, so it reaches the
  // shortlist and becomes a kline target. Without one the kline cases below
  // would pass vacuously, having fetched nothing.
  const liquid = (symbol: string): Ticker24hrDto =>
    ticker({
      symbol,
      volume: '1000000',
      quoteVolume: '900000000',
      lastPrice: '100',
      highPrice: '112',
      lowPrice: '99',
      openPrice: '100',
      bidPrice: '99.99',
      askPrice: '100.01',
      priceChangePercent: '12',
    });

  it('returns null when no kline window arrives, rather than a ladder of zeroes', async () => {
    // `oldEnough` answers false for a symbol with no window, so losing EVERY
    // window scores the whole shortlist as failing the age cut. That is a
    // candidate ladder of straight zeroes presented as a live reading, blaming
    // a filter that never ran. The stored scan is the honest answer.
    const getKlines = vi.fn(async () => {
      throw new Error('binance down');
    });
    const deps = makeDeps({ getAllTickers: async () => [liquid('ETHUSDT')], getKlines });

    expect(await probeLiveFunnel(deps, stored, 'USDT')).toBeNull();
    // Proves the shortlist was non-empty; otherwise this asserts nothing.
    expect(getKlines).toHaveBeenCalled();
  });

  it('still answers when only some windows are lost', async () => {
    // The partial case must stay a partial answer, not get swept into the
    // bail-out above: most of the picture still beats none of it.
    const getKlines = vi.fn(async (symbol: string) => {
      if (symbol === 'ETHUSDT') throw new Error('binance down');
      return [];
    });
    const deps = makeDeps({
      getAllTickers: async () => [liquid('ETHUSDT'), liquid('BNBUSDT')],
      getKlines,
    });

    const funnel = await probeLiveFunnel(deps, stored, 'USDT');
    expect(funnel).not.toBeNull();
    // Only the symbol that got a window counts as probed. The other one is
    // scored as failing the age cut for want of data, and counting it here
    // would render a Binance outage as a filter the operator should loosen.
    expect(funnel?.probed).toBe(1);
  });

  it('returns null rather than throwing when the ticker fetch fails', async () => {
    const deps = makeDeps({
      getAllTickers: async () => {
        throw new Error('binance down');
      },
    });
    expect(await probeLiveFunnel(deps, stored, 'USDT')).toBeNull();
  });
});
