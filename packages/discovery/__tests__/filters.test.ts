import { describe, expect, it } from 'vitest';
import { adx } from '@app/indicators/rating';
import type { Candle } from '@app/strategy-core';
import Decimal from 'decimal.js';
import {
  buildRankContext,
  heldLongEnough,
  inCooldown,
  isActive,
  matchesQuote,
  meetsLiquidity,
  MIN_UNIVERSE_FOR_RANK,
  notBlacklisted,
  oldEnough,
  trendConfirmed,
  volumeSma,
  withinChangeBand,
  withinSpread,
} from '../src/index.js';
import { candle, cfg, DAY_MS, HOUR_MS, rankUniverse, ticker, uptrend } from './_helpers.js';

const NOW = 1_700_000_000_000;

// A strong, steady DOWNtrend (mirror of `uptrend`) — ADX still high, but the
// last close sits below EMA20, to exercise the close>EMA branch failing.
const downtrend = (n: number, firstOpenMs: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const base = 100 + (n - i) * 4;
    return candle({
      openTimeMs: firstOpenMs + i * HOUR_MS,
      closeTimeMs: firstOpenMs + (i + 1) * HOUR_MS,
      open: String(base),
      high: String(base + 1),
      low: String(base - 3),
      close: String(base - 2),
      volume: i === n - 1 ? '1000' : '10',
    });
  });

