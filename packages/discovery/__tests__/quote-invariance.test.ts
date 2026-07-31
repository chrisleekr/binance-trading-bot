import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import { buildRankContext, meetsLiquidity, runDiscovery } from '../src/index.js';
import type { DiscoveryConfig, DiscoveryTicker } from '../src/types.js';
import { cfg, DAY_MS, ticker, uptrend } from './_helpers.js';

const NOW = 1_700_000_000_000;
const FIRST_OPEN = NOW - 400 * DAY_MS;
const BTC_PRICE = new Decimal(100_000);

/**
 * The operator-facing guarantee this file exists to protect: a config tuned
 * under USDT keeps working verbatim under BTC. No threshold may need rescaling
 * on a quote change, and none may silently empty the candidate set.
 *
 * The proof is a re-denomination: take a USDT universe, express the identical
 * market in BTC terms, and demand the same diff back. A future knob that leaks
 * the quote asset into a volume or percentage fails here on the day it is added,
 * not on the day someone switches to BTC in production.
 *
 * One knob is deliberately quote-RELATIVE and not quote-invariant:
 * `changeMinPercent` asks whether the coin beat the asset you hold when flat, so
 * its membership genuinely differs between USDT and BTC whenever BTC's own return
 * is non-zero. That is the intended semantics, not a leak. The full-pipeline check
 * therefore pins BTC flat — the one regime where the sign test cannot diverge —
 * while the ranking check below proves invariance across arbitrary BTC returns.
 */

/** A USDT-quoted market: 20 coins, gains 20%..1% descending, all in a clean uptrend. */
const usdtUniverse = (): DiscoveryTicker[] =>
  Array.from({ length: 20 }, (_, i) =>
    ticker({
      symbol: `A${String(i).padStart(2, '0')}USDT`,
      priceChangePercent: String(20 - i),
      quoteVolume: '50000000',
      pairVolumeUsd: '50000000',
      assetVolumeUsd: '100000000',
      lastPrice: '100',
      bidPrice: '100',
      askPrice: '100.1',
      // One illiquid name, to prove the volume floor rejects it under both quotes
      // rather than passing under one and failing under the other.
      ...(i === 19 ? { quoteVolume: '1', pairVolumeUsd: '1' } : {}),
    }),
  );

const usdtKlines = (tickers: readonly DiscoveryTicker[]): Record<string, readonly Candle[]> =>
  Object.fromEntries(tickers.map((t) => [t.symbol, uptrend(60, FIRST_OPEN)]));

const baseOf = (symbol: string): string => symbol.slice(0, symbol.length - 'USDT'.length);

/**
 * Re-denominate a USDT ticker into its BTC-quoted twin, given BTC's own 24h
 * return. Prices divide by BTC's price; the coin's return against BTC is
 * `(1 + rCoin) / (1 + rBtc) - 1`. `assetVolumeUsd` is measured on the coin's
 * USDT market by definition, so it does not move. `pairVolumeUsd` is derived the
 * way the cron derives it (native quote volume x the quote's USD price), which
 * is what makes this a test of the denomination and not a copy of the answer.
 */
const toBtcQuoted = (t: DiscoveryTicker, btcChangePercent: Decimal): DiscoveryTicker => {
  const rCoin = new Decimal(t.priceChangePercent).div(100);
  const rBtc = btcChangePercent.div(100);
  const quoteVolume = new Decimal(t.quoteVolume).div(BTC_PRICE);
  const nativePairVolume = new Decimal(t.pairVolumeUsd).div(BTC_PRICE);
  return {
    symbol: `${baseOf(t.symbol)}BTC`,
    quoteAsset: 'BTC',
    priceChangePercent: rCoin.plus(1).div(rBtc.plus(1)).minus(1).times(100).toString(),
    quoteVolume: quoteVolume.toString(),
    pairVolumeUsd: nativePairVolume.times(BTC_PRICE).toString(),
    assetVolumeUsd: t.assetVolumeUsd,
    lastPrice: new Decimal(t.lastPrice).div(BTC_PRICE).toString(),
    bidPrice: new Decimal(t.bidPrice).div(BTC_PRICE).toString(),
    askPrice: new Decimal(t.askPrice).div(BTC_PRICE).toString(),
  };
};

/** Candle prices are quote-denominated; candle volume is in base units, so it does not move. */
const toBtcCandles = (window: readonly Candle[]): Candle[] =>
  window.map((c) => ({
    ...c,
    open: new Decimal(c.open).div(BTC_PRICE).toString(),
    high: new Decimal(c.high).div(BTC_PRICE).toString(),
    low: new Decimal(c.low).div(BTC_PRICE).toString(),
    close: new Decimal(c.close).div(BTC_PRICE).toString(),
  }));

