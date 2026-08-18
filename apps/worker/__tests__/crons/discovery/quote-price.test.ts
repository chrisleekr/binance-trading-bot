import { describe, expect, it, vi } from 'vitest';
import type { Ticker24hrDto } from '@app/binance';
import { Decimal } from '@app/money';
import type { AssetPolicy } from '../../../src/crons/discovery/asset-policy.js';
import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';
import {
  resolveQuoteUsdPrice,
  toDiscoveryTickers,
} from '../../../src/crons/discovery/quote-price.js';

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

// `logger` is a required option because the cuts below are silent by
// construction; tests that do not assert on the warn still have to supply one.
const noopLogger = (): { warn: ReturnType<typeof vi.fn> } => ({ warn: vi.fn() });

/** exchangeInfo facts for one symbol. Base and quote are required, so every fixture states its own split rather than leaving it to be inferred. */
const adm = (
  baseAsset: string,
  quoteAsset: string,
  over: Partial<SymbolAdmission> = {},
): SymbolAdmission => ({ status: 'TRADING', baseAsset, quoteAsset, ...over });

/** An asset classification that vetoes only the listed bases. `tradingSymbols` is unread here — `toDiscoveryTickers` consumes the veto set; the completeness cross-check happens upstream. */
const policy = (bases: readonly string[] = []): AssetPolicy => ({
  stablecoinOrFiatBases: new Set(bases),
  // Unread here: `toDiscoveryTickers` consumes only the merged veto set, and the
  // per-route liveness and completeness checks both run upstream of it.
  taggedStablecoinBases: new Set(bases),
  fiatQuoteAssets: new Set(),
  tradingSymbols: new Set(),
});

const usdtOnly = (...symbols: readonly string[]): Map<string, SymbolAdmission> =>
  new Map(symbols.map((sym) => [sym, adm(sym.slice(0, -4), 'USDT')]));

