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
  'risk-sizing-unavailable': {
    setting: 'Risk-based sizing',
    // Only the on/off switch is listed because the consumer reports the FIRST path holding an armed value, and this blocker is raised only from inside `riskSizing.enabled === true`, so that entry is armed every time it fires and anything listed after it is unreachable. `riskPct` would not help even if it were reported: it is the numerator of a division this refusal returns before ever reaching, so no value of it clears the blocker. The ATR period and multiple are dominated the same way, so they are named in the note instead, where the operator reads the condition rather than a value lookup.
    paths: ['riskSizing.enabled'],
    note: 'risk-based sizing needs to know how far below entry the first stop would sit, and it could not work that out. The three you can act on: with the volatility-scaled stop on, there may not be enough closed candles yet to measure this coin’s volatility, which clears as more candles close on this symbol, or the coin may be volatile enough that the stop distance your ATR multiple asks for covers the whole price, which lowering the multiple fixes; with it off, the trailing-stop percent may be missing, or not above 0 and below 100. Any other unusable reading of that distance, such as a flat window with no volatility to measure or an unreadable price, refuses the same way rather than guess a size',
    gloss: 'The stop distance risk-based sizing needs was not available',
    kind: 'sizing',
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
  'entry-below-stop-notional': {
    setting: 'Entry budget',
    note: 'The budget cannot fund the minimum position that would remain sellable at the protective stop',
    gloss: 'The position would be too small to sell at its stop',
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
  // The note names the limit offset because the refusal threshold moves with it, but no `paths` lever is offered: the offset shifts the measured price by a couple of percent, which clears only a position sitting just under the minimum. On the common shape, a position genuinely too small, pointing the operator at that setting would spend their one obvious action on a change that cannot work.
  'base-below-exchange-minimum': {
    setting: 'Protective stop',
    note: "the coins the stop would sell are worth less at the stop's own price — not today's market price — than Binance's minimum order size, so no protective stop can be placed; either the whole position is that small or too little of it is free, so it clears when more of the position frees up, when you add to it or sell it by hand, or when the limit offset is raised so the limit price the minimum is measured at sits closer to the trigger",
    gloss: "The coins the stop would sell are under Binance's minimum order size",
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
  'native-trail-resting': {
    setting: 'Protective stop',
    note: 'Binance is holding an exchange-managed trailing stop for this position. Primary-native replacements are guarded against lowering its effective trigger; band-escape and mode-switch replacements follow their own rules.',
    gloss: 'Binance is holding an exchange-managed trailing stop for this position',
    kind: 'sizing',
  },
  'profit-leg-armed': {
    setting: 'Profit trail',
    paths: ['profitTrail.enabled', 'profitTrail.activationPct', 'profitTrail.trailPct'],
    gloss:
      'Your profit-lock trail has taken over the trailing stop and is holding a tighter trigger than your base setting',
    kind: 'sizing',
  },
  'native-trail-unavailable': {
    setting: 'Protective stop mode',
    paths: ['protectiveStop.mode'],
    gloss:
      'Binance would not accept a trailing stop at the distance your settings ask for, so the bot is using its own resting stop instead',
    kind: 'config',
  },
  // One sentence has to read correctly in two opposite places: on the symbol screen a second after an entry, where this is expected, and on a finding raised because it has lasted, where the position has been unguarded the whole time. The old wording told the operator it was nothing, which is exactly wrong on the second one, so it now says what is expected and for how long, then names the two things that keep an arm from landing.
  'protective-stop-unplaced': {
    setting: 'Protective stop',
    note: 'Expected for a moment right after a new position opens, while the bot places the stop. If it is still showing minutes later, every attempt to place it is being refused and nothing on Binance would sell this position if the price fell: check whether another order is holding the coins, and whether Binance will accept a stop at the price your settings ask for.',
    gloss: 'No protective stop is resting on Binance yet for this position',
    kind: 'sizing',
  },
  'priced-stop-resting': {
    setting: 'Protective stop',
    note: 'This is the normal healthy state when protective stop mode is priced.',
    gloss: 'A fixed-price protective stop is resting on Binance for this position',
    kind: 'sizing',
  },
};
