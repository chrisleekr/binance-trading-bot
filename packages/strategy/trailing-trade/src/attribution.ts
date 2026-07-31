import type { ReasonAttribution } from '@app/strategy-core';
import type { TTConfig } from './schema.js';
import {
  firstBuyClientOrderId,
  gridBuyClientOrderId,
  protectiveStopClientOrderId,
  pyramidBuyClientOrderId,
} from './client-order-id.js';

/**
 * Reason-code → attribution for trailing-trade's entry blockers. This is the one
 * home for every per-code display string, so the SPA renders the whole diagnosis
 * funnel off this declaration (core invariant #1) with no web copy. `gloss` is the
 * operator-facing line; `kind` tints it (market read / config lever / order size /
 * warm-up data); `paths` are dotted config keys in priority order (the consumer
 * reports the first armed one and its value); a code with `note` and no `paths`
 * has no editable lever (a market read or a fixed Binance exchange minimum); a
 * pure `gloss`/`kind` entry is a legible blocker with nothing to tune. Static
 * strings only.
 */
export const ttReasonAttribution: ReasonAttribution = {
  tt_regime_exit_entry_block: {
    setting: 'Regime entry-block',
    paths: ['regime.onBear.blockEntry', 'regime.onBear.exitToCash'],
    note: 'the bear-regime rule, defined by regime.ma / regime.period / regime.confirmBars',
    gloss: 'Regime exit rule blocked new entries',
    kind: 'config',
  },
  tt_regime_filter_veto: {
    setting: 'Regime filter',
    paths: ['regime.onBear.blockEntry', 'regime.onBear.exitToCash'],
    note: 'the bear-regime rule, defined by regime.ma / regime.period / regime.confirmBars',
    gloss: 'Market-regime filter blocked the entry',
    kind: 'config',
  },
  tt_risk_cap_veto: {
    setting: 'Exposure cap',
    paths: ['buy.maxSymbolExposureQuote', 'buy.accountCap'],
    gloss: 'Risk cap blocked the entry (exposure limit reached)',
    kind: 'config',
  },
  tt_discovery_guardrail_veto: {
    setting: 'Auto-discovery guardrail',
    note: 'an auto-discovery safety guard, not a per-config lever — it screens freshly discovered symbols before entry',
    gloss: 'Discovery guardrail blocked the entry',
    kind: 'config',
  },
  tt_discovery_chase_guard_veto: {
    setting: 'Auto-discovery chase guard',
    note: 'an auto-discovery safety guard, not a per-config lever — it blocks entries chasing a symbol that already ran up',
    gloss: 'Chase guard blocked the entry',
    kind: 'config',
  },
  tt_discovery_knife_guard_veto: {
    setting: 'Auto-discovery falling-knife guard',
    note: 'an auto-discovery safety guard, not a per-config lever — it blocks entries into a symbol in a sharp drop',
    gloss: 'Falling-knife guard blocked the entry',
    kind: 'config',
  },
  'indicator-rsi': {
    setting: 'RSI(14) buy ceiling',
    paths: ['buy.indicatorGate.rsiMaxBuy'],
    gloss: 'RSI(14) was above your buy ceiling',
    kind: 'config',
  },
  'indicator-sma': {
    setting: 'SMA(20) bias gate',
    paths: ['buy.indicatorGate.smaBias'],
    gloss: 'Price was on the wrong side of SMA(20) for your bias',
    kind: 'config',
  },
  'indicator-ema': {
    setting: 'EMA(20) bias gate',
    paths: ['buy.indicatorGate.emaBias'],
    gloss: 'Price was on the wrong side of EMA(20) for your bias',
    kind: 'config',
  },
  'indicator-mean-reversion': {
    setting: 'Mean-reversion ceiling',
    paths: ['buy.meanReversionGate.entryZScoreMax'],
    gloss: 'Price was above your mean-reversion z-score ceiling',
    kind: 'config',
  },
  'technicals-disallowed': {
    setting: 'Technicals-gate levels',
    paths: ['technicals.intervals'],
    gloss: 'Rating was bullish, but that level is not enabled in your technicals gate',
    kind: 'config',
  },
  'technicals-sell': {
    setting: 'Technical-rating gate',
    note: 'reads the market, not a setting you tune — relaxing it would buy into a downtrend',
    gloss: 'Technical rating was bearish (Sell / Strong-Sell)',
    kind: 'market',
  },
  'min-purchase': {
    setting: 'Minimum-purchase floor',
    paths: ['buy.gridLevels[0].minPurchaseAmount'],
    note: 'the entry-level order was smaller than this floor — raise the level budget (buy.gridLevels[0].maxPurchaseAmount) or lower the floor',
    gloss: 'Order fell below your configured minimum-purchase floor',
    kind: 'sizing',
  },
  'min-notional': {
    setting: 'Binance minimum notional',
    note: "Binance's per-symbol minimum order value, not your setting — raise your per-trade budget to clear it",
    gloss: "Order fell below Binance's minimum notional",
    kind: 'sizing',
  },
  'min-qty': {
    setting: 'Binance minimum quantity',
    note: "Binance's per-symbol minimum order size, not your setting — raise your per-trade budget to clear it",
    gloss: "Order fell below Binance's minimum quantity",
    kind: 'sizing',
  },
  // Warm-up / invalid-data blockers: legible so the operator reads them, but with
  // no lever to tune (they clear over a longer window or on the next data fetch).
  'technicals-stale': { gloss: 'Technical rating was too old to trust', kind: 'data' },
  'technicals-no-signal': { gloss: 'No technical rating yet (still warming up)', kind: 'data' },
  'indicator-unavailable': { gloss: 'Indicators were still warming up', kind: 'data' },
  'invalid-filters': { gloss: 'Symbol filter data was invalid', kind: 'data' },
};