describe('toDiscoveryTickers', () => {
  it('keeps only the configured quote asset and maps the fields', () => {
    const out = toDiscoveryTickers(
      [
        ticker({ symbol: 'AAAUSDT' }),
        ticker({ symbol: 'BBBBTC' }), // wrong quote
        ticker({ symbol: 'USDT' }), // the quote asset itself
      ],
      'USDT',
      new Decimal(1),
      {
        admissionBySymbol: new Map([
          ['AAAUSDT', adm('AAA', 'USDT')],
          ['BBBBTC', adm('BBB', 'BTC')],
          ['USDT', adm('USD', 'T')],
        ]),
        assetPolicy: policy(),
        logger: noopLogger(),
      },
    );
    expect(out.map((t) => t.symbol)).toEqual(['AAAUSDT']);
    expect(out[0]?.quoteAsset).toBe('USDT');
    expect(out[0]?.baseAsset).toBe('AAA');
    expect(out[0]?.isStablecoinOrFiat).toBe(false);
    expect(out[0]?.bidPrice).toBe('1');
  });

  it('resolves base and quote from exchangeInfo, never by slicing the quote off the symbol', () => {
    // The suffix rule breaks whenever one listed quote is a proper suffix of
    // another. Under quote `USD`, `BTCFDUSD` suffix-matches and slices to base
    // `BTCFD` — a base that exists nowhere. exchangeInfo says it is BTC/FDUSD,
    // so it is not a `USD` market at all and never enters the universe.
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'BTCFDUSD' }), ticker({ symbol: 'BTCUSD' })],
      'USD',
      new Decimal(1),
      {
        admissionBySymbol: new Map([
          ['BTCFDUSD', adm('BTC', 'FDUSD')],
          ['BTCUSD', adm('BTC', 'USD')],
        ]),
        assetPolicy: policy(),
        logger: noopLogger(),
      },
    );
    expect(out.map((t) => t.symbol)).toEqual(['BTCUSD']);
    expect(out[0]?.baseAsset).toBe('BTC');
  });

  it('stamps the stablecoin/fiat verdict from the classification, keyed on the exchangeInfo base', () => {
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'RLUSDUSDT' }), ticker({ symbol: 'BTCUSDT' })],
      'USDT',
      new Decimal(1),
      {
        admissionBySymbol: new Map([
          ['RLUSDUSDT', adm('RLUSD', 'USDT')],
          ['BTCUSDT', adm('BTC', 'USDT')],
        ]),
        assetPolicy: policy(['RLUSD']),
        logger: noopLogger(),
      },
    );
    // Both survive here — the veto is a funnel stage in the pure chain, not a
    // cut applied at the mapping boundary, so the operator can see its count.
    expect(out.map((t) => [t.symbol, t.isStablecoinOrFiat])).toEqual([
      ['RLUSDUSDT', true],
      ['BTCUSDT', false],
    ]);
  });

  it('under a USDT quote the pair IS the coin\u2019s USD market, so both volumes agree', () => {
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'AAAUSDT', quoteVolume: '7' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol: usdtOnly('AAAUSDT'), assetPolicy: policy(), logger: noopLogger() },
    );
    expect(out[0]?.pairVolumeUsd).toBe('7');
    expect(out[0]?.assetVolumeUsd).toBe('7');
  });

  it('under a BTC quote converts the pair volume and reads activity off the coin\u2019s USD market', () => {
    const raw = [
      ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
      ticker({ symbol: 'ETHBTC', quoteVolume: '30' }),
      ticker({ symbol: 'ETHUSDT', quoteVolume: '180000000' }),
    ];
    const out = toDiscoveryTickers(raw, 'BTC', resolveQuoteUsdPrice(raw, 'BTC') as Decimal, {
      admissionBySymbol: new Map([
        ['BTCUSDT', adm('BTC', 'USDT')],
        ['ETHBTC', adm('ETH', 'BTC')],
        ['ETHUSDT', adm('ETH', 'USDT')],
      ]),
      assetPolicy: policy(),
      logger: noopLogger(),
    });
    expect(out.map((t) => t.symbol)).toEqual(['ETHBTC']);
    // 30 BTC of turnover at $100k/BTC is $3M, the number a dollar floor judges.
    expect(out[0]?.pairVolumeUsd).toBe('3000000');
    // Activity comes from ETHUSDT, a different row of the same payload, found
    // via the exchangeInfo base rather than a sliced symbol.
    expect(out[0]?.assetVolumeUsd).toBe('180000000');
  });

  it('leaves assetVolumeUsd null for a coin with no USD market', () => {
    const raw = [
      ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
      ticker({ symbol: 'OBSCUREBTC' }),
    ];
    const out = toDiscoveryTickers(raw, 'BTC', new Decimal(100_000), {
      admissionBySymbol: new Map([
        ['BTCUSDT', adm('BTC', 'USDT')],
        ['OBSCUREBTC', adm('OBSCURE', 'BTC')],
      ]),
      assetPolicy: policy(),
      logger: noopLogger(),
    });
    expect(out[0]?.assetVolumeUsd).toBeNull();
  });

  it('excludes a non-TRADING symbol Binance still returns in /ticker/24hr', () => {
    // Binance keeps returning a 24hr row for a delisted/halted market. Only the
    // exchangeInfo status keeps it out: BCCUSDT (delisted) shares the USDT quote
    // with the live ETHUSDT, so the quote match cannot distinguish them.
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', adm('ETH', 'USDT')],
      ['BCCUSDT', adm('BCC', 'USDT', { status: 'BREAK' })], // delisted/halted
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, assetPolicy: policy(), logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
  });

  it('excludes a delisted symbol whose exchangeInfo status key was removed', () => {
    // The real delisting path is key deletion, not a status flip: exchange-info
    // -refresh DELETEs the symbol's key, so a delisted pair is simply absent
    // from the admission map. Absent must read as non-TRADING, i.e. excluded.
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol: usdtOnly('ETHUSDT'), assetPolicy: policy(), logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
  });

  it('throws on an empty admission map rather than scoring an unfiltered universe', () => {
    // This inverts the former fail-open. Keeping the quote-matched universe
    // looked safe and was not: with no admission map there is no status cut, no
    // base/quote split, and no base to classify, so the "safe" path admitted
    // delisted pairs and every stablecoin on the exchange.
    expect(() =>
      toDiscoveryTickers(
        [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
        'USDT',
        new Decimal(1),
        { admissionBySymbol: new Map(), assetPolicy: policy(), logger: noopLogger() },
      ),
    ).toThrow(/empty symbol-admission map/i);
  });

  it('excludes a TRADING symbol the account holds no permission for, and warns', () => {
    // Binance tradability is AND-of-ORs: the account must hold at least one tag
    // from every published set. A tokenized equity publishes SPOT/MARGIN groups
    // an account tagged only LEVERAGED/TRD_GRP_025 can never satisfy, so every
    // order it derives is refused with -2010 forever.
    const warn = vi.fn();
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', adm('ETH', 'USDT', { permissionSets: [['SPOT', 'TRD_GRP_025']] })],
      ['CRCLBUSDT', adm('CRCLB', 'USDT', { permissionSets: [['SPOT', 'TRD_GRP_005']] })],
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
      'USDT',
      new Decimal(1),
      {
        admissionBySymbol,
        assetPolicy: policy(),
        accountPermissions: ['LEVERAGED', 'TRD_GRP_025'],
        logger: { warn },
      },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails open on an empty account permission list: keeps every TRADING symbol', () => {
    // An unreadable permission cache must never shrink the universe: an absent
    // signal is "unknown", not "forbidden". Unlike the admission map, this one
    // input being absent still leaves every other cut fully armed.
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', adm('ETH', 'USDT', { permissionSets: [['SPOT']] })],
      ['CRCLBUSDT', adm('CRCLB', 'USDT', { permissionSets: [['TRD_GRP_005']] })],
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, assetPolicy: policy(), accountPermissions: [], logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT', 'CRCLBUSDT']);
  });

  it('keeps a symbol that publishes no permission sets', () => {
    // Older cache entries predate the projection and carry no sets. Absent sets
    // read as "no constraint published", which must stay permitted.
    const out = toDiscoveryTickers([ticker({ symbol: 'ETHUSDT' })], 'USDT', new Decimal(1), {
      admissionBySymbol: usdtOnly('ETHUSDT'),
      assetPolicy: policy(),
      accountPermissions: ['TRD_GRP_025'],
      logger: noopLogger(),
    });
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
  });
});

