// Aggregator that produces the TradingView-style Technical Ratings from a
// candle window. Per-indicator vote rules follow the documented TradingView
// methodology at
// https://www.tradingview.com/support/solutions/43000614331-technical-ratings/
// — see also the published Pine reference at
// https://www.tradingview.com/script/jDWyb5PG-TechnicalRating/.
//
// Vote convention: -1 = Sell, 0 = Neutral, +1 = Buy. The two aggregates take
// the mean of their constituent votes; the overall `recommendAll` is the mean
// of the two aggregates. Final categorisation buckets are downstream — this
// module returns the raw [-1, 1] floats so the strategy gate can apply its
// own thresholds.

import Decimal from 'decimal.js';

import type { CandleWindow } from '@app/indicators';

import * as a from './adapter.js';
import { bbPower } from './bb-power.js';
import { hullMa } from './hull-ma.js';
import { ichimokuCloud, type IchimokuCloud } from './ichimoku.js';
import { ultimateOscillator } from './ultimate-osc.js';

export type Vote = -1 | 0 | 1;

export interface TechnicalsRating {
  /** Overall verdict, mean of recommendMa and recommendOther, in [-1, 1]. */
  recommendAll: Decimal;
  /** Mean of the 15 MA votes. */
  recommendMa: Decimal;
  /** Mean of the 11 oscillator votes. */
  recommendOther: Decimal;
  /** Raw indicator values for the panel UI (null when window too short). */
  oscillators: {
    rsi: Decimal | null;
    stochK: Decimal | null;
    stochD: Decimal | null;
    cci20: Decimal | null;
    adx: Decimal | null;
    adxPlusDi: Decimal | null;
    adxMinusDi: Decimal | null;
    ao: Decimal | null;
    mom: Decimal | null;
    macdMacd: Decimal | null;
    macdSignal: Decimal | null;
    stochRsiK: Decimal | null;
    wr: Decimal | null;
    bbPowerBull: Decimal | null;
    bbPowerBear: Decimal | null;
    uo: Decimal | null;
  };
  movingAverages: {
    ema10: Decimal | null;
    sma10: Decimal | null;
    ema20: Decimal | null;
    sma20: Decimal | null;
    ema30: Decimal | null;
    sma30: Decimal | null;
    ema50: Decimal | null;
    sma50: Decimal | null;
    ema100: Decimal | null;
    sma100: Decimal | null;
    ema200: Decimal | null;
    sma200: Decimal | null;
    vwma20: Decimal | null;
    hullMa9: Decimal | null;
    ichimokuBLine: Decimal | null;
  };
  /** Each indicator's individual vote, keyed by indicator name. */
  perIndicatorVotes: Record<string, Vote>;
}

const NEUTRAL_VOTE: Vote = 0;

const mean = (votes: Vote[]): Decimal => {
  /* v8 ignore start -- reason: mean is only ever called with the fixed 10-osc and 15-ma vote arrays, which are never empty, so the length-0 guard is unreachable */
  if (votes.length === 0) return new Decimal(0);
  /* v8 ignore stop -- reason: end of the unreachable empty-votes guard above */
  let sum = 0;
  for (const v of votes) sum += v;
  return new Decimal(sum).dividedBy(votes.length);
};

// ---- Vote rule helpers ----

const priceVsMa = (price: Decimal | null, ma: Decimal | null): Vote => {
  if (price === null || ma === null) return NEUTRAL_VOTE;
  if (price.greaterThan(ma)) return 1;
  if (price.lessThan(ma)) return -1;
  return 0;
};

const rsiVote = (current: Decimal | null, prev: Decimal | null): Vote => {
  if (current === null || prev === null) return NEUTRAL_VOTE;
  if (current.lessThan(30) && current.greaterThan(prev)) return 1;
  if (current.greaterThan(70) && current.lessThan(prev)) return -1;
  return 0;
};

