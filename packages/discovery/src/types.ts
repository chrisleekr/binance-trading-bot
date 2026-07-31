import type { Candle } from '@app/strategy-core';

/**
 * One symbol's 24h ticker snapshot, the generator + ticker-stage filters' only
 * input. Money fields are decimal-strings (wire format); the filters revive
 * them to `Decimal`. `quoteAsset` is resolved by the caller (Slice 3 joins the
 * ticker to exchangeInfo) so the quote-match filter needs no symbol parsing.
 * `bidPrice`/`askPrice` come from the full `/api/v3/ticker/24hr` payload and
 * drive the spread filter.
 *
 * The two USD-denominated volumes are resolved by the caller, not derived here,
 * because they need the whole-exchange ticker payload:
 *
 * - `pairVolumeUsd` is THIS pair's own 24h volume converted to USD. It answers
 *   "can I fill on this book without slipping" — a dollar question, since
 *   slippage is a dollar cost whatever the profile settles in.
 * - `assetVolumeUsd` is the coin's 24h volume on its USDT market, regardless of
 *   the profile's quote asset. It answers "is this a real, actively traded coin
 *   or a dead microcap". `null` when the coin has no USDT market at all.
 *
 * Under `quoteAsset: 'USDT'` the two coincide. Under any other quote they do
 * not, and conflating them is what makes a single volume floor unable to admit
 * an active coin on a thin venue while still rejecting a dead one.
 */
export interface DiscoveryTicker {
  readonly symbol: string;
  readonly quoteAsset: string;
  readonly priceChangePercent: string;
  readonly quoteVolume: string;
  readonly pairVolumeUsd: string;
  readonly assetVolumeUsd: string | null;
  readonly lastPrice: string;
  readonly bidPrice: string;
  readonly askPrice: string;
}

/**
 * Cross-sectional rank of every symbol in the quote universe by 24h change,
 * 1 = biggest gainer. Built once per cycle by `buildRankContext` and threaded
 * into the change-band filter, which is the only per-symbol filter that needs
 * to know about the other symbols.
 *
 * Rank, rather than an absolute percentage, is what makes the band survive a
 * quote-asset change. A coin's return against quote B is `(1 + rA) / (1 + rB) - 1`,
 * which for a fixed `rB > -1` is strictly monotone increasing in `rA` — so
 * re-denominating the universe permutes nothing. The ordering is preserved
 * exactly, and a band expressed over it means the same thing under USDT, BTC,
 * or ETH. An absolute `[5%, 25%]` band does not.
 */
export interface RankContext {
  readonly rankBySymbol: ReadonlyMap<string, number>;
  readonly universeSize: number;
}

/**
 * Trend-confirmation thresholds (the locked seed: ADX(14) > 25, close > EMA20,
 * volume > 1.5 x SMA20 on 1h candles). Periods are counts; `adxMin`/`volMultiple`
 * are decimal-strings so the comparison stays in `Decimal`.
 */
export interface TrendConfirmConfig {
  readonly adxPeriod: number;
  readonly adxMin: string;
  readonly emaPeriod: number;
  readonly volSmaPeriod: number;
  readonly volMultiple: string;
}

/**
 * Correlation cap on NEW discovery adds. A candidate is vetoed if its return
 * correlation with any symbol already in the desired set (kept survivors +
 * earlier adds this cycle) is at or above `maxPairwise`. Stops the auto-set from
 * filling with one beta factor (10 alts that all track BTC). `maxPairwise <= 0`
 * turns the cap off (mirrors the entry-guard '0'-off convention). Only positive
 * correlation is capped — a negatively-correlated pair diversifies, so it is
 * never vetoed. `lookbackCandles` is the number of recent closed candles whose
 * returns the correlation is computed over.
 */
export interface CorrelationConfig {
  readonly maxPairwise: string;
  readonly lookbackCandles: number;
}

/**
 * Profile-scoped discovery settings the pure chain consumes. This is the TYPE
 * the filters read; the zod schema that validates + defaults it, and its
 * storage, land in Slice 3. Money/ratio thresholds are decimal-strings; counts
 * and durations are numbers.
 *
 * Invariant: no field here may carry a meaning that depends on `quoteAsset`.
 * Switching a profile's quote asset must never silently empty the candidate set,
 * so every threshold is either denominated in USD (`min24h*VolumeUsd`), a
 * unit-free ratio (`maxSpreadRatio`, `trendConfirm`, `correlation`), a
 * cross-sectional rank (`rankTopPercent`), or a sign test against the quote
 * itself (`changeMinPercent` at its '0' default). Enforced by the quote-invariance
 * property test in `__tests__/quote-invariance.test.ts`.
 */