describe('resolveQuoteUsdPrice', () => {
  it('is 1 for the USD reference quote itself, with no lookup', () => {
    expect(resolveQuoteUsdPrice([], 'USDT')?.toString()).toBe('1');
  });

  it('reads the quote asset’s own USD market', () => {
    expect(
      resolveQuoteUsdPrice([ticker({ symbol: 'BTCUSDT', lastPrice: '100000' })], 'BTC')?.toString(),
    ).toBe('100000');
  });

  it('takes the reciprocal of an inverted fiat market (Binance lists USDTTRY, not TRYUSDT)', () => {
    const raw = [ticker({ symbol: 'USDTTRY', lastPrice: '40' })];
    expect(resolveQuoteUsdPrice(raw, 'TRY')?.toString()).toBe('0.025');
  });

  it('prefers the direct market over the inverted one when both are listed', () => {
    const raw = [
      ticker({ symbol: 'USDTBTC', lastPrice: '0.00002' }),
      ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
    ];
    expect(resolveQuoteUsdPrice(raw, 'BTC')?.toString()).toBe('100000');
  });

  it('is null when the quote has no USD market either way round, or it is priced at zero', () => {
    expect(resolveQuoteUsdPrice([], 'BTC')).toBeNull();
    expect(resolveQuoteUsdPrice([ticker({ symbol: 'BTCUSDT', lastPrice: '0' })], 'BTC')).toBeNull();
    expect(resolveQuoteUsdPrice([ticker({ symbol: 'USDTTRY', lastPrice: '0' })], 'TRY')).toBeNull();
  });
});
