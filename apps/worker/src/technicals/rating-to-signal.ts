// Pure rating → wire-signal mapping, shared by the live technicals-compute
// cron and the backtest runner so the score→recommendation bucketize and the
// TechnicalsSignal field projection cannot drift between live and backtest.

import {
  TechnicalsSignalSchema,
  type TechnicalsRecommendation,
  type TechnicalsSignal,
} from '@app/contracts';
import { ema as emaPrim, sma as smaPrim, type CandleWindow } from '@app/indicators';
import type { computeTechnicalsRating } from '@app/indicators/rating';

type Rating = ReturnType<typeof computeTechnicalsRating>;

/**
 * Map a rating score in [-1, 1] to a recommendation, per TradingView's
 * Technical Ratings thresholds:
 *   score >= 0.5 → STRONG_BUY; >= 0.1 → BUY; <= -0.5 → STRONG_SELL;
 *   <= -0.1 → SELL; otherwise NEUTRAL (strict on both sides).
 */
export const bucketize = (score: number): TechnicalsRecommendation => {
  if (score >= 0.5) return 'STRONG_BUY';
  if (score >= 0.1) return 'BUY';
  if (score <= -0.5) return 'STRONG_SELL';
  if (score <= -0.1) return 'SELL';
  return 'NEUTRAL';
};

// decimal.js is banned outside the money-math packages, so the rating layer's
// Decimal outputs are converted at this boundary to the float wire format.
const toNum = (d: { toNumber(): number } | null): number | null =>
  d === null ? null : d.toNumber();

/** Build the contract-shaped {@link TechnicalsSignal} from a rating + its source window. */
export const ratingToSignal = (
  symbol: string,
  window: CandleWindow,
  rating: Rating,
  receivedAtMs: number,
): TechnicalsSignal => {
  // ema5/sma5 are UI-only courtesy fields the rating layer does not compute
  // (TV's vote rule only consumes EMA10+); fill them from the primitives.
  const ema5 = emaPrim(window, 5);
  const sma5 = smaPrim(window, 5);
  // Wire `bbPower` is a single nullable number; the rating reports bull/bear
  // separately. Summing the pair gives a representative display strength.
  const bull = toNum(rating.oscillators.bbPowerBull);
  const bear = toNum(rating.oscillators.bbPowerBear);
  const bbCombined = bull === null || bear === null ? null : bull + bear;
  const maRecommendation = bucketize(rating.recommendMa.toNumber());
  const oscRecommendation = bucketize(rating.recommendOther.toNumber());
  return TechnicalsSignalSchema.parse({
    symbol,
    recommendation: bucketize(rating.recommendAll.toNumber()),
    maRecommendation,
    oscRecommendation,
    receivedAtMs,
    indicators: {
      oscillators: {
        rsi: toNum(rating.oscillators.rsi),
        stochK: toNum(rating.oscillators.stochK),
        stochD: toNum(rating.oscillators.stochD),
        cci20: toNum(rating.oscillators.cci20),
        adx: toNum(rating.oscillators.adx),
        adxPlusDi: toNum(rating.oscillators.adxPlusDi),
        adxMinusDi: toNum(rating.oscillators.adxMinusDi),
        ao: toNum(rating.oscillators.ao),
        mom: toNum(rating.oscillators.mom),
        macdMacd: toNum(rating.oscillators.macdMacd),
        macdSignal: toNum(rating.oscillators.macdSignal),
        stochRsiK: toNum(rating.oscillators.stochRsiK),
        wr: toNum(rating.oscillators.wr),
        bbPower: bbCombined,
        uo: toNum(rating.oscillators.uo),
      },
      movingAverages: {
        ema5: ema5 === null ? null : ema5.toNumber(),
        ema10: toNum(rating.movingAverages.ema10),
        ema20: toNum(rating.movingAverages.ema20),
        ema30: toNum(rating.movingAverages.ema30),
        ema50: toNum(rating.movingAverages.ema50),
        ema100: toNum(rating.movingAverages.ema100),
        ema200: toNum(rating.movingAverages.ema200),
        sma5: sma5 === null ? null : sma5.toNumber(),
        sma10: toNum(rating.movingAverages.sma10),
        sma20: toNum(rating.movingAverages.sma20),
        sma30: toNum(rating.movingAverages.sma30),
        sma50: toNum(rating.movingAverages.sma50),
        sma100: toNum(rating.movingAverages.sma100),
        sma200: toNum(rating.movingAverages.sma200),
        vwma: toNum(rating.movingAverages.vwma20),
        hullMa9: toNum(rating.movingAverages.hullMa9),
        ichimokuBLine: toNum(rating.movingAverages.ichimokuBLine),
      },
    },
  });
};