export interface DiscoveryConfig {
  readonly quoteAsset: string;
  readonly blacklist: readonly string[];
  // Executability floor: this pair's own 24h volume, in USD. Guards slippage.
  readonly min24hPairVolumeUsd: string;
  // Activity floor: the coin's 24h USDT-market volume, in USD. Guards dead coins.
  readonly min24hAssetVolumeUsd: string;
  readonly maxSpreadRatio: string;
  // Hurdle on the 24h move measured against the quote asset. '0' (the default)
  // is the only fully quote-agnostic value: "the coin beat the thing I hold when
  // I am flat". A non-zero value is a coherent hurdle under any quote, but its
  // strictness varies with the quote's own return distribution.
  readonly changeMinPercent: string;
  // Cross-sectional gain band, in percent of the quote universe by 24h change.
  // Keep a candidate ranked inside the top `rankTopPercent`, after discarding
  // the hottest `rankExcludeTopPercent` as blow-offs.
  readonly rankTopPercent: number;
  readonly rankExcludeTopPercent: number;
  readonly minAgeDays: number;
  readonly maxAutoSymbols: number;
  readonly minHoldMinutes: number;
  // Risk-off floor: the min percent of the quote universe with a positive 24h
  // change before NEW adds are allowed this cycle. '0' disables it. A single
  // coin's 1h strength can be a dead-cat bounce in a market-wide selloff, so the
  // breadth check short-circuits adds when the broad tape is risk-off.
  readonly marketBreadthMinPercent: string;
  readonly trendConfirm: TrendConfirmConfig;
  // Optional so existing fixtures and golden replays (which predate the cap)
  // stay valid; absent or `maxPairwise <= 0` means the add-loop is byte-identical.
  readonly correlation?: CorrelationConfig;
}

/**
 * A symbol currently in the profile's auto-discovered set. `addedAtMs` gates
 * the min-hold-before-reap rule: a freshly rotated-in symbol is not dropped
 * until it has been held at least `minHoldMinutes`, preventing churn.
 */
export interface CurrentAutoSymbol {
  readonly symbol: string;
  readonly addedAtMs: number;
}

/**
 * The full pure-chain input. The Slice-3 cron pre-fetches everything (all
 * tickers in one call; klines per shortlisted symbol) and hands it to
 * {@link runDiscovery}. `lastFlattenAtMsBySymbol` carries the most recent
 * flatten time per symbol (discovery drop OR manual eject) for the hysteresis
 * cooldown. `nowMs` is the injected clock (purity: no `Date` in the chain).
 *
 * Fetch contract for `klinesBySymbol` (the Slice-3 caller MUST honour it):
 * each window is a FIXED-length series of equal-interval candles ascending by
 * open time, long enough to span `config.minAgeDays` (the age filter reads the
 * oldest candle) and to feed ADX/EMA over a stable lookback. A variable window
 * size would make eligibility drift run-to-run for the same symbol.
 */
export interface DiscoveryInput {
  readonly tickers: readonly DiscoveryTicker[];
  readonly klinesBySymbol: Readonly<Record<string, readonly Candle[]>>;
  readonly currentAuto: readonly CurrentAutoSymbol[];
  readonly lastFlattenAtMsBySymbol: Readonly<Record<string, number>>;
  /**
   * Symbols the operator has pinned to `source='manual'`. Discovery treats them
   * as off-limits: never proposed for `add` (so a still-qualifying pinned symbol
   * is not re-adopted to auto, which would clobber its `overrideConfig`) and
   * never surfaced as a discovery candidate. They are NOT in `currentAuto`
   * (which is `source='auto'` only), so they do not count toward the slot cap or
   * the reap set. Optional and defaults to empty: an absent value is the
   * no-manual-members case, so existing callers and golden replays are
   * unaffected.
   */
  readonly manualMembers?: readonly string[];
  readonly config: DiscoveryConfig;
  readonly nowMs: number;
}

/**
 * The deterministic outcome of a discovery cycle. `add` = symbols to rotate in
 * (rank order); `remove` = faded auto symbols past their min-hold, safe to
 * propose for reaping (the repo flat-guard still vetoes a held one); `desired`
 * = the full target auto-set (kept survivors + new adds), for display/debug.
 * Symbols absent from all three are left untouched.
 */
export interface DiscoveryDiff {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly desired: readonly string[];
}

/**
 * Why an eligible candidate the cycle did NOT add was skipped. `resolveDiscovery`
 * emits this as it walks its add-loop, so the explain layer reads the real
 * decision instead of replaying the loop a second time. `cooldown`,
 * `slot-capped`, and `correlation-high` are skip reasons; a kept/manual/added
 * symbol has no entry.
 */
export type DiscoverySkipReason = 'cooldown' | 'slot-capped' | 'correlation-high';
