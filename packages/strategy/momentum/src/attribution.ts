import type { ReasonAttribution } from '@app/strategy-core';

/**
 * Reason-code -> attribution for momentum's entry blockers. The one home for
 * every per-code display string, so the SPA renders the diagnosis off this
 * declaration (core invariant #1) with no web copy. `gloss` is the operator line;
 * `kind` tints it (market read / config lever / order size / warm-up data);
 * `paths` are the dotted config keys the operator can tune, in priority order; a
 * code with a `note` and no `paths` has no editable lever (a structural rule or a
 * fixed Binance exchange minimum). Static strings only.
 */
export const momentumReasonAttribution: ReasonAttribution = {
  'already-entered-this-candle': {
    setting: 'One entry per cross',
    note: 'a structural rate-limit, not a setting: momentum opens at most one long per EMA cross, so a stop-out inside the same candle cannot immediately re-buy',
    gloss: 'Already opened a position on this candle',
    kind: 'data',
  },
  'insufficient-history': {
    setting: 'Trend filter window',
    note: 'not enough candles loaded yet to compute the trend line (or read its slope); this clears as more candles arrive, or lower the trend-filter period',
    gloss: 'Not enough price history yet to check the trend',
    kind: 'data',
  },
  'below-trend': {
    setting: 'Trend filter',
    paths: ['trendFilter.enabled', 'trendFilter.maType', 'trendFilter.period'],
    gloss: 'Price was below the long-term trend line',
    kind: 'market',
  },
  'falling-trend': {
    setting: 'Trend filter rising-slope',
    paths: ['trendFilter.requireRising', 'trendFilter.slopeLookbackBars'],
    gloss: 'The trend line was still falling (a bear-rally pop)',
    kind: 'market',
  },
  overextended: {
    setting: 'Extension guard',
    paths: [
      'entryExtension.enabled',
      'entryExtension.maType',
      'entryExtension.period',
      'entryExtension.maxPercent',
    ],
    gloss: 'Price was too far above its trend baseline (an overextended entry)',
    kind: 'market',
  },
  'extension-insufficient-history': {
    setting: 'Extension guard window',
    note: 'not enough candles loaded yet to compute the extension-guard baseline; this clears as more candles arrive, or lower the extension-guard period',
    gloss: 'Not enough price history yet to check for overextension',
    kind: 'data',
  },
  'sizing-unconfigured': {
    setting: 'Entry sizing',
    paths: ['entrySizing.mode', 'entrySizing.amount', 'entrySizing.percent'],
    gloss: 'Entry sizing is not configured yet',
    kind: 'sizing',
  },
  'cap-reached': {
    setting: 'Reserve cap',
    paths: ['accountCap.mode', 'accountCap.percent'],
    gloss: 'The account is already at your reserve cap',
    kind: 'config',
  },
  'min-qty': {
    setting: 'Binance minimum quantity',
    note: "Binance's per-symbol minimum order size, not your setting — raise your per-trade budget to clear it",
    gloss: "Order fell below Binance's minimum quantity",
    kind: 'sizing',
  },
  'min-notional': {
    setting: 'Binance minimum notional',
    note: "Binance's per-symbol minimum order value, not your setting — raise your per-trade budget to clear it",
    gloss: "Order fell below Binance's minimum notional",
    kind: 'sizing',
  },
  'invalid-filters': {
    note: 'the exchange filter data for this symbol was missing or malformed, so the order could not be sized safely; clears on the next symbol-info refresh',
    gloss: 'Symbol filter data was invalid',
    kind: 'data',
  },
  // Not an entry blocker: this one says an OPEN position is running without its
  // exchange-side stop, which is the more urgent thing to tell an operator.
  'base-locked-by-foreign-order': {
    setting: 'Protective stop',
    note: 'another sell order already resting on Binance is holding these coins, so the protective stop cannot be placed — cancel that order on Binance (it is usually one left behind by a deleted profile) and the stop arms itself on the next tick',
    gloss: 'Your coins are held by another order, so the protective stop could not be placed',
    kind: 'sizing',
  },
  // The same "open position, no stop" urgency with nobody to blame: the wallet
  // holds less base than the bot's tracked position does.
  'base-short-of-tracked-position': {
    setting: 'Protective stop',
    note: 'the wallet holds none of this coin free, so no protective stop can be placed — the coins were moved, withdrawn, or locked in another order; the stop arms itself once they are back',
    gloss: 'No coins are free to place the protective stop against',
    kind: 'sizing',
  },
  'base-below-exchange-minimum': {
    setting: 'Protective stop',
    note: "the free coins are worth less than Binance's minimum order size, so no protective stop can be placed against them; it arms itself once more of the position is free",
    gloss: 'Too few coins are free to meet the exchange minimum for a protective stop',
    kind: 'sizing',
  },
  // Carries a lever because one shape of this refusal never clears on its own: a
  // limit offset at or under the symbol's floor multiplier puts the order under
  // the band at every possible price.
  'price-outside-exchange-band': {
    setting: 'Protective stop limit offset',
    paths: ['protectiveStop.limitOffsetPercentage'],
    // The map is keyed on the reason code alone and cannot see whether this
    // refusal is the permanent shape, so the gloss says which one the lever
    // answers. Raising the offset when the market is merely moving fast buys
    // nothing and narrows the gap the stop needs to fill in a fast drop.
    gloss:
      'Binance will not accept a protective stop at this price yet; the limit offset is at fault only when the symbol marks the refusal permanent',
    kind: 'sizing',
  },
};