const stochVote = (k: Decimal | null, d: Decimal | null): Vote => {
  if (k === null || d === null) return NEUTRAL_VOTE;
  // TradingView: buy when both lines are oversold and %K leads %D; sell when
  // both are overbought and %K trails %D. No crossover term — the rating reads
  // the current bar only.
  if (k.lessThan(20) && d.lessThan(20) && k.greaterThan(d)) return 1;
  if (k.greaterThan(80) && d.greaterThan(80) && k.lessThan(d)) return -1;
  return 0;
};

const cciVote = (current: Decimal | null, prev: Decimal | null): Vote => {
  if (current === null || prev === null) return NEUTRAL_VOTE;
  if (current.lessThan(-100) && current.greaterThan(prev)) return 1;
  if (current.greaterThan(100) && current.lessThan(prev)) return -1;
  return 0;
};

export const adxVote = (
  adxVal: Decimal | null,
  adxPrev: Decimal | null,
  plus: Decimal | null,
  minus: Decimal | null,
): Vote => {
  if (adxVal === null || adxPrev === null || plus === null || minus === null) {
    return NEUTRAL_VOTE;
  }
  // TradingView: a trend must be present (ADX > 20) and strengthening — ADX
  // rising for a buy, falling for a sell — in the DI-implied direction.
  if (!adxVal.greaterThan(20)) return 0;
  if (plus.greaterThan(minus) && adxVal.greaterThan(adxPrev)) return 1;
  if (minus.greaterThan(plus) && adxVal.lessThan(adxPrev)) return -1;
  return 0;
};

/**
 * Awesome Oscillator. TradingView: a zero-line cross, or a saucer — two bars on
 * the same side of zero that dip toward zero then turn back away from it
 * (current past prev, with prev having pulled in versus the bar before).
 */
export const aoVote = (
  current: Decimal | null,
  prev: Decimal | null,
  prevPrev: Decimal | null,
): Vote => {
  if (current === null || prev === null || prevPrev === null) return NEUTRAL_VOTE;
  // Zero-line cross.
  if (current.greaterThan(0) && prev.lessThanOrEqualTo(0)) return 1;
  if (current.lessThan(0) && prev.greaterThanOrEqualTo(0)) return -1;
  // Saucer above / below zero.
  if (current.greaterThan(0) && current.greaterThan(prev) && prev.lessThan(prevPrev)) return 1;
  if (current.lessThan(0) && current.lessThan(prev) && prev.greaterThan(prevPrev)) return -1;
  return 0;
};

const momentumVote = (current: Decimal | null, prev: Decimal | null): Vote => {
  if (current === null || prev === null) return NEUTRAL_VOTE;
  if (current.greaterThan(prev)) return 1;
  if (current.lessThan(prev)) return -1;
  return 0;
};

const macdVote = (macdVal: Decimal | null, signal: Decimal | null): Vote => {
  if (macdVal === null || signal === null) return NEUTRAL_VOTE;
  if (macdVal.greaterThan(signal)) return 1;
  if (macdVal.lessThan(signal)) return -1;
  return 0;
};

export const stochRsiVote = (k: Decimal | null, d: Decimal | null): Vote => {
  if (k === null || d === null) return NEUTRAL_VOTE;
  // TradingView: oversold with %K leading %D → buy; overbought with %K trailing
  // %D → sell. Same shape as the Stochastic rule, applied to the StochRSI lines.
  if (k.lessThan(20) && d.lessThan(20) && k.greaterThan(d)) return 1;
  if (k.greaterThan(80) && d.greaterThan(80) && k.lessThan(d)) return -1;
  return 0;
};

const williamsVote = (current: Decimal | null, prev: Decimal | null): Vote => {
  if (current === null || prev === null) return NEUTRAL_VOTE;
  if (current.lessThan(-80) && current.greaterThan(prev)) return 1;
  if (current.greaterThan(-20) && current.lessThan(prev)) return -1;
  return 0;
};

/**
 * Bull/Bear Power. TradingView combines the pair with the EMA's trend
 * (`trend`: +1 up, -1 down, 0 flat): in an uptrend, buy when bear power is
 * still negative but recovering (bears weakening); in a downtrend, sell when
 * bull power is still positive but fading (bulls weakening).
 */