describe('ticker-stage filters', () => {
  it('matchesQuote: quote asset must equal the configured one', () => {
    expect(matchesQuote(ticker({ quoteAsset: 'USDT' }), cfg())).toBe(true);
    expect(matchesQuote(ticker({ quoteAsset: 'BTC' }), cfg())).toBe(false);
  });

  it('notBlacklisted: rejects a blacklisted symbol', () => {
    expect(notBlacklisted(ticker({ symbol: 'AAAUSDT' }), cfg())).toBe(true);
    expect(notBlacklisted(ticker({ symbol: 'AAAUSDT' }), cfg({ blacklist: ['AAAUSDT'] }))).toBe(
      false,
    );
  });

  it('meetsLiquidity: the pair’s own USD volume must clear the floor', () => {
    expect(meetsLiquidity(ticker({ pairVolumeUsd: '50000000' }), cfg())).toBe(true);
    expect(meetsLiquidity(ticker({ pairVolumeUsd: '5000000' }), cfg())).toBe(false);
  });

  it('meetsLiquidity reads pairVolumeUsd, not the quote-denominated quoteVolume', () => {
    // A BTC-quoted pair: 30 BTC of turnover is $3M at $100k/BTC. The native
    // number would fail any dollar floor; the converted one is what matters.
    const btcPair = ticker({ quoteVolume: '30', pairVolumeUsd: '3000000' });
    expect(meetsLiquidity(btcPair, cfg({ min24hPairVolumeUsd: '500000' }))).toBe(true);
    expect(meetsLiquidity(btcPair, cfg({ min24hPairVolumeUsd: '10000000' }))).toBe(false);
  });

  it('isActive: the coin’s USD-market volume must clear the floor', () => {
    expect(isActive(ticker({ assetVolumeUsd: '180000000' }), cfg())).toBe(true);
    expect(isActive(ticker({ assetVolumeUsd: '4000000' }), cfg())).toBe(false);
  });

  it('isActive fails closed for a coin with no USD market', () => {
    expect(isActive(ticker({ assetVolumeUsd: null }), cfg())).toBe(false);
  });

  it('liquidity and activity separate a thin venue from a dead coin', () => {
    const floors = cfg({ min24hPairVolumeUsd: '500000', min24hAssetVolumeUsd: '50000000' });
    // Real midcap on a thin BTC book: fillable, and unmistakably alive.
    const midcap = ticker({ pairVolumeUsd: '3000000', assetVolumeUsd: '180000000' });
    // Dead coin whose thin book happens to churn more than the midcap's.
    const dead = ticker({ pairVolumeUsd: '1200000', assetVolumeUsd: '4000000' });
    // Hot coin with no depth on this venue.
    const hype = ticker({ pairVolumeUsd: '80000', assetVolumeUsd: '300000000' });

    expect(meetsLiquidity(midcap, floors) && isActive(midcap, floors)).toBe(true);
    expect(isActive(dead, floors)).toBe(false);
    expect(meetsLiquidity(hype, floors)).toBe(false);
    // The point of the split: no single floor can sit above `dead` and below
    // `midcap` on the venue axis (they are neighbours there), so one filter
    // could never admit `midcap` while rejecting `dead`.
    expect(new Decimal(dead.pairVolumeUsd).lt(midcap.pairVolumeUsd)).toBe(true);
    expect(new Decimal(dead.assetVolumeUsd as string).lt(midcap.assetVolumeUsd as string)).toBe(
      true,
    );
  });

  it('withinSpread: accepts a tight book, rejects wide / non-positive / crossed', () => {
    expect(withinSpread(ticker({ bidPrice: '100', askPrice: '100.1' }), cfg())).toBe(true);
    expect(withinSpread(ticker({ bidPrice: '100', askPrice: '101' }), cfg())).toBe(false); // wide
    expect(withinSpread(ticker({ bidPrice: '0', askPrice: '100' }), cfg())).toBe(false); // bid<=0
    expect(withinSpread(ticker({ bidPrice: '100', askPrice: '0' }), cfg())).toBe(false); // ask<=0
    expect(withinSpread(ticker({ bidPrice: '100', askPrice: '99' }), cfg())).toBe(false); // crossed
  });

  it('withinChangeBand: the absolute hurdle rejects a move under changeMinPercent', () => {
    const c = cfg();
    const ctx = buildRankContext([ticker({ priceChangePercent: '12' })], c);
    expect(withinChangeBand(ticker({ priceChangePercent: '12' }), c, ctx)).toBe(true);
    expect(withinChangeBand(ticker({ priceChangePercent: '3' }), c, ctx)).toBe(false);
  });

  it('withinChangeBand: the rank band keeps the top slice and skips the hottest', () => {
    // 20 symbols, gains 20..1 descending, so S00 is rank 1 and S19 is rank 20.
    const c = cfg({ changeMinPercent: '0', rankTopPercent: 30, rankExcludeTopPercent: 10 });
    const universe = rankUniverse(20);
    const ctx = buildRankContext(universe, c);
    const passes = universe.filter((t) => withinChangeBand(t, c, ctx)).map((t) => t.symbol);
    // hottest = 20 * 10/100 = 2, coldest = 20 * 30/100 = 6 -> ranks 3..6.
    expect(passes).toEqual(['S02USDT', 'S03USDT', 'S04USDT', 'S05USDT']);
  });

  it('withinChangeBand: the rank band fails open on a universe too thin to rank', () => {
    const c = cfg({ changeMinPercent: '0', rankTopPercent: 10, rankExcludeTopPercent: 0 });
    const thin = rankUniverse(MIN_UNIVERSE_FOR_RANK - 1);
    const ctx = buildRankContext(thin, c);
    expect(thin.every((t) => withinChangeBand(t, c, ctx))).toBe(true);
    // One more member and the band engages: top 10% of 10 names is one name.
    const wide = rankUniverse(MIN_UNIVERSE_FOR_RANK);
    const wideCtx = buildRankContext(wide, c);
    expect(wide.filter((t) => withinChangeBand(t, c, wideCtx)).map((t) => t.symbol)).toEqual([
      'S00USDT',
    ]);
  });

  it('withinChangeBand: a top slice that rounds below one name still keeps the best gainer', () => {
    // Top 1% of 99 names is 0.99 names. Flooring would reject even rank 1 and
    // silently empty the set; the slice rounds up so "top N%" always names one.
    const c = cfg({ changeMinPercent: '0', rankTopPercent: 1, rankExcludeTopPercent: 0 });
    const universe = rankUniverse(99);
    const ctx = buildRankContext(universe, c);
    expect(universe.filter((t) => withinChangeBand(t, c, ctx)).map((t) => t.symbol)).toEqual([
      'S00USDT',
    ]);
  });

  it('withinChangeBand: a skipped slice that rounds below one name skips nobody', () => {
    // Hottest 1% of 20 names is 0.2 names — round down, discarding no candidate.
    const c = cfg({ changeMinPercent: '0', rankTopPercent: 100, rankExcludeTopPercent: 1 });
    const universe = rankUniverse(20);
    const ctx = buildRankContext(universe, c);
    expect(universe.filter((t) => withinChangeBand(t, c, ctx))).toHaveLength(20);
  });

  it('withinChangeBand: a symbol outside the ranked universe is rejected', () => {
    const c = cfg({ changeMinPercent: '0' });
    const ctx = buildRankContext(rankUniverse(20), c);
    expect(withinChangeBand(ticker({ symbol: 'GHOSTUSDT' }), c, ctx)).toBe(false);
  });
});

