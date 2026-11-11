// Operator guidance for the Momentum config table, keyed by the field path the
// generator emits. Keys must match the schema's leaves exactly.
import type { FieldNotes } from '@app/contracts';

export const momentumNotes: FieldNotes = {
  candleInterval: {
    when: 'Set it once, up front. Shorten it if the strategy is missing moves that are over before it reacts; lengthen it if it is entering on noise.',
    expect:
      'Every other candle-counted setting here (EMA periods, ATR period, trend period) is measured in candles of this interval, so changing it silently rescales all of them. A 200-period trend filter is 200 hours on `1h` and 200 days on `1d`.',
  },
  trailingStopPct: {
    when: 'Widen it if you are being stopped out of trades that then continue up. Tighten it if winners keep giving back most of their gain.',
    expect:
      'This is the only exit the strategy has by default: the position sells once price falls this far from its highest point since entry. Too tight and normal wobble ends every trade; too wide and a full round trip can end flat.',
  },
  entryMarginPct: {
    when: 'Raise it above 0 when the fast and slow EMAs are crossing back and forth and you are getting chopped up by false starts.',
    expect:
      'Requiring a margin means fewer entries, later. You give up the earliest part of a move in exchange for skipping crosses that immediately reverse. `0` takes every bare cross.',
  },
  entryTrigger: {
    when: 'Switch to `trend` when discovery feeds the profile and the tick trace keeps saying `fall-back-then-cross-up`: discovery adds coins after they have crossed, so `cross` rarely gets a chance to buy them.',
    expect:
      '`trend` enters more often and later in a move, so the trend filter and extension guard do more of the filtering. Expect more stop-outs per entry than `cross`; at most one entry per candle still applies. `breakout` ignores the EMA entry signal and buys a close above the recent range high (`breakoutLookback`); pair it with `atrTrailingStop` so a failed breakout is cut quickly. `impulse` buys right after a heavy-volume up candle (`impulse` block); keep it small: it has made money only in some regimes. `maCluster` buys the close that clears the 20, 50, 100 and 200 candle averages once they have bunched together (`maCluster` block); turn the trend filter off with it, since a cluster break usually starts below the long trend line.',
  },
  breakoutLookback: {
    when: 'Only with `entryTrigger: breakout`. Lengthen it if entries keep firing on small ranges that immediately fall back; shorten it if the bot only buys after most of a move has happened.',
    expect:
      'Counted in candles of `candleInterval`, so 400 is about 17 days on `1h`. A longer range means fewer entries that each start a bigger move. The window can hold at most 998 candles of range.',
  },
  'entrySizing.mode': {
    when: 'Use `fixed` while you are learning what the strategy does — it makes every trade the same size and therefore easy to compare. Switch to `percentOfAccount` when you want position size to grow and shrink with the account.',
    expect:
      'In `fixed` mode only the amount field is read; in `percentOfAccount` mode only the percent field is. Setting the wrong one is the usual cause of "it never buys".',
  },
  'entrySizing.amount': {
    when: 'Only in `fixed` mode. Set it to what you are willing to put into one coin, and keep it above the exchange minimum order size for your pairs.',
    expect:
      'Every entry spends exactly this much quote currency. Below the exchange minimum the order is rejected and the entry silently never happens.',
  },
  'entrySizing.percent': {
    when: 'Only in `percentOfAccount` mode. Start small — 5–10% — so a bad run cannot concentrate the account into one coin.',
    expect:
      'Position size scales with equity, so gains compound and losses shrink the next bet. Set high, a few simultaneous entries can commit most of the account.',
  },
  'accountCap.mode': {
    when: 'Turn it on as soon as the profile trades more than one or two coins, so a strong signal across many coins cannot deploy the whole account at once.',
    expect:
      '`off` means no ceiling: the strategy will keep entering while signals fire. `percentOfAccount` refuses new entries once holdings reach the configured share of equity.',
  },
  'accountCap.percent': {
    when: 'Only when the cap mode is on. Pick the share of the account you are comfortable having in coins simultaneously.',
    expect:
      'New entries are blocked once holdings reach this share of equity; existing positions and their exits are unaffected. At `50` roughly half the account stays as cash.',
  },
  'ema.fast': {
    when: 'Set it with the slow period as a pair. Shorter reacts sooner and trades more.',
    expect:
      'The entry signal is the fast EMA crossing above the slow. A very short fast period produces frequent, noisy crosses; it must be shorter than the slow period or the config is rejected.',
  },
  'ema.slow': {
    when: 'Set it with the fast period as a pair. A wider gap between the two means fewer, higher-conviction crosses.',
    expect:
      'Lengthening it delays both entry and the loss of the signal, so trades become fewer and longer. It must be longer than the fast period.',
  },
  'atrTrailingStop.enabled': {
    when: 'Turn it on when one fixed percentage does not suit every coin the profile trades — a stop that is right for a stablecoin pair is far too tight for a small-cap.',
    expect:
      "The stop distance follows the coin's own recent volatility instead of a fixed percent, and it replaces the fixed trailing stop. Unlike the fixed stop it can also move down when volatility spikes, which gives a violent move room instead of shaking you out, but only while no priced protective stop is resting or when that stop clamps to the price band. Otherwise the resting stop’s trigger is a floor.",
  },
  'atrTrailingStop.period': {
    when: 'Only when the ATR stop is on. Shorten it to make the stop respond faster to a change in volatility.',
    expect:
      'A short period makes the stop jumpy as volatility changes; a long period smooths it but is slower to widen when a coin becomes volatile.',
  },
  'atrTrailingStop.multiple': {
    when: 'Only when the ATR stop is on. Raise it if normal volatility keeps stopping you out; lower it to protect gains harder.',
    expect:
      'The stop sits this many ATRs below the peak since entry. At `3` a coin whose ATR is 2% of price gets roughly a 6% pullback allowance, and that allowance moves as volatility does.',
  },
  'riskSizing.enabled': {
    when: 'Turn it on when your entry sizing buys the same amount of a jumpy coin as a calm one, so a single stop-out costs far more on some symbols than others. It matters most alongside the ATR stop, where the stop distance already differs coin to coin.',
    expect:
      'Each buy is shrunk to the size whose first stop would cost the same slice of the account. Volatile coins get noticeably smaller positions, so they also gain less when they run; it never buys more than your entry sizing allows.',
  },
  'riskSizing.riskPct': {
    when: 'Only when risk-based sizing is on. Lower it to take smaller positions across the board; raise it to trade closer to your entry sizing.',
    expect:
      'A stopped-out trade costs roughly this share of the account whatever coin it was, measured against the stop distance at the time you bought — if the coin turns more volatile afterwards the ATR stop widens and it can cost more. If you have the exchange-side protective stop turned on, it also costs somewhat more than the figure here whatever the coin does: the order resting at Binance sells down to a limit price below its own trigger, so the fill lands under the level this was sized from. Set it too low and many entries fall below Binance’s minimum order value and are skipped entirely.',
  },
  'protectiveStop.enabled': {
    when: 'Turn it on if you want protection that survives the bot being offline. The in-memory trailing stop only fires while the worker is running.',
    expect:
      'A real stop order rests on Binance and tracks the trailing level, so a crash or restart cannot leave the position unprotected. The cost is an extra resting order and the usual stop-order risks in a gapping market.',
  },
  'protectiveStop.limitOffsetPercentage': {
    when: 'Only when the protective stop is on. Lower it (further below the trigger) on thin, volatile coins where a stop can gap through a tight limit.',
    expect:
      "When the stop triggers, the limit is placed this fraction of the trigger price. At `0.98` the limit sits 2% below the trigger — wide enough to fill in most conditions. Too tight and the stop triggers but never fills, leaving you holding. There is also a hard floor on how far you can lower it: at or below the symbol's Binance `askMultiplierDown` the stop cannot be placed at all, and the symbol reports a terminal blocker until you raise it.",
  },
  'protectiveStop.onBandBlock': {
    when: 'Only when the protective stop is on. Change it if you run a trailing stop wider than about 7% and keep being told the backup stop could not be placed.',
    expect:
      'Binance refuses a resting sell priced too far below the market, and this picks what happens then. `notify` alerts you and leaves the position with no resting stop behind it. `clamp` raises the stop to the deepest level Binance will take: at the default `0.98` limit offset that is roughly 7.2% below the market on a typical coin. That level is anchored to the market rather than to your high-water mark, so it follows the price both up and down and never sits below the trail you set: a gradual pullback moves it back down instead of triggering it, so it is not a tighter trailing exit but a resting order that catches a fast drop. While the exchange floor is what is holding the stop up, `minRearmDriftPct` is widened to 1% so following the market does not rewrite the order every tick. `native-trail` hands Binance a trailing stop at your full distance instead, so nothing is tightened — the costs are that it sells at whatever the market pays rather than at a limit price, and Binance measures the distance from the highest price seen since the order was placed rather than from your entry, so there is no fixed trigger price for the app to show you.',
  },
  'protectiveStop.mode': {
    when: 'Only when the protective stop is on. Switch to `native-trail` once this symbol accepts the configured distance in its Binance `TRAILING_DELTA` filter.',
    expect:
      'In `native-trail` mode, one resting `STOP_LOSS` order stays on Binance and Binance ratchets its trigger up after every trade. A tighter distance or an under-size correction replaces it only when the successor would not lower the effective trigger. An over-size correction, or switching a held position from `priced` to `native-trail`, replaces it without that guard. Leaving this at the priced default keeps every existing profile behaving as before.',
  },
  'protectiveStop.minRearmDriftPct': {
    when: 'Only when the protective stop is on. Raise it if you are hitting Binance order limits, or if the resting stop is being rewritten constantly in a market that is grinding one way. Applies to `priced` mode and to the priced fallback of `native-trail`; a resting native trail is replaced by the delta and quantity rules under `protectiveStop.mode`, not by this band.',
    expect:
      'The stop order held at Binance is only rewritten once the level has moved this far. Higher means fewer orders sent and a resting stop that lags the in-app level by up to this much; lower means the two stay in step at the cost of order allowance. It does not change when the strategy itself sells — that check runs every tick regardless.',
  },
  'profitTrail.enabled': {
    when: 'Turn it on when trades run up nicely intraday and then hand the gain back before your normal stop reacts — the classic case is a long candle interval like `1d`, where the normal stop only moves once a day.',
    expect:
      'A second trailing stop that exists only above your entry price. It follows the price up on a minute-by-minute clock and sells on a small pullback. It can only ever sit above your normal stop, never below, so losing trades behave exactly as they do today.',
  },
  'profitTrail.activationPct': {
    when: 'Only when the profit trail is on. Raise it to give trades more room to breathe before the tighter trail takes over; lower it to start protecting sooner.',
    expect:
      'Nothing happens until the trade is this far in profit. Set too low, the fast trail takes over while the trade is still just noise and ends it early; set too high, the trade may never reach it and your normal stop does all the work.',
  },
  'profitTrail.trailPct': {
    when: 'Only when the profit trail is on. Tighten it to bank gains harder; loosen it if you are being sold out of moves that keep going.',
    expect:
      'Once switched on, the trade sells if price falls this far from its peak. It must be enough below the activation that the sale still clears your entry: the pullback is measured off the higher arming price, so it costs slightly more than the activation gained. With a 5% activation the form accepts a little under 4.8%. That bound is what stops this trail turning a winner into a loser.',
  },
  'breakEvenLock.enabled': {
    when: 'Turn it on if trades that were comfortably in profit keep falling back and closing at a loss.',
    expect:
      'After a trade has closed well above your entry price, the stop is not allowed to sit below a small gain over that price. It only ever raises the stop, so trades that never get that far in profit behave exactly as they do today.',
  },
  'breakEvenLock.activationPct': {
    when: 'Only when the break-even lock is on. Lower it to lock in sooner; raise it to give new trades more room before the lock applies.',
    expect:
      'Nothing changes until a candle has closed this far above your entry price. Set too low, ordinary noise right after the buy arms the lock and shakes you out of trades that would have run.',
  },
  'breakEvenLock.floorPct': {
    when: 'Only when the break-even lock is on. 0 is break-even, a stop exactly at your entry price. Raise it to cover trading fees or to keep a little more of the gain.',
    expect:
      'Once the lock is armed the stop will not sit below this gain over your entry price. It must be below the activation, so the lock never holds the stop above where the trade stood when it armed.',
  },
  'profitTrail.ratchetMinutes': {
    when: 'Only when the profit trail is on. Lower it if the trail is lagging fast moves; raise it if you are sending too many orders.',
    expect:
      'How often the profit trail is allowed to move up. It paces that trail only: your normal trailing stop advances on your candle interval, so with a 1-minute interval the stop order at Binance can still be rewritten every minute whenever the normal stop is the higher of the two. Each rewrite uses one cancelReplace request and spends one unit of order allowance. The sell check itself runs every tick, so a fall through the current level is caught immediately; what this delays is the level moving UP.',
  },
  'relativeStrength.enabled': {
    when: 'Only on a profile trading many coins whose entries keep landing on the weaker ones. On a profile with fewer coins than `topK` it never refuses.',
    expect:
      "A coin buys only while at most `topK - 1` of this profile's other coins score higher on return per unit of volatility over `lookbackBars` candles, so expect fewer entries, concentrated in the strongest coins. Coins that have not scored yet do not count, so a newly started profile buys freely until every coin has closed a candle. In the 1h research, the top 3 of nine large caps by 720-candle score, applied to the breakout with its below-trend layer, made money in both six-month halves from October 2025, which the ungated rule did not.",
  },
  'relativeStrength.lookbackBars': {
    when: 'Only with the gate on. Change it with the candle interval: about a month of candles, so 720 on `1h`.',
    expect:
      'Shorter follows the latest leaders and changes rank more often; longer ranks on the steadier trend. In the research with the top 3 of nine coins, 336, 720 and 1440 candles all made money in both six-month halves from October 2025; shorter earned more in the recent half, longer in the earlier one. 1440 is above the 998 cap, so it was a research-only setting.',
  },
  'relativeStrength.topK': {
    when: 'Only with the gate on. Lower it to concentrate on the very strongest coins; raise it toward the coin count to loosen the gate.',
    expect:
      'In the research on nine coins, 3 and 4 made money in both six-month halves from October 2025; 2 lost in the earlier half.',
  },
  'maCluster.maxSpread': {
    when: 'Only with `entryTrigger: maCluster`. Widen it if the bot almost never fires; narrow it if it buys breaks in choppy, unsettled markets that fade.',
  },
  'maCluster.maxChoppiness': {
    when: 'Only with `entryTrigger: maCluster`. Set it if the bot keeps buying breaks that fade within a day; lower it to skip more of them, clear it to buy every break.',
    expect:
      'In the 2025 to October 2026 1h research on the five majors, 50 skipped about a third of the breaks, cut the August to October 2026 losers from 25 to 16, and made more after 2.5x costs over 90 days, both six-month halves and the year; it made less over 18 months before costs.',
  },
  'maCluster.maxAtrPercentile': {
    when: 'Only with `entryTrigger: maCluster`. Set it if breaks taken while the market is swinging hard keep failing; raise it to buy more of them, clear it to buy every break. The bot needs 495 closed candles before it can judge a break with this on.',
    expect:
      'In the 2025 to October 2026 1h research on the five majors with a choppiness ceiling of 50, 40% kept about three quarters of the breaks, cut the 60-day loss from 6.0% to 3.7% per symbol after 2.5x costs, and made more after 2.5x costs over 90 days, April to October 2026, the year and 18 months; it made slightly less in October 2025 to April 2026 and in the 2024 bull market. Lookbacks of 240, 480 and 960 candles with ceilings from 30% to 60% were all profitable in both six-month halves. It did not help on nine pre-chosen large caps.',
  },
  'maCluster.confirmBreak': {
    when: 'Only with `entryTrigger: maCluster`. Turn it on if breaks keep falling straight back under the averages within the hour; the buy then comes one candle later, usually a little higher.',
    expect:
      'In the 2025 to October 2026 1h research on the five majors with a choppiness ceiling of 50, waiting one candle skipped about one break in eight and made more after 2.5x costs over 60 and 90 days, both six-month halves, the year, 18 months and the 2024 bull market. Waiting two or three candles made less. It did not help on nine pre-chosen large caps.',
  },
  'exhaustion.maxChoppiness': {
    when: 'Only with `entryTrigger: exhaustion`. Lower it to buy only the steepest one-way slides; raise it to also buy choppier drops.',
    expect:
      'In the 2025 to October 2026 1h research, 35 instead of 30 roughly doubled the trades on the majors and turned the last 90 days and the year negative after 2.5x costs.',
  },
  'exhaustion.minBelowAverage': {
    when: 'Only with `entryTrigger: exhaustion`. Raise it to wait for deeper drops; lower it to buy shallower ones.',
    expect:
      'In the 1h research 4% and 7% both stayed profitable after 2.5x costs over 90 days and from April 2026 on, on the majors and the large caps. Deeper means fewer trades.',
  },
  'exhaustion.maxRsi': {
    when: 'Only with `entryTrigger: exhaustion`. Lower it to buy only the most oversold drops; raise it to buy more of them.',
    expect:
      'In the 1h research 20 traded about a third less often than 25 and stayed profitable; 30 traded more and made less, with the majors last 90 days no better than random entries.',
  },
  'obvLead.lookback': {
    when: 'Only with `entryTrigger: obvLead`. Shorten it for more, weaker signals; lengthen it for fewer, stronger ones.',
    expect:
      'In the 2025 to October 2026 1h research, 120 and 240 both stayed profitable after 2.5x costs over 90 days and from April 2026 on, on the majors and the large caps.',
  },
  'obvLead.maxChoppiness': {
    when: 'Only with `entryTrigger: obvLead`. Lower it to buy only in clearly directional markets.',
    expect:
      'In the 1h research, dropping the gate deepened the October 2025 to April 2026 loss on the majors and turned the year negative after 2.5x costs; 45 traded less and made less than 50.',
  },
  'weekendGap.minGap': {
    when: 'Only with `entryTrigger: weekendGap` on `1h` candles. Raise it to buy only deeper weekend dips.',
    expect:
      'In the 2025 to October 2026 1h research on nine pre-chosen large caps, buying the gap was profitable in every window, while buying Sundays without a gap lost in every window. It lost in 2024.',
  },
  'weekendGap.maxHoldBars': {
    when: 'Only with `entryTrigger: weekendGap`. Shorten it to give up on a dip that is not recovering sooner.',
    expect:
      'In the 1h research price tended to climb back to the Friday close within about three days, so 72 candles is the whole recovery window; a position still open then is sold at market.',
  },
  'trendQuality.lookback': {
    when: 'Only with `entryTrigger: trendQuality`. Shorten it for more, shorter-lived trends; lengthen it for fewer, steadier ones.',
    expect:
      'Counted in candles of `candleInterval`, so 48 is two days on `1h`. A longer fit asks for a longer straight climb, so it fires less often and later.',
  },
  'trendQuality.minRSquared': {
    when: 'Only with `entryTrigger: trendQuality`. Raise it to buy only the cleanest climbs; lower it to also buy rougher ones.',
    expect:
      'In the 2025 to October 2026 1h research the default 0.9 with a 4x ATR trail made money after 2.5x costs on nine pre-chosen large caps. Higher values trade less often.',
  },
  'impulse.volumeLookback': {
    when: 'Only with `entryTrigger: impulse`. Change it only with the candle interval: it should span about a week of candles, so 168 on `1h` and 42 on `4h`.',
    expect:
      "This is the baseline the judged candle's volume is compared with. A shorter baseline reacts to the last few days, so a run of busy candles raises the bar and fewer surges qualify.",
  },
  'impulse.volumeMultiple': {
    when: 'Only with `entryTrigger: impulse`. Raise it if the bot buys ordinary up candles that fade; lower it if it almost never fires.',
    expect:
      'Higher means fewer, more extreme surges. In the 1h research 3 with a 2 ATR rise traded about once every two weeks per coin; 4 with 3 ATR traded a third as often and was weaker on the large caps.',
  },
  'impulse.riseAtrMultiple': {
    when: 'Only with `entryTrigger: impulse`. Raise it to buy only the sharpest rises; lower it to buy more of them.',
    expect:
      'Measured in ATRs of the candles before the surge, so it adapts to how volatile the coin normally is. 2 means the candle rose about two normal candles in one.',
  },
  'belowTrendBreakout.enabled': {
    when: 'Turn it on when the market sits under its trend line for weeks and the `above` trend filter refuses every breakout, so the profile cannot trade at all. Needs `atrTrailingStop`, and either `entryTrigger: breakout` with the trend filter on its `above` side, or `entryTrigger: maCluster`, where it reads the `trendFilter` line even with the filter off.',
    expect:
      'Above the line nothing changes. Under it, a close above the shorter `belowTrendBreakout.lookback` range buys, and that position trails at `belowTrendBreakout.atrMultiple` instead of the main multiple. Expect more, smaller trades in a downtrend and more stop-outs; each uses the same entry size as a main breakout.',
  },
  'belowTrendBreakout.lookback': {
    when: 'Only with the layer on. Shorten it to catch rallies sooner; lengthen it if the layer keeps buying small bounces that fail at once.',
    expect:
      'Counted in candles of `candleInterval`, so 120 is 5 days on `1h`. Keep it well under `breakoutLookback`: rallies inside a downtrend rarely last long enough to clear the main range.',
  },
  'belowTrendBreakout.maxChoppiness': {
    when: 'Only with the layer on. Set it if layer entries keep fading within a day of the break; clear it to buy every below-trend break.',
    expect:
      "A break is bought only while the 14-candle Choppiness Index is below it. In the 2025 to October 2026 1h research, 50 raised the below-trend breakout's year after 2.5x costs on the five majors and on nine pre-chosen large caps, and beside the MA cluster rule it added about 1% a year per symbol over no ceiling.",
  },
  'belowTrendBreakout.atrMultiple': {
    when: 'Only with the layer on. Keep it tighter than `atrTrailingStop.multiple`, because a rally under the trend line usually fails quickly.',
    expect:
      'Applies only to positions this layer opened. The opening rule is recorded at entry, so a layer position keeps this multiple when `atrTrailingStop.multiple` changes, and editing this field moves the stop of open layer positions too. A wider multiple holds rallies longer and gives back more when they fail.',
  },
  'trendFilter.enabled': {
    when: 'Turn it on when backtests show the strategy losing money mainly on entries taken during sustained downtrends.',
    expect:
      'Entries are refused while price is below the long-term trend line. Exits are untouched, so you can still get out. Fewer trades overall, and you will sit out the early part of a recovery.',
  },
  'trendFilter.side': {
    when: 'Only when the trend filter is on. Set `below` on a separate, small profile that should trade rallies while the market is in a downtrend, the regime where an `above` filter never lets a breakout through.',
    expect:
      '`below` flips the gate: entries are refused while price is at or above the line. With a short `breakoutLookback` this buys a fresh multi-day high that is still under the long-term line. Rallies inside a downtrend are short, so expect small wins, a tight ATR stop, and nothing at all once the market is back above its trend.',
  },
  'trendFilter.maType': {
    when: 'Only when the trend filter is on. `ema` weights recent prices more heavily, so it turns sooner than `sma`.',
    expect:
      '`ema` re-admits entries earlier after a downtrend ends, at the cost of more false re-entries. `sma` is slower and steadier.',
  },
  'trendFilter.period': {
    when: 'Only when the trend filter is on. Shorten it if the filter is blocking entries long after the market has clearly turned.',
    expect:
      'Measured in candles of your candle interval, so `200` is about 8 days on `1h` and 200 days on `1d`. A long period blocks a large share of entries; a short one barely filters anything.',
  },
  'trendFilter.requireRising': {
    when: 'Turn it on when you keep entering on rallies that pop above a trend line which is still heading down.',
    expect:
      'Both conditions must hold: price above the line, and the line itself higher than it was. Noticeably fewer entries, and later ones. Off keeps the simpler price-above-line test.',
  },
  'trendFilter.slopeLookbackBars': {
    when: 'Only when "require rising" is on. Shorten it to accept a trend line that has only just turned up; lengthen it to demand a sustained turn.',
    expect:
      'The line must be higher now than this many candles ago. A long lookback rejects entries for a long time after a downtrend, so a recovery is largely missed.',
  },
  'entryExtension.enabled': {
    when: 'Turn it on if you find the strategy buying at the top of vertical moves that immediately mean-revert.',
    expect:
      'Entries are skipped while price is stretched too far above its baseline, so you buy pullbacks rather than blow-offs. In a strong sustained trend this can keep you out for a long time.',
  },
  'entryExtension.maType': {
    when: 'Only when entry extension is on. `ema` tracks price more closely, so "stretched" is measured against a faster-moving baseline.',
    expect:
      '`ema` follows a rising market up, so it blocks fewer entries in a steady trend. `sma` is a stiffer baseline and blocks more.',
  },
  'entryExtension.period': {
    when: 'Only when entry extension is on. Shorten it to compare against a more recent baseline.',
    expect:
      'Measured in candles of your candle interval. A short period makes the baseline chase price, so almost nothing looks stretched; a long one makes the check bite more often.',
  },
  'entryExtension.maxPercent': {
    when: 'Only when entry extension is on. Lower it to be stricter about chasing; raise it if it is blocking entries you wanted.',
    expect:
      'Entries are skipped while price sits more than this far above the baseline. Set it too low on a volatile coin and virtually every entry is blocked.',
  },
};