export const bbPowerVote = (
  bull: Decimal | null,
  bear: Decimal | null,
  bullPrev: Decimal | null,
  bearPrev: Decimal | null,
  trend: Vote,
): Vote => {
  if (bull === null || bear === null || bullPrev === null || bearPrev === null) {
    return NEUTRAL_VOTE;
  }
  if (trend === 1 && bear.lessThan(0) && bear.greaterThan(bearPrev)) return 1;
  if (trend === -1 && bull.greaterThan(0) && bull.lessThan(bullPrev)) return -1;
  return 0;
};

export const uoVote = (current: Decimal | null): Vote => {
  if (current === null) return NEUTRAL_VOTE;
  // TradingView's rating reads the UO as a momentum/breakout signal: above 70
  // is a buy, below 30 a sell (NOT a mean-reversion overbought/oversold read).
  if (current.greaterThan(70)) return 1;
  if (current.lessThan(30)) return -1;
  return 0;
};

/** EMA-slope trend used by the Bull/Bear Power vote: +1 rising, -1 falling, 0 flat/unknown. */
const emaTrend = (current: Decimal | null, prev: Decimal | null): Vote => {
  if (current === null || prev === null) return 0;
  if (current.greaterThan(prev)) return 1;
  if (current.lessThan(prev)) return -1;
  return 0;
};

/**
 * Ichimoku Cloud vote. TradingView's rating: price above the entire cloud with
 * bullish structure (conversion over base) → buy; price below the cloud with
 * bearish structure → sell. Anything in between is neutral.
 */
const ichimokuVote = (cloud: IchimokuCloud | null, price: Decimal | null): Vote => {
  if (cloud === null || price === null) return NEUTRAL_VOTE;
  const { conversion, base, leadA, leadB } = cloud;
  if (
    leadA.lessThan(price) &&
    price.greaterThan(leadB) &&
    price.greaterThan(base) &&
    conversion.greaterThan(base)
  ) {
    return 1;
  }
  if (
    leadA.greaterThan(price) &&
    price.lessThan(leadB) &&
    price.lessThan(base) &&
    conversion.lessThan(base)
  ) {
    return -1;
  }
  return 0;
};

// ---- Public entry point ----

