import { describe, expect, it, vi } from 'vitest';
import type { Ticker24hrDto } from '@app/binance';
import { Decimal } from '@app/money';
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

// `logger` is a required option because both cuts below are silent by
// construction; tests that do not assert on the warn still have to supply one.
const noopLogger = (): { warn: ReturnType<typeof vi.fn> } => ({ warn: vi.fn() });

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
      { logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['AAAUSDT']);
    expect(out[0]?.quoteAsset).toBe('USDT');
    expect(out[0]?.bidPrice).toBe('1');
  });

  it('under a USDT quote the pair IS the coin’s USD market, so both volumes agree', () => {
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'AAAUSDT', quoteVolume: '7' })],
      'USDT',
      new Decimal(1),
      { logger: noopLogger() },
    );
    expect(out[0]?.pairVolumeUsd).toBe('7');
    expect(out[0]?.assetVolumeUsd).toBe('7');
  });

  it('under a BTC quote converts the pair volume and reads activity off the coin’s USD market', () => {
    const raw = [
      ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
      ticker({ symbol: 'ETHBTC', quoteVolume: '30' }),
      ticker({ symbol: 'ETHUSDT', quoteVolume: '180000000' }),
    ];
    const out = toDiscoveryTickers(raw, 'BTC', resolveQuoteUsdPrice(raw, 'BTC') as Decimal, {
      logger: noopLogger(),
    });
    expect(out.map((t) => t.symbol)).toEqual(['ETHBTC']);
    // 30 BTC of turnover at $100k/BTC is $3M, the number a dollar floor judges.
    expect(out[0]?.pairVolumeUsd).toBe('3000000');
    // Activity comes from ETHUSDT, a different row of the same payload.
    expect(out[0]?.assetVolumeUsd).toBe('180000000');
  });

  it('leaves assetVolumeUsd null for a coin with no USD market', () => {
    const raw = [
      ticker({ symbol: 'BTCUSDT', lastPrice: '100000' }),
      ticker({ symbol: 'OBSCUREBTC' }),
    ];
    const out = toDiscoveryTickers(raw, 'BTC', new Decimal(100_000), {
      logger: noopLogger(),
    });
    expect(out[0]?.assetVolumeUsd).toBeNull();
  });

  it('excludes a non-TRADING symbol Binance still returns in /ticker/24hr (#635)', () => {
    // Binance keeps returning a 24hr row for a delisted/halted market. Suffix
    // matching alone lets it into the universe; only the exchangeInfo status
    // keeps it out. BCCUSDT (delisted) shares the USDT quote with the live
    // ETHUSDT, so the quote filter can't distinguish them — status must.
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', { status: 'TRADING' }],
      ['BCCUSDT', { status: 'BREAK' }], // delisted/halted
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
  });

  it('excludes a delisted symbol whose exchangeInfo status key was removed (#635)', () => {
    // The real delisting path is key deletion, not a status flip: exchange-info
    // -refresh DELETEs the symbol's key, so a delisted pair is simply absent
    // from the status map. Absent must read as non-TRADING, i.e. excluded.
    // BCCUSDT absent
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', { status: 'TRADING' }],
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
  });

  it('fails open on an empty status map: keeps the quote-matched universe and warns (#635)', () => {
    // exchangeInfo not primed / Redis miss ⇒ an empty map must NOT empty the
    // universe. Fall back to the quote-suffix match alone and warn once.
    const warn = vi.fn();
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'BCCUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol: new Map(), logger: { warn } },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT', 'BCCUSDT']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('excludes a TRADING symbol the account holds no permission for, and warns', () => {
    // Binance tradability is AND-of-ORs: the account must hold at least one tag
    // from every published set. A tokenized equity publishes SPOT/MARGIN groups
    // an account tagged only LEVERAGED/TRD_GRP_025 can never satisfy, so every
    // order it derives is refused with -2010 forever.
    const warn = vi.fn();
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', { status: 'TRADING', permissionSets: [['SPOT', 'TRD_GRP_025']] }],
      ['CRCLBUSDT', { status: 'TRADING', permissionSets: [['SPOT', 'TRD_GRP_005']] }],
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, accountPermissions: ['LEVERAGED', 'TRD_GRP_025'], logger: { warn } },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails open on an empty account permission list: keeps every TRADING symbol', () => {
    // An unreadable permission cache must never shrink the universe: an absent
    // signal is "unknown", not "forbidden".
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', { status: 'TRADING', permissionSets: [['SPOT']] }],
      ['CRCLBUSDT', { status: 'TRADING', permissionSets: [['TRD_GRP_005']] }],
    ]);
    const out = toDiscoveryTickers(
      [ticker({ symbol: 'ETHUSDT' }), ticker({ symbol: 'CRCLBUSDT' })],
      'USDT',
      new Decimal(1),
      { admissionBySymbol, accountPermissions: [], logger: noopLogger() },
    );
    expect(out.map((t) => t.symbol)).toEqual(['ETHUSDT', 'CRCLBUSDT']);
  });

  it('keeps a symbol that publishes no permission sets', () => {
    // Older cache entries predate the projection and carry no sets. Absent sets
    // read as "no constraint published", which must stay permitted.
    const admissionBySymbol = new Map<string, SymbolAdmission>([
      ['ETHUSDT', { status: 'TRADING' }],
    ]);
    const out = toDiscoveryTickers([ticker({ symbol: 'ETHUSDT' })], 'USDT', new Decimal(1), {
      admissionBySymbol,
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
