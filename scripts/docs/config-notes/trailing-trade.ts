// Operator guidance for the Trailing Trade config table, keyed by the field
// path the generator emits. Keys must match the schema's leaves exactly, so a
// new setting cannot ship without a "when" and a "what to expect".
import type { FieldNotes } from '@app/contracts';

export const trailingTradeNotes: FieldNotes = {
  // ── Core ───────────────────────────────────────────────────────────────────
  symbol: {
    when: 'Set once when the profile is created. Change it only if you want this profile to trade a different pair entirely.',
    expect:
      "Everything else here applies to this one pair. The quote half must match the profile's quote asset, and the base half cannot already be traded by a sibling profile on the same account.",
  },
  candleInterval: {
    when: 'Set it up front. Shorten it if the strategy reacts too slowly to reversals; lengthen it if it is thrashing on noise.',
    expect:
      'This rescales every candle-counted setting below — time stops, mean-reversion lookback, maker entry timeout. A `60`-candle lookback is 60 hours on `1h` and 60 days on `1d`. Short intervals mean far more ticks, more orders, and more fees.',
  },

  // ── Buy ────────────────────────────────────────────────────────────────────
  'buy.enabled': {
    when: 'Turn it off to wind a position down without deleting the profile — you stop adding but keep selling.',
    expect:
      'Off, no new buys at all, including grid rungs and auto-trigger buys. Existing positions still take profit and still stop out, so this is a safe way to stop accumulating.',
  },
  'buy.entrySizing.mode': {
    when: 'Use `fixed` while learning the strategy — equal-sized trades are easy to compare. Switch to `percentOfAccount` when you want size to track equity and your stop-loss.',
    expect:
      'Only the matching field is read; the other is ignored. Choosing `percentOfAccount` without a stop-loss set makes it a plain percent-of-equity spend rather than a risk-based size.',
  },
  'buy.entrySizing.amount': {
    when: "Only in `fixed` mode. Set it to what one entry should cost, and keep it above Binance's minimum order size for the pair.",
    expect:
      'Every first buy spends this much. Below the exchange minimum the order is rejected and the entry silently never happens — the most common cause of "it never buys".',
  },
  'buy.entrySizing.percent': {
    when: 'Only in `percentOfAccount` mode. Start at 1–2% if you have a stop-loss set, since this is then risk per trade, not spend per trade.',
    expect:
      'With a stop-loss, the buy is sized so hitting the stop costs about this percent of the account — a tighter stop therefore buys more. One buy is capped at half your account. With no stop-loss it simply spends this percent.',
  },
  'buy.avgEntryPriceRemoveThreshold': {
    when: 'Rarely. Set it if a coin has gone to dust and a stale average-cost record is distorting your P/L display.',
    expect:
      'It only acts when the balance is below the tradable minimum, no buy order is open, and price is this far under recorded cost. It cannot touch a real position. Blank disables it.',
  },
  'buy.gridRepriceMinDriftPercent': {
    when: 'Raise it if you see the resting grid buy being cancelled and re-placed constantly on small price wiggles.',
    expect:
      'The resting order only moves when the new target is at least this much lower. Higher means fewer order updates and less request weight, but the order sits further from the ideal price. `0` re-places on any drop.',
  },
  'buy.gridLevels[].triggerPercentage': {
    when: 'Set one per rung when you want to average down. Space the rungs by how far you expect the coin to fall in a normal pullback.',
    expect:
      'The rung buys once price is this far below your average cost. Level 0 is the first entry and ignores this, so leave it at 0. Rungs too close together spend your budget in a shallow dip and leave nothing for a real one.',
  },
  'buy.gridLevels[].stopPricePercentage': {
    when: 'Set it when you want a rung to wait for a bounce to be confirmed instead of catching the falling knife. If you set it, you must also set the limit price.',
    expect:
      'The rung becomes a stop-limit buy that only arms once price rises through this level. You buy higher than a plain dip-buy, but you avoid buying all the way down. Blank keeps it a plain instant buy.',
  },
  'buy.gridLevels[].limitPricePercentage': {
    when: 'Whenever you set a stop price on the same rung. It must be at or above the stop price.',
    expect:
      'The most you will pay once the stop arms. Too tight and a fast move jumps past it and the rung never fills; a wider gap fills more reliably at a worse price.',
  },
  'buy.gridLevels[].minPurchaseAmount': {
    when: 'Set it when the available balance could leave a rung buying an amount too small for the exchange to accept.',
    expect:
      'The rung is skipped rather than placing an order below this. Blank means no floor, so a tiny remaining balance can produce a rejected order.',
  },
  'buy.gridLevels[].maxPurchaseAmount': {
    when: 'Always — it is what each rung actually spends. Size the rungs so the whole ladder fits the budget you are willing to commit to this coin.',
    expect:
      'The rung spends up to this, limited by free balance. Add all the rungs together to see your worst-case exposure to this coin, then check it against the per-symbol cap.',
  },
  'buy.indicatorGate.rsiMaxBuy': {
    when: 'Set it when the strategy keeps buying coins that have already run hot and immediately mean-revert.',
    expect:
      'Buys are refused while RSI sits above this. At `30` you buy only deep dips and trade rarely; at `70` it barely filters. Blank or `0` turns it off.',
  },
  'buy.indicatorGate.smaBias': {
    when: 'Pick a side deliberately. `price-below-sma` suits dip-buying; `price-above-sma` suits buying confirmed strength.',
    expect:
      'Choosing the wrong side for your strategy halves your entries for no benefit. `off` skips the check. It works on the last 20 candles of your candle interval.',
  },
  'buy.indicatorGate.emaBias': {
    when: 'Same decision as the SMA bias, but on a faster-reacting average. Setting both means both must agree.',
    expect:
      'The EMA turns sooner than the SMA, so this gate opens and closes earlier. Setting both gates to opposite sides blocks every buy.',
  },
  'buy.meanReversionGate.entryZScoreMax': {
    when: 'Set it when you only want to buy statistically unusual dips, not routine ones.',
    expect:
      'Measured in standard deviations below the recent mean: `-1` is a common dip, `-2` is rare. Going below `-2` can mean the profile trades only a handful of times a year. Blank turns it off.',
  },
  'buy.meanReversionGate.lookbackCandles': {
    when: 'Only when the mean-reversion gate is on. Lengthen it for a steadier idea of "normal".',
    expect:
      'A short window makes the baseline chase price, so a genuine drop stops looking unusual and the gate stops biting. A long window is steadier but slower to adapt to a new price regime.',
  },
  'buy.autoTriggerBuy.enabled': {
    when: 'Turn it on when you want the profile to keep cycling in and out on its own rather than stopping after each sale.',
    expect:
      'A sale is followed by a fresh buy after the configured delay. This is what makes the strategy continuous — with it off, one round trip ends the trade until something else triggers a buy.',
  },
  'buy.autoTriggerBuy.triggerAfterMinutes': {
    when: 'Lengthen it if the bot keeps buying straight back into a coin that is still falling.',
    expect:
      'The wait after a sell before the next buy is armed. `0` re-buys almost immediately, which in a downtrend means repeatedly buying the same slide. This is separate from the loss cooldown below.',
  },
  'buy.autoTriggerBuy.rescheduleWhileDisabled': {
    when: 'Turn it on if you disable profiles temporarily and do not want to lose the queued re-entry.',
    expect:
      'The buy waits until the profile is enabled again instead of being dropped. On re-enable it may fire immediately at a price far from the one that queued it.',
  },
  'buy.lossCooldownMinutes': {
    when: 'Raise it when you see the strategy stopping out and immediately re-buying the same falling coin.',
    expect:
      'After any exit taken below your average cost, this coin cannot be bought again for this long. It is the main brake on death-by-a-thousand-stop-outs. `0` removes the brake.',
  },
  'buy.firstBuyTriggerBasis': {
    when: 'Switch to `lowest-price` when you would rather wait for a better entry than get in as soon as the gates open.',
    expect:
      '`immediate` buys as soon as conditions allow. `lowest-price` waits for price to return near its recent low, giving a better average but sometimes missing the trade entirely.',
  },
  'buy.candleLimit': {
    when: 'Only when the first-buy basis is `lowest-price`. Shorten it to compare against a more recent low.',
    expect:
      'A long lookback means a low that price may never revisit, so entries become rare. A short one makes almost any dip qualify.',
  },
  'buy.maxSymbolExposureQuote': {
    when: 'Set it whenever you use a grid ladder, so a long slide cannot pour the whole budget into one coin.',
    expect:
      'Once total spend on this coin reaches the cap, further rungs are skipped. This is your hard ceiling on single-coin risk. It is also a prerequisite for the bull pyramid. Blank or `0` disables it.',
  },
  'buy.maxPositionLossQuote': {
    when: 'Set it when you think in "how much can this trade lose" rather than "how much can it cost".',
    expect:
      'A new rung is skipped if, in the worst case of everything selling at the stop-loss, the position would lose more than this. It needs a stop-loss set to mean anything. Blank or `0` disables it.',
  },
  'buy.accountCap.mode': {
    when: 'Turn it on once you run more than one profile, so several profiles cannot each deploy the full account at the same time.',
    expect:
      'The cap is shared across profiles on the same account with the same mode and quote asset. Set the same value on each of them, or the lowest one effectively wins. `off` means no ceiling.',
  },
  'buy.accountCap.amount': {
    when: 'Only in `amount` mode. Set the same figure on every profile that should share the ceiling.',
    expect:
      'New buys stop once holdings across those profiles reach this. Different values on sibling profiles produce confusing behaviour, since each enforces its own number.',
  },
  'buy.accountCap.percent': {
    when: 'Only in `percent` mode. Use it when you want the reserve to scale with the account rather than being fixed.',
    expect:
      'At `50`, roughly half the account stays in cash. The cap moves with equity, so a drawdown also shrinks the allowed deployment.',
  },

  // ── Sell ───────────────────────────────────────────────────────────────────
  'sell.enabled': {
    when: 'Effectively never turn it off. The only defensible reason is that you intend to manage exits by hand.',
    expect:
      'Off disables both the stop-loss and the trailing sell, leaving positions completely unprotected while the profile keeps holding them.',
  },
  'sell.stopLossPercentage': {
    when: 'Set it before going live. Size it to how far the coin normally moves against you in a candle or two, so ordinary noise does not trigger it.',
    expect:
      'Sells at market once price is this far below your average cost. Tighter caps losses but stops you out on noise; wider survives noise but each loss is bigger. Blank disables it, which also disables risk-based position sizing.',
  },
  'sell.triggerPercentage': {
    when: 'Set it just above your round-trip fee plus a margin, so the trail cannot arm on a gain that is not actually a gain.',
    expect:
      'The trailing stop does nothing until you are this far in profit. Set it high and you often exit on the stop-loss instead of the trail; set it too low and it arms on noise.',
  },
  'sell.trailingStopPercentage': {
    when: 'Tighten it if winners keep giving back most of their gain. Widen it if you are exiting early on normal pullbacks.',
    expect:
      'Once armed, sells after price falls this far from its high. This single number decides how much of a move you keep — it is usually the setting worth tuning first.',
  },
  'sell.atrTrailing.enabled': {
    when: 'Turn it on when one fixed percentage cannot suit both quiet and violent periods for this coin.',
    expect:
      'The trail distance follows recent volatility instead of a fixed percent. It falls back to the fixed percent until enough candles exist, so a fresh profile behaves as before for a while.',
  },
  'sell.atrTrailing.fromEntry': {
    when: 'Turn it on for trend-following, where you want the volatility trail protecting the trade from the moment you buy.',
    expect:
      'Protection starts at entry rather than only after the profit trigger. That means an exit can now happen at a loss on the trail, not only on the stop-loss.',
  },
  'sell.atrTrailing.period': {
    when: 'Only when ATR trailing is on. Shorten it to react faster to a change in volatility.',
    expect:
      'A short period makes the trail distance jump around; a long one is smoother but slower to widen when the coin turns volatile.',
  },
  'sell.atrTrailing.multiplier': {
    when: 'Only when ATR trailing is on. This is the ATR equivalent of the trailing percentage and the main dial to tune.',
    expect:
      'The trail sits this many ATRs below the peak. At `3`, a coin whose ATR is 2% of price gets about 6% of room, and that room breathes with volatility.',
  },
  'sell.protectiveStop.enabled': {
    when: 'Turn it on for any position you are not comfortable leaving unprotected if the bot goes down.',
    expect:
      'A real stop order rests on Binance at your stop-loss level, so a crash or restart cannot leave you exposed. Needs a stop-loss percent set. Costs one extra resting order per position.',
  },
  'sell.protectiveStop.limitOffsetPercentage': {
    when: 'Only when the protective stop is on. Widen the gap on thin or volatile coins.',
    expect:
      "A wide gap fills reliably in a fast drop at a worse price; a tiny gap risks the stop triggering and never filling, leaving you holding through the fall. `0.995` puts the limit 0.5% below the trigger. There is also a hard floor under this value: at or below the symbol's Binance `askMultiplierDown` the stop cannot be placed at all, and the symbol reports a terminal blocker until you raise it.",
  },
  'sell.breakEven.enabled': {
    when: 'Turn it on when trades keep popping into small profit, stalling, and then running all the way down to the stop-loss.',
    expect:
      'Once armed, a fallback to your entry exits the trade near flat instead of taking the full stop-loss. The cost is more exits that would have recovered.',
  },
  'sell.breakEven.armAtPercentage': {
    when: 'Only when break-even protection is on. Raise it if the protection is arming on ordinary wiggle.',
    expect:
      'Nothing happens until price rises this far above entry. Arming very early makes almost every trade exit near flat, which caps your winners as well as your losers.',
  },
  'sell.breakEven.floorPercentage': {
    when: 'Only when break-even protection is on. Raise it slightly above your round-trip fee so a break-even exit is not a net loss.',
    expect:
      'Once armed, price slipping back to this level exits. At `1` you exit right at entry, which after fees is a small loss; `1.002` locks in 0.2%. Keep it below the arming level.',
  },
  'sell.discoveryTimeStopBars': {
    when: 'Set it above 0 when auto-discovery positions sit flat for long stretches, tying up money that could work elsewhere.',
    expect:
      'A discovery-opened position that has neither taken profit nor stopped out is sold after this many candles, possibly at a small loss. Only affects discovery positions. `0` turns it off.',
  },
  'sell.timeStopBars': {
    when: 'Set it above 0 to free capital from positions that go nowhere, when you enter positions yourself.',
    expect:
      'Only fires when the position never even reached your sell trigger — one that did is left to the trailing stop. `0` turns it off. Discovery positions use their own setting.',
  },
  'sell.forceSellMinProfitPercent': {
    when: 'Set it to at least your round-trip fee. Leaving it at `0` lets a signal-driven exit book a gain smaller than the fee, which is a net loss.',
    expect:
      'A signal-driven sell is refused below this profit; the position is held until the trailing stop or stop-loss handles it instead. Set very high and signal exits effectively never fire.',
  },

  // ── Regime ─────────────────────────────────────────────────────────────────
  'regime.ma': {
    when: 'Pick once. `ema` turns faster and re-admits buying sooner after a downtrend; `sma` is steadier.',
    expect:
      '`ema` produces more regime flips, so any bear behaviour you enable engages and disengages more often. `sma` is slower in both directions.',
  },
  'regime.period': {
    when: 'Shorten it if regime protection reacts far too late to a turn. Lengthen it if it flips constantly.',
    expect:
      'This is measured in **days**, not in your candle interval. `200` is the classic long-term trend; `20`–`50` reacts quickly but flips on noise.',
  },
  'regime.confirmBars': {
    when: 'Raise it if the regime is flipping on single-day pokes below the line.',
    expect:
      'Requires this many consecutive daily closes on the other side before the regime changes. Higher means fewer false alarms and a slower reaction — `3` typically costs you three days at each turn.',
  },
  'regime.exposure.enabled': {
    when: 'Turn it on when you want the profile to bet smaller in unclear markets rather than all-or-nothing.',
    expect:
      'Only the non-grid first buy is scaled. A confirmed uptrend buys full size, a downtrend buys nothing, and a flat market buys the fraction below.',
  },
  'regime.exposure.neutralScalar': {
    when: 'Only when exposure scaling is on. Lower it to sit out unclear markets almost entirely.',
    expect:
      '`0` means no buying at all while the trend is flat — and markets are flat a lot of the time, so this can silence the profile for weeks. `0.5` buys half size.',
  },
  'regime.onBear.exitToCash': {
    when: 'Only if you accept deliberately selling at a loss to avoid a larger drawdown. This is the most aggressive bear option.',
    expect:
      'The entire position is sold when the daily trend turns down, and buying stops until it recovers. On a false signal you sell the bottom and buy back higher.',
  },
  'regime.onBear.blockEntry': {
    when: 'A gentler first choice than exit-to-cash. Turn it on when backtests show losses concentrated in downtrend entries.',
    expect:
      'No new positions while the trend is down, but you keep what you hold, protected by its own stop and trail. You also sit out the first part of the recovery.',
  },
  'regime.onBear.suppressPromotion': {
    when: 'Turn it on if the grid ladder keeps averaging down through an extended decline.',
    expect:
      'Averaging-down rungs stop firing while price is below the trend line. You stop throwing good money after bad, but you also do not lower your average cost into the eventual recovery.',
  },
  'regime.onBear.rearm.enabled': {
    when: 'Turn it on when bear protection keeps you out long after the market has visibly turned.',
    expect:
      'Buying can resume on a faster signal instead of waiting for the daily trend line. It reintroduces exactly the risk the bear block was protecting you from, on false bounces. Ignored when exit-to-cash is on.',
  },
  'regime.onBear.rearm.interval': {
    when: 'Only when re-arm is on. It must be an interval you actually have signals computing for, or re-arm never fires.',
    expect:
      'A short interval re-arms early and often, catching more false bounces. `4h` turns ahead of the daily line without the noise of minute timeframes.',
  },
  'regime.onBear.rearm.minRecommendation': {
    when: 'Only when re-arm is on. Use `STRONG_BUY` unless re-arm almost never fires.',
    expect:
      '`STRONG_BUY` re-arms later and less often, which is the safer setting. `BUY` re-arms sooner and catches more bounces that fail.',
  },
  'regime.onBull.hold.enabled': {
    when: 'Turn it on when strong uptrends keep stopping you out on ordinary dips well before the move ends.',
    expect:
      'Winners get more room during confirmed uptrends, so you ride further — and hand back more when the trend finally turns.',
  },
  'regime.onBull.hold.room': {
    when: 'Only when bull hold is on. Move toward `loose` if you are still exiting early in strong trends.',
    expect:
      '`loose` rides the biggest swings and gives back the most near a top; `tight` behaves closest to the normal trail.',
  },
  'regime.onBull.pyramid.enabled': {
    when: 'Only for a deliberate trend-following setup, and only after a backtest. It is the one path that deploys capital **up** into strength.',
    expect:
      'Refuses to enable without a per-symbol or account cap armed, because it would otherwise buy without limit. Your average cost rises as you add, so a reversal near the top hurts more than a single entry would.',
  },
  'regime.onBull.pyramid.stepPercentage': {
    when: 'Only when the pyramid is on. Raise it to add more rarely and keep your average cost lower.',
    expect:
      'A small step builds the position quickly and pushes your average cost up fast. `0.05` adds every 5% of upward move.',
  },
  'regime.onBull.pyramid.maxAdds': {
    when: 'Only when the pyramid is on. This is your hard limit on how big a winning position can grow.',
    expect:
      'Caps how much you can give back if the trend reverses near the top. Combined with the per-add amount it tells you the worst-case size of a pyramided position.',
  },
  'regime.onBull.pyramid.maxPurchaseAmount': {
    when: 'Only when the pyramid is on. Size it smaller than your first entry — each add is at a worse price.',
    expect:
      'Each add spends this much. Multiply by max adds to see the total the pyramid can commit on top of the original entry, then check that against your per-symbol cap.',
  },
  'regime.onBull.requireEntry': {
    when: 'Turn it on when you only want to open positions in confirmed uptrends.',
    expect:
      'Strict by design: if the trend cannot be confirmed yet — for instance right after a restart, before enough daily history is loaded — it stays out rather than guessing. Expect long quiet periods.',
  },

  // ── Force-buy override ─────────────────────────────────────────────────────
  'forceBuyOverride.checkTechnicals': {
    when: 'Leave on. Turn it off only for a manual buy on a coin you have looked at yourself and decided about.',
    expect:
      'On, a manual buy is refused when the technical reading says sell. Off, that protection is gone entirely for manual buys.',
  },

  // ── Technicals ─────────────────────────────────────────────────────────────
  'technicals.useOnlyWithinMin': {
    when: 'Raise it only if legitimate signals are being treated as expired — for instance if the technicals cron is running behind.',
    expect:
      'A signal older than this counts as expired and the expiry policy below applies. Set it very low and normal tick jitter makes live signals look stale, so buying stops.',
  },
  'technicals.ifExpires': {
    when: 'Leave at `do-not-buy`. Choose `allow-anyway` only if signal outages are blocking trading you want to happen.',
    expect:
      '`do-not-buy` fails safe: no signal, no buy. `allow-anyway` lets a stale reading pass the gate, so you can buy on information that is minutes or hours out of date.',
  },
  'technicals.entryConfirmReads': {
    when: 'Raise it above 1 if first entries keep opening on a signal that flickers back a moment later.',
    expect:
      'The rating must stay a buy for this many consecutive readings before the first entry. Higher means later entries and fewer of them.',
  },
  'technicals.intervals[].interval': {
    when: 'Add one row per timeframe you want consulted. It must be a timeframe the strategy computes signals for.',
    expect:
      'An interval with no signals produces nothing, and the row is inert. Adding more intervals makes the buy gate stricter, since they are ANDed together.',
  },
  'technicals.intervals[].whenStrongBuy': {
    when: 'Leave on. Turning it off on every row leaves the gate with nothing that can permit a buy.',
    expect:
      'Allows a buy when this timeframe reads STRONG_BUY. The gate ANDs across every row whose allow-buy set is non-empty, so all of them must be satisfied.',
  },
  'technicals.intervals[].whenBuy': {
    when: 'Turn it off to demand STRONG_BUY only, when you want fewer and higher-conviction entries.',
    expect:
      'Off, an ordinary BUY on this timeframe no longer permits an entry. NEUTRAL always passes; SELL and STRONG_SELL always veto, regardless of this.',
  },
  'technicals.intervals[].whenSell': {
    when: 'Turn it on when you want signal-driven profit-taking rather than waiting for the trailing stop.',
    expect:
      'Only fires while the position is in profit and below its sell trigger, and only above the minimum-profit floor. Off by default, because it exits winners early more often than it saves them.',
  },
  'technicals.intervals[].whenStrongSell': {
    when: 'The more defensible of the two force-sell triggers — turn this on before the plain SELL one.',
    expect:
      'Same profit and below-trigger guards as SELL, but fires only on the stronger reading, so it triggers far less often.',
  },
  'technicals.intervals[].whenNeutral': {
    when: 'Effectively never. It exists for completeness.',
    expect:
      'NEUTRAL is the most common reading, so this exits nearly every profitable position almost immediately.',
  },
  'technicals.intervals[].mode': {
    when: 'Set a row to `advisory` when you want to see what it would have done before letting it veto real buys.',
    expect:
      '`advisory` rows never block a buy, but their verdict is still recorded so the dashboard can show "would have vetoed". `block` is the real gate.',
  },
  'technicals.forceSellConfirmMinutes': {
    when: 'Raise it if signal-driven sells are firing on brief blips. Leave blank to use one candle of your shortest configured timeframe.',
    expect:
      'The sell signal must persist this long before acting. Higher confirms better but exits later and lower. `0` sells on the first reading, blips included.',
  },
  'technicals.forceSellReentryCooldownMinutes': {
    when: 'Raise it if the bot sells on a signal and buys straight back into the same decline. Leave blank for 60 minutes.',
    expect:
      'No buy on this coin for this long after a signal-driven sell. `0` means it can re-buy immediately, which in a downtrend repeats the same losing round trip.',
  },

  // ── Fees ───────────────────────────────────────────────────────────────────
  'fees.takerBps': {
    when: 'Set it before your first backtest, to your real Binance spot fee — about 10 bps at VIP0, less with the BNB discount.',
    expect:
      'Left at `0`, every backtest overstates profit and the minimum-profit floor lets exits book a loss. This is one of the most consequential settings on the page.',
  },
  'fees.makerBps': {
    when: 'Set it alongside the taker fee. At VIP0 the two are equal.',
    expect:
      'Used for resting limit fills in backtests. Live trading charges the taker fee. Setting it below your real fee makes maker mode look better than it is.',
  },

  // ── Execution ──────────────────────────────────────────────────────────────
  'execution.entryMode': {
    when: 'Switch to `maker` only after a backtest of the maker config beats market for your pair. It does not lower your fee at VIP0.',
    expect:
      '`maker` saves the spread and slippage but risks never filling. Changing this changes the config fingerprint, so the profile needs a fresh backtest before it can go live.',
  },
  'execution.makerOffsetBps': {
    when: 'Only in `maker` mode. Use a small positive value rather than `0` if you want the order to genuinely rest on the book.',
    expect:
      'At `0` the order can match immediately and fill as a taker anyway. A large offset on a low-priced coin can fall below the exchange minimum and silently become a market buy.',
  },
  'execution.entryTimeoutBars': {
    when: 'Only in `maker` mode. Set it so a patient buy cannot sit at a price the market has walked away from.',
    expect:
      'An unfilled resting buy is cancelled after this many closed candles and re-priced next tick. `0` leaves it resting indefinitely, even if price runs far above it.',
  },
};