/**
 * Authoritative attribution of an order to a profile: recompute the
 * clientOrderIds trailing-trade WOULD assign for `(profileId, symbol, config)`
 * and test membership. Returns the strategy's own slot name for the match, so an
 * adopted order lands in the intent the strategy actually manages.
 *
 * The id space is bounded and enumerable for:
 *
 *   - first-buy (`-b`): a single id `(profileId, symbol)`.
 *   - grid (`-g`): one id per level, index `0 .. gridLevels.length - 1`.
 *   - pyramid (`-p`): one id per add, 1-based `1 .. regime.onBull.pyramid.maxAdds`.
 *   - protective stop (`-x`): a single id `(profileId, symbol)` — deliberately
 *     stable so the arm re-finds its own resting order across restarts. This is
 *     the one that matters most here: the protective stop is the order that goes
 *     missing from the local table (a crash between place and persist) and turns
 *     up as an orphan, and handing it to the WRONG profile locks the base asset
 *     against its real owner's stop forever.
 *
 * Sells (`-s`, seeded with avgEntryPrice) and manual orders (`-m`, seeded with a
 * UUID) fold unbounded runtime data into the hash, so they cannot be enumerated
 * and correctly return null: an order this strategy cannot PROVE is its own must
 * not be claimed.
 */
export const ttAttributeOrder = (input: {
  readonly clientOrderId: string;
  readonly profileId: string;
  readonly symbol: string;
  readonly config: TTConfig;
}): { readonly intent: string } | null => {
  const { clientOrderId, profileId, symbol, config } = input;
  if (clientOrderId === protectiveStopClientOrderId(profileId, symbol)) {
    return { intent: 'protective-stop' };
  }
  if (clientOrderId === firstBuyClientOrderId(profileId, symbol)) return { intent: 'grid-buy' };
  for (let i = 0; i < config.buy.gridLevels.length; i++) {
    if (clientOrderId === gridBuyClientOrderId(profileId, symbol, i)) return { intent: 'grid-buy' };
  }
  for (let add = 1; add <= config.regime.onBull.pyramid.maxAdds; add++) {
    if (clientOrderId === pyramidBuyClientOrderId(profileId, symbol, add)) {
      return { intent: 'bull-pyramid' };
    }
  }
  return null;
};