/** The band armed, so the cross-sectional filter is actually exercised. */
const invariantConfig = (quoteAsset: string): DiscoveryConfig =>
  cfg({
    quoteAsset,
    changeMinPercent: '0',
    rankTopPercent: 30,
    rankExcludeTopPercent: 5,
    min24hPairVolumeUsd: '500000',
    min24hAssetVolumeUsd: '50000000',
    maxAutoSymbols: 5,
  });

describe('quote-asset invariance', () => {
  it('picks the same coins under BTC as under USDT when BTC is flat', () => {
    const usdt = usdtUniverse();
    // BTC flat: re-denomination is the identity on returns, so the sign hurdle
    // selects the same set and any surviving difference is a unit leak. Prices
    // and volumes still rescale by 1/BTC_PRICE, which is the part under test.
    const btc = usdt.map((t) => toBtcQuoted(t, new Decimal(0)));

    const usdtDiff = runDiscovery({
      tickers: usdt,
      klinesBySymbol: usdtKlines(usdt),
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: invariantConfig('USDT'),
      nowMs: NOW,
    });
    const btcKlines = Object.fromEntries(
      btc.map((t) => [t.symbol, toBtcCandles(uptrend(60, FIRST_OPEN))]),
    );
    const btcDiff = runDiscovery({
      tickers: btc,
      klinesBySymbol: btcKlines,
      currentAuto: [],
      lastFlattenAtMsBySymbol: {},
      config: invariantConfig('BTC'),
      nowMs: NOW,
    });

    // The band is armed and selective, or this test proves nothing.
    expect(usdtDiff.add.length).toBeGreaterThan(0);
    expect(usdtDiff.add.length).toBeLessThan(usdt.length);

    expect(btcDiff.add.map(baseOfBtc)).toEqual(usdtDiff.add.map(baseOf));
    expect(btcDiff.remove.map(baseOfBtc)).toEqual(usdtDiff.remove.map(baseOf));
    expect(btcDiff.desired.map(baseOfBtc)).toEqual(usdtDiff.desired.map(baseOf));
  });

  it('preserves the universe ranking exactly for any BTC return', () => {
    // `(1 + rCoin) / (1 + rBtc) - 1` is strictly monotone increasing in `rCoin`
    // for fixed `rBtc > -1`, so re-denominating permutes nothing. This is why a
    // rank band survives a quote change and an absolute percentage band does not.
    const usdt = usdtUniverse();
    const usdtRank = buildRankContext(usdt, invariantConfig('USDT'));

    for (const btcChange of ['-30', '-0.5', '0', '7.25', '40']) {
      const btc = usdt.map((t) => toBtcQuoted(t, new Decimal(btcChange)));
      const btcRank = buildRankContext(btc, invariantConfig('BTC'));
      expect(btcRank.universeSize).toBe(usdtRank.universeSize);
      for (const t of usdt) {
        expect(btcRank.rankBySymbol.get(`${baseOf(t.symbol)}BTC`)).toBe(
          usdtRank.rankBySymbol.get(t.symbol),
        );
      }
    }
  });

  it('the liquidity floor reaches the same verdict under both quotes', () => {
    const usdt = usdtUniverse();
    const btc = usdt.map((t) => toBtcQuoted(t, new Decimal(0)));
    const [deepUsdt, deepBtc] = [usdt[0] as DiscoveryTicker, btc[0] as DiscoveryTicker];
    const [thinUsdt, thinBtc] = [usdt.at(-1) as DiscoveryTicker, btc.at(-1) as DiscoveryTicker];

    // Production filter, not fixture arithmetic: same verdict on both sides.
    expect(meetsLiquidity(deepUsdt, invariantConfig('USDT'))).toBe(true);
    expect(meetsLiquidity(deepBtc, invariantConfig('BTC'))).toBe(true);
    expect(meetsLiquidity(thinUsdt, invariantConfig('USDT'))).toBe(false);
    expect(meetsLiquidity(thinBtc, invariantConfig('BTC'))).toBe(false);

    // And the native number the OLD filter compared is five orders of magnitude
    // smaller under BTC (1 USDT of turnover is 0.00001 BTC), which is exactly why
    // a quote-denominated floor rejected the entire BTC universe.
    expect(new Decimal(thinBtc.quoteVolume).toNumber()).toBeCloseTo(0.00001, 10);
  });
});

const baseOfBtc = (symbol: string): string => symbol.slice(0, symbol.length - 'BTC'.length);
