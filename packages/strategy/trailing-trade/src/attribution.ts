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

  // Exit rungs. These answer "the coin is HELD and did not sell", which is a
  // different question from every code above, and the one an operator asks
  // loudest: each names the rung the position stopped at and the setting that
  // defines it, so a level the bot is not actually watching is never mistaken
  // for one it is.
  'sell-disabled': {
    setting: 'Sell switch',
    paths: ['sell.enabled'],
    gloss: 'Selling is switched off for this profile',
    kind: 'config',
  },
  'exit-order-open': {
    gloss: 'A sell order is already on the book',
    kind: 'market',
  },
  'exit-unsellable': {
    setting: 'Held quantity',
    note: 'the exit triggered but the held amount could not be sold — either the wallet holds none of this coin, or it holds dust below the exchange minimum, which needs a manual top-up or sale',
    gloss: 'An exit triggered but the position could not be sold',
    kind: 'sizing',
  },
  'exit-config-invalid': {
    note: 'a stored exit threshold could not be read, so that rung is inactive — re-save the profile settings',
    gloss: 'An exit setting could not be read',
    kind: 'config',
  },
  'trail-high-raised': {
    gloss: 'Price made a new high and the trailing stop followed it up',
    kind: 'market',
  },
  'atr-trail-above-price': {
    setting: 'ATR trailing stop',
    paths: ['sell.atrTrailing.multiplier'],
    gloss: 'Holding: price is still above the ATR trailing stop',
    kind: 'market',
  },
  'trail-above-price': {
    setting: 'Trailing stop',
    paths: ['sell.trailingStopPercentage'],
    gloss: 'Holding: price is still above the trailing stop',
    kind: 'market',
  },
  'awaiting-sell-arm': {
    setting: 'Sell trigger',
    paths: ['sell.triggerPercentage'],
    note: 'the trailing stop does not exist until price first reaches the sell trigger — below it, no trailing exit can fire at any price',
    gloss: 'Waiting for the sell trigger before the trailing stop arms',
    kind: 'config',
  },
  'break-even-floor-not-hit': {
    setting: 'Break-even floor',
    paths: ['sell.breakEven.floorPercentage'],
    gloss: 'Holding: price is still above the break-even floor',
    kind: 'market',
  },
  'break-even-not-armed': {
    setting: 'Break-even arm',
    paths: ['sell.breakEven.armAtPercentage'],
    gloss: 'The break-even stop has not armed yet',
    kind: 'config',
  },
  'stop-loss-not-hit': {
    setting: 'Stop loss',
    paths: ['sell.stopLossPercentage'],
    gloss: 'Holding: price is still above the stop loss',
    kind: 'market',
  },
  'time-stop-pending': {
    setting: 'Time stop',
    paths: ['sell.timeStopBars', 'sell.discoveryTimeStopBars'],
    gloss: 'Holding: the time stop has not run out of candles yet',
    kind: 'config',
  },
  'no-exit-configured': {
    setting: 'Stop loss',
    paths: ['sell.stopLossPercentage', 'sell.breakEven.enabled', 'sell.atrTrailing.enabled'],
    note: 'nothing configured would exit this position below its entry — it can only be closed by a profit exit or by you',
    gloss: 'This position has no exit below the entry price',
    kind: 'config',
  },
  // Protective-stop refusals. The reason codes come from strategy-core's
  // classifier, so they are shared across strategies, but the levers named here
  // are trailing-trade's own config paths.
  'price-outside-exchange-band': {
    setting: 'Protective-stop limit offset',
    paths: ['sell.protectiveStop.limitOffsetPercentage'],
    note: "Binance refuses a sell priced outside its allowed range. A wider limit offset prices the stop further below the trigger, which is what pushes it under Binance's floor",
    gloss: 'Binance will not accept the protective stop at this price',
    kind: 'market',
  },
  'base-locked-by-foreign-order': {
    note: 'another sell order resting on Binance holds the coins the stop needs; cancelling it there frees them',
    gloss: 'The coins are locked by another order, so no protective stop could be placed',
    kind: 'sizing',
  },
  'base-short-of-tracked-position': {
    note: 'the wallet holds fewer coins than the tracked position, so there is nothing to place the stop against',
    gloss: 'The wallet no longer backs this position, so no protective stop could be placed',
    kind: 'sizing',
  },
  'base-below-exchange-minimum': {
    note: "what is free to sell is under Binance's fixed minimum order size for this pair, which is not a setting you can lower",
    gloss: 'Too few coins are free to meet the exchange minimum for a protective stop',
    kind: 'sizing',
  },
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
