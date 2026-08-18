import { adx, ema } from '@app/indicators/rating';
import type { Candle } from '@app/strategy-core';
import Decimal from 'decimal.js';
import type { DiscoveryConfig, DiscoveryTicker, RankContext } from './types.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/**
 * Below this many symbols there is no meaningful cross-section to rank against
 * (with N members the top symbol only reaches the (N-1)/N percentile, so a thin
 * universe would reject everything). The rank band then fails open and the
 * `changeMinPercent` sign gate plus the kline-stage trend filter carry the load.
 */
export const MIN_UNIVERSE_FOR_RANK = 10;

/** Filter 1 — quote-match: the symbol trades against the configured quote asset. */
export const matchesQuote = (t: DiscoveryTicker, cfg: DiscoveryConfig): boolean =>
  t.quoteAsset === cfg.quoteAsset;

/**
 * Filter 2 — asset policy: the base asset is not a stablecoin or a fiat currency. Non-configurable, and deliberately so. Discovery hunts 24h gainers, and a pegged asset has no gainer signal to read — its ordinary peg noise clears an inclusive `changeMinPercent >= 0` hurdle, so it enters on nothing and then sits there.
 *
 * The verdict is a fact the caller resolved from fresh Binance product metadata, not a rule evaluated here. This package holds no asset list: a code-owned registry is stale the day a new stablecoin lists, and no name or price heuristic can tell a peg from a coin that happens to trade near a dollar.
 *
 * @param t - The candidate ticker. Only `isStablecoinOrFiat` is read: the symbol text and the price are deliberately ignored, since neither can establish that an asset is pegged.
 * @returns Whether the coin is eligible to go on to the remaining stages — true for an ordinary asset, false when Binance currently classifies its base a stablecoin or a fiat currency.
 */
export const passesAssetPolicy = (t: DiscoveryTicker): boolean => !t.isStablecoinOrFiat;

/** Filter 3 — blacklist: the operator never wants this symbol auto-added. Runs after the asset policy, so a symbol on the blocklist for an unrelated reason is still reported against the rung that actually disqualifies it. */
export const notBlacklisted = (t: DiscoveryTicker, cfg: DiscoveryConfig): boolean =>
  !cfg.blacklist.includes(t.symbol);

/**
 * Filter 4 — liquidity: the pair's own 24h volume, in USD, clears the floor so
 * fills don't slip. Denominated in USD rather than the quote asset because
 * slippage is a dollar cost regardless of what the profile settles in.
 *
 * This is a coarse sanity floor. 24h turnover is a weak proxy for the real
 * quantity (order-book depth at your size), which the ticker payload doesn't
 * carry; {@link withinSpread} is the sharper execution gate.
 */
export const meetsLiquidity = (t: DiscoveryTicker, cfg: DiscoveryConfig): boolean =>
  new Decimal(t.pairVolumeUsd).gte(cfg.min24hPairVolumeUsd);

/**
 * Filter 5 — activity: the COIN is actively traded, measured on its USDT market
 * in USD, independent of the pair this profile would trade it on. Separate from
 * {@link meetsLiquidity} because a coin can be enormously active as an asset
 * while its BTC book is a ghost town, and one threshold cannot both admit that
 * coin and reject a dead one whose thin book happens to churn.
 *
 * Fails closed when the coin has no USDT market: an asset with no stablecoin
 * venue has no measurable activity, and is not something to auto-discover.
 */
export const isActive = (t: DiscoveryTicker, cfg: DiscoveryConfig): boolean =>
  t.assetVolumeUsd !== null && new Decimal(t.assetVolumeUsd).gte(cfg.min24hAssetVolumeUsd);

/**
 * Filter 6 — spread: the bid/ask spread ratio `(ask - bid) / mid` is within
 * the cap. A non-positive bid/ask or a crossed book (`ask < bid`) is treated as
 * untradable and rejected rather than producing a misleading ratio.
 *
 * A ratio, so it needs no quote-asset adjustment: 0.3% costs 0.3% whatever the
 * numéraire. Thin BTC books legitimately fail it more often than USDT books, and
 * that rejection is the filter working, not a threshold to loosen.
 */
export const withinSpread = (t: DiscoveryTicker, cfg: DiscoveryConfig): boolean => {
  const bid = new Decimal(t.bidPrice);
  const ask = new Decimal(t.askPrice);
  if (bid.lte(0) || ask.lte(0) || ask.lt(bid)) return false;
  const mid = ask.plus(bid).div(2);
  return ask.minus(bid).div(mid).lte(cfg.maxSpreadRatio);
};

/**
 * Filter 7 — change band (anti-pump), in two parts:
 *
 * 1. An absolute hurdle: the 24h move against the quote clears `changeMinPercent`.
 *    At its '0' default this reads "the coin beat the asset I hold when flat",
 *    which is the one absolute threshold that means the same thing under every
 *    quote asset.
 * 2. A cross-sectional band: the symbol ranks inside the top `rankTopPercent` of
 *    the quote universe by 24h change, after discarding the hottest
 *    `rankExcludeTopPercent` as blow-offs already running.
 *
 * The upper bound is a rank rather than an absolute percentage because rank is
 * invariant to the quote asset (see {@link RankContext}) while a percentage is
 * not: a 25% 24h gain is a blow-off against USDT and unreachable against BTC.
 * Rank also self-calibrates across regimes, where a fixed percentage band is
 * mistuned in any market that is not the one it was tuned in.
 *
 * A symbol outside the ranked universe cannot be judged and is rejected. Below
 * {@link MIN_UNIVERSE_FOR_RANK} members the band fails open — see that constant.
 */