describe('kline-stage filters', () => {
  it('oldEnough: empty fails; old window passes; too-new window fails', () => {
    expect(oldEnough([], cfg(), NOW)).toBe(false);
    const old = [candle({ openTimeMs: NOW - 40 * DAY_MS })];
    expect(oldEnough(old, cfg(), NOW)).toBe(true);
    const fresh = [candle({ openTimeMs: NOW - 10 * DAY_MS })];
    expect(oldEnough(fresh, cfg(), NOW)).toBe(false);
  });

  it('volumeSma: null when short, else the mean of the last N volumes', () => {
    expect(volumeSma([candle({ volume: '10' })], 3)).toBeNull();
    const w = [candle({ volume: '10' }), candle({ volume: '20' }), candle({ volume: '30' })];
    expect(volumeSma(w, 3)?.toString()).toBe('20');
  });

  it('trendConfirmed: confirms a strong up-move under the seed thresholds', () => {
    expect(trendConfirmed(uptrend(40, NOW - 40 * HOUR_MS), cfg())).toBe(true);
  });

  it('trendConfirmed: empty window fails', () => {
    expect(trendConfirmed([], cfg())).toBe(false);
  });

  it('trendConfirmed: ADX null (window shorter than 2x adxPeriod) fails', () => {
    expect(trendConfirmed(uptrend(3, NOW), cfg())).toBe(false);
  });

  it('trendConfirmed: EMA null while ADX non-null fails', () => {
    // adxPeriod 2 needs 4 candles; emaPeriod 50 needs 50 — a 10-candle window
    // makes ADX non-null but EMA null.
    const c = cfg({ trendConfirm: { ...cfg().trendConfirm, adxPeriod: 2, emaPeriod: 50 } });
    expect(trendConfirmed(uptrend(10, NOW), c)).toBe(false);
  });

  it('trendConfirmed: volume-SMA null while ADX+EMA non-null fails', () => {
    const c = cfg({
      trendConfirm: { ...cfg().trendConfirm, adxPeriod: 2, emaPeriod: 2, volSmaPeriod: 50 },
    });
    expect(trendConfirmed(uptrend(10, NOW), c)).toBe(false);
  });

  it('trendConfirmed: ADX below the minimum fails', () => {
    expect(
      trendConfirmed(
        uptrend(40, NOW),
        cfg({ trendConfirm: { ...cfg().trendConfirm, adxMin: '999' } }),
      ),
    ).toBe(false);
  });

  it('trendConfirmed: close at/below EMA fails (downtrend, low adxMin)', () => {
    const c = cfg({ trendConfirm: { ...cfg().trendConfirm, adxMin: '1' } });
    expect(trendConfirmed(downtrend(40, NOW), c)).toBe(false);
  });

  it('trendConfirmed: insufficient volume surge fails', () => {
    const c = cfg({ trendConfirm: { ...cfg().trendConfirm, adxMin: '1', volMultiple: '99999' } });
    expect(trendConfirmed(uptrend(40, NOW), c)).toBe(false);
  });
});

describe('trend-confirm preconditions and boundaries', () => {
  it('the uptrend helper actually clears the seed ADX(14) >= 25 precondition', () => {
    // Pins the hidden assumption behind every eligibility test: if the helper
    // ramp or the ADX adapter drifts, this fails here with a clear cause rather
    // than silently flipping an unrelated trend-confirm assertion.
    const adxVal = adx(uptrend(40, NOW - 40 * HOUR_MS), 14);
    expect(adxVal).not.toBeNull();
    expect(adxVal?.gte('25')).toBe(true);
  });

  it('the volume gate is a STRICT surge: equal-to-threshold fails, just-over passes', () => {
    // Flat-volume rising window: last volume == SMA, so `lastVol > mult * sma`
    // is the only deciding term. adxMin 0 / rising close keep the other two true.
    const flatVol: Candle[] = Array.from({ length: 6 }, (_, i) => {
      const base = 100 + i * 4;
      return candle({
        openTimeMs: i,
        open: String(base - 2),
        high: String(base + 1),
        low: String(base - 3),
        close: String(base),
        volume: '10',
      });
    });
    const tc = { adxPeriod: 2, adxMin: '0', emaPeriod: 2, volSmaPeriod: 2 };
    expect(trendConfirmed(flatVol, cfg({ trendConfirm: { ...tc, volMultiple: '1' } }))).toBe(false);
    expect(trendConfirmed(flatVol, cfg({ trendConfirm: { ...tc, volMultiple: '0.99' } }))).toBe(
      true,
    );
  });
});

describe('timing filters', () => {
  it('inCooldown: no record = not on cooldown; recent = on; old = off', () => {
    expect(inCooldown(undefined, cfg(), NOW)).toBe(false);
    expect(inCooldown(NOW - 60 * 60_000, cfg(), NOW)).toBe(true); // 60 < 120 min
    expect(inCooldown(NOW - 180 * 60_000, cfg(), NOW)).toBe(false); // 180 >= 120 min
  });

  it('heldLongEnough: true past min-hold, false within it', () => {
    expect(heldLongEnough(NOW - 180 * 60_000, cfg(), NOW)).toBe(true);
    expect(heldLongEnough(NOW - 60 * 60_000, cfg(), NOW)).toBe(false);
  });
});