export const computeTechnicalsRating = (w: CandleWindow): TechnicalsRating => {
  // `prev` (window minus its last bar) is still needed for the custom Bull/Bear
  // Power, which is not a vendored streaming indicator. The vendored oscillators
  // below instead read their previous value off the single-pass `*CurrPrev`
  // helpers, which is byte-identical to a second pass over `prev`.
  const prev = w.slice(0, w.length - 1);
  const price = a.lastClose(w);

  // Oscillators — current + previous in one pass each (the previous value drives
  // the slope/cross votes).
  const { curr: rsiVal, prev: rsiPrev } = a.rsiCurrPrev(w);
  const stochVal = a.stoch(w);
  const { curr: cciVal, prev: cciPrev } = a.cciCurrPrev(w);
  const { curr: adxVal, prev: adxPrev } = a.adxCurrPrev(w);
  const di = a.directionalIndicators(w);
  const { curr: aoCurr, prev: aoPrev, prev2: aoPrev2 } = a.aoCurrPrevPrev2(w);
  const { curr: momCurr, prev: momPrev } = a.momentumCurrPrev(w);
  const macdVal = a.macd(w);
  const stochRsiVal = a.stochRsi(w);
  const { curr: wr, prev: wrPrev } = a.williamsCurrPrev(w);
  const bb = bbPower(w);
  const bbPrev = bbPower(prev);
  // Bull/Bear Power uses a 13-period EMA; Elder reads that EMA's slope as the
  // trend, so the trend gate uses the same period.
  const { curr: bbEma, prev: bbEmaPrev } = a.emaCurrPrev(w, 13);
  const uo = ultimateOscillator(w);

  // Moving averages
  const ma10E = a.ema(w, 10);
  const ma10S = a.sma(w, 10);
  const ma20E = a.ema(w, 20);
  const ma20S = a.sma(w, 20);
  const ma30E = a.ema(w, 30);
  const ma30S = a.sma(w, 30);
  const ma50E = a.ema(w, 50);
  const ma50S = a.sma(w, 50);
  const ma100E = a.ema(w, 100);
  const ma100S = a.sma(w, 100);
  const ma200E = a.ema(w, 200);
  const ma200S = a.sma(w, 200);
  const vwma20 = a.vwma(w, 20);
  const hull9 = hullMa(w, 9);
  const cloud = ichimokuCloud(w);

  // Two separate strongly-typed vote groups so we can mean each independently
  // and still produce a single flat per-indicator map for downstream UI tones.
  const oscVoteMap = {
    rsi: rsiVote(rsiVal, rsiPrev),
    stoch: stochVote(stochVal?.k ?? null, stochVal?.d ?? null),
    cci: cciVote(cciVal, cciPrev),
    adx: adxVote(adxVal, adxPrev, di?.plus ?? null, di?.minus ?? null),
    ao: aoVote(aoCurr, aoPrev, aoPrev2),
    mom: momentumVote(momCurr, momPrev),
    macd: macdVote(macdVal?.macd ?? null, macdVal?.signal ?? null),
    stochRsi: stochRsiVote(stochRsiVal?.k ?? null, stochRsiVal?.d ?? null),
    wr: williamsVote(wr, wrPrev),
    bbPower: bbPowerVote(
      bb?.bull ?? null,
      bb?.bear ?? null,
      bbPrev?.bull ?? null,
      bbPrev?.bear ?? null,
      emaTrend(bbEma, bbEmaPrev),
    ),
    uo: uoVote(uo),
  } satisfies Record<string, Vote>;
  const maVoteMap = {
    ema10: priceVsMa(price, ma10E),
    sma10: priceVsMa(price, ma10S),
    ema20: priceVsMa(price, ma20E),
    sma20: priceVsMa(price, ma20S),
    ema30: priceVsMa(price, ma30E),
    sma30: priceVsMa(price, ma30S),
    ema50: priceVsMa(price, ma50E),
    sma50: priceVsMa(price, ma50S),
    ema100: priceVsMa(price, ma100E),
    sma100: priceVsMa(price, ma100S),
    ema200: priceVsMa(price, ma200E),
    sma200: priceVsMa(price, ma200S),
    vwma20: priceVsMa(price, vwma20),
    hullMa9: priceVsMa(price, hull9),
    ichimokuBLine: ichimokuVote(cloud, price),
  } satisfies Record<string, Vote>;

  const oscVotes: Vote[] = Object.values(oscVoteMap);
  const maVotes: Vote[] = Object.values(maVoteMap);
  const votes: Record<string, Vote> = { ...oscVoteMap, ...maVoteMap };

  const recommendOther = mean(oscVotes);
  const recommendMa = mean(maVotes);
  const recommendAll = recommendMa.plus(recommendOther).dividedBy(2);

  return {
    recommendAll,
    recommendMa,
    recommendOther,
    oscillators: {
      rsi: rsiVal,
      stochK: stochVal?.k ?? null,
      stochD: stochVal?.d ?? null,
      cci20: cciVal,
      adx: adxVal,
      adxPlusDi: di?.plus ?? null,
      adxMinusDi: di?.minus ?? null,
      ao: aoCurr,
      mom: momCurr,
      macdMacd: macdVal?.macd ?? null,
      macdSignal: macdVal?.signal ?? null,
      stochRsiK: stochRsiVal?.k ?? null,
      wr,
      bbPowerBull: bb?.bull ?? null,
      bbPowerBear: bb?.bear ?? null,
      uo,
    },
    movingAverages: {
      ema10: ma10E,
      sma10: ma10S,
      ema20: ma20E,
      sma20: ma20S,
      ema30: ma30E,
      sma30: ma30S,
      ema50: ma50E,
      sma50: ma50S,
      ema100: ma100E,
      sma100: ma100S,
      ema200: ma200E,
      sma200: ma200S,
      vwma20,
      hullMa9: hull9,
      ichimokuBLine: cloud?.base ?? null,
    },
    perIndicatorVotes: votes,
  };
};
