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
      "The stop distance follows the coin's own recent volatility instead of a fixed percent, and it replaces the fixed trailing stop. Unlike the fixed stop it can also move down when volatility spikes, which gives a violent move room instead of shaking you out.",
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
  'protectiveStop.enabled': {
    when: 'Turn it on if you want protection that survives the bot being offline. The in-memory trailing stop only fires while the worker is running.',
    expect:
      'A real stop order rests on Binance and tracks the trailing level, so a crash or restart cannot leave the position unprotected. The cost is an extra resting order and the usual stop-order risks in a gapping market.',
  },
  'protectiveStop.limitOffsetPercentage': {
    when: 'Only when the protective stop is on. Lower it (further below the trigger) on thin, volatile coins where a stop can gap through a tight limit.',
    expect:
      'When the stop triggers, the limit is placed this fraction of the trigger price. At `0.98` the limit sits 2% below the trigger — wide enough to fill in most conditions. Too tight and the stop triggers but never fills, leaving you holding.',
  },
  'protectiveStop.minRearmDriftPct': {
    when: 'Only when the protective stop is on. Raise it if you are hitting Binance order limits, or if the resting stop is being rewritten constantly in a market that is grinding one way.',
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
  'profitTrail.ratchetMinutes': {
    when: 'Only when the profit trail is on. Lower it if the trail is lagging fast moves; raise it if you are sending too many orders.',
    expect:
      'How often the profit trail is allowed to move up. It paces that trail only: your normal trailing stop advances on your candle interval, so with a 1-minute interval the stop order at Binance can still be rewritten every minute whenever the normal stop is the higher of the two. Each rewrite is a cancel plus a place and spends one unit of order allowance. The sell check itself runs every tick, so a fall through the current level is caught immediately; what this delays is the level moving UP.',
  },
  'trendFilter.enabled': {
    when: 'Turn it on when backtests show the strategy losing money mainly on entries taken during sustained downtrends.',
    expect:
      'Entries are refused while price is below the long-term trend line. Exits are untouched, so you can still get out. Fewer trades overall, and you will sit out the early part of a recovery.',
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