export const withinChangeBand = (
  t: DiscoveryTicker,
  cfg: DiscoveryConfig,
  ctx: RankContext,
): boolean => {
  if (!new Decimal(t.priceChangePercent).gte(cfg.changeMinPercent)) return false;
  const rank = ctx.rankBySymbol.get(t.symbol);
  if (rank === undefined) return false;
  if (ctx.universeSize < MIN_UNIVERSE_FOR_RANK) return true;
  const size = new Decimal(ctx.universeSize);
  // The kept slice rounds UP so "top N%" always names at least one coin: a bare
  // product floors below 1 on a small universe (top 1% of 99 names = 0.99) and
  // would reject even the biggest gainer, silently emptying the set. The skipped
  // slice keeps its bare product, so a fraction of a name rounds down to skipping
  // none — the conservative direction for a guard that discards candidates.
  const hottest = size.times(cfg.rankExcludeTopPercent).div(100);
  const coldest = size.times(cfg.rankTopPercent).div(100).ceil();
  const position = new Decimal(rank);
  return position.gt(hottest) && position.lte(coldest);
};

/**
 * Filter 8 — age: the symbol has at least `minAgeDays` of kline history. Binance
 * spot exchangeInfo carries no listing date, so age is approximated from the
 * oldest candle in the window (klines are ascending by open time). An empty
 * window fails.
 */
export const oldEnough = (
  klines: readonly Candle[],
  cfg: DiscoveryConfig,
  nowMs: number,
): boolean => {
  const oldest = klines[0];
  if (!oldest) return false;
  return oldest.openTimeMs <= nowMs - cfg.minAgeDays * MS_PER_DAY;
};

/**
 * Simple moving average of the last `period` candle volumes, in `Decimal`.
 * Returns null when the window is shorter than `period` (the trend-confirm
 * filter treats that as "not confirmed"). The adapter's `sma` averages closes,
 * not volume, so this is computed locally.
 */
export const volumeSma = (klines: readonly Candle[], period: number): Decimal | null => {
  if (klines.length < period) return null;
  const slice = klines.slice(klines.length - period);
  let sum = new Decimal(0);
  for (const c of slice) sum = sum.plus(c.volume);
  return sum.div(period);
};

/**
 * Filter 9 — trend-confirm: the candidate is in a confirmed up-move —
 * ADX(adxPeriod) >= adxMin (directional strength), last close > EMA(emaPeriod)
 * (price above trend), and last volume > volMultiple x SMA(volSmaPeriod) of
 * volume (participation). Any indicator returning null (window too short) fails
 * closed: an unconfirmed symbol is never rotated in.
 */
export const trendConfirmed = (klines: readonly Candle[], cfg: DiscoveryConfig): boolean => {
  // Read the last candle first so the empty-window guard is independently
  // reachable (an empty window also nulls every indicator below).
  const last = klines[klines.length - 1];
  if (last === undefined) return false;
  const { adxPeriod, adxMin, emaPeriod, volSmaPeriod, volMultiple } = cfg.trendConfirm;
  const adxVal = adx(klines, adxPeriod);
  const emaVal = ema(klines, emaPeriod);
  const volAvg = volumeSma(klines, volSmaPeriod);
  if (adxVal === null || emaVal === null || volAvg === null) return false;
  const close = new Decimal(last.close);
  const lastVol = new Decimal(last.volume);
  return adxVal.gte(adxMin) && close.gt(emaVal) && lastVol.gt(volAvg.times(volMultiple));
};

/**
 * Filter 11 — hysteresis cooldown: a symbol flattened (discovery drop OR manual
 * eject) within `minHoldMinutes` of now is on cooldown and must not be re-added,
 * preventing add/flatten/re-add thrash. A symbol with no flatten record is not
 * on cooldown. (Filter 10, the slot cap, is a cross-symbol concern and lives in
 * `resolveDiscovery`, not here.)
 *
 * The cooldown deliberately reuses `minHoldMinutes` rather than a separate dial:
 * the locked design (#423) makes one knob serve both the re-add cooldown and the
 * min-hold-before-reap window, split only if a backtest shows whipsaw.
 */
export const inCooldown = (
  lastFlattenAtMs: number | undefined,
  cfg: DiscoveryConfig,
  nowMs: number,
): boolean => {
  if (lastFlattenAtMs === undefined) return false;
  return nowMs - lastFlattenAtMs < cfg.minHoldMinutes * MS_PER_MINUTE;
};

/** Whether a current auto symbol has been held long enough to be eligible for reaping. */
export const heldLongEnough = (addedAtMs: number, cfg: DiscoveryConfig, nowMs: number): boolean =>
  nowMs - addedAtMs >= cfg.minHoldMinutes * MS_PER_MINUTE;
