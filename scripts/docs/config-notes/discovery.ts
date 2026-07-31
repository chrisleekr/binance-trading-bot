// Operator guidance for the auto-discovery config table, keyed by the field
// path the generator emits. Keys must match the schema's leaves exactly.
import type { FieldNotes } from '@app/contracts';

export const discoveryNotes: FieldNotes = {
  refreshPeriodMs: {
    when: 'Leave at 15 minutes unless you have a reason. Lengthen it if you want a calmer universe that changes less often.',
    expect:
      'Each scan is a batch of Binance requests, so a very short period burns request weight for little benefit — the filters below work on 24h figures that barely move minute to minute.',
  },
  blacklist: {
    when: 'Add a coin the moment you decide you never want it auto-traded — a token you distrust, one you hold elsewhere, or one that has burned you.',
    expect:
      'Blacklisted symbols are never auto-added, whatever they score. It does not remove a coin you added by hand; unpin or remove that separately.',
  },
  min24hPairVolumeUsd: {
    when: 'Raise it if auto-added coins are filling at prices noticeably worse than you expected.',
    expect:
      'This is liquidity on the exact market you would trade — the coin against your quote asset. A popular coin can still have a quiet market against your quote. Raising it shrinks the candidate pool but improves fill quality; too high and discovery finds nothing.',
  },
  min24hAssetVolumeUsd: {
    when: 'Raise it to keep discovery in genuinely liquid, well-known coins. Lower it only if you deliberately want smaller caps.',
    expect:
      'This is the "no dead microcaps" floor, measured on the coin\'s main dollar market rather than yours. It is the single most effective filter against illiquid junk.',
  },
  maxSpreadRatio: {
    when: 'Tighten it if entries and exits are costing more than the strategy expects. Loosen it if the pool is coming back empty.',
    expect:
      'You pay roughly half the spread on entry and half on exit, so `0.003` costs about 0.3% per round trip before fees. On a strategy targeting a few percent, that is a real bite.',
  },
  changeMinPercent: {
    when: 'Raise it above 0 when you only want coins already showing a real move, not merely ones drifting up.',
    expect:
      'A higher hurdle means far fewer candidates, all of them already up on the day — which also means you are buying later into the move. This is the one filter here whose meaning does not shift when you change quote asset.',
  },
  rankTopPercent: {
    when: 'Lower it to be more selective. Raise it if too few coins survive the other filters.',
    expect:
      "Only coins in the top slice of your quote asset's universe by 24h gain are considered. Because it is a rank and not a fixed percentage, it keeps behaving sensibly when you switch quote asset.",
  },
  rankExcludeTopPercent: {
    when: 'Raise it if auto-added coins are consistently entering right at a local top.',
    expect:
      'The hottest gainers are skipped, on the theory that they have already run. It must be smaller than the top-percent setting or the window is empty. `0` skips nothing.',
  },
  minAgeDays: {
    when: 'Raise it to avoid freshly listed coins, whose early price action is thin and erratic. Lower it only if you want new listings.',
    expect:
      'A coin needs this many days of candle history to qualify, which is also what the indicator filters need to compute anything meaningful. Capped at 40 days.',
  },
  maxAutoSymbols: {
    when: 'Set it from how much capital you have. Each auto-held coin needs enough budget to place an order above the exchange minimum.',
    expect:
      'Discovery stops adding once this many coins are auto-held. Set too high on a small account and each position is too small to trade; set to 1 and the profile is effectively single-coin.',
  },
  minHoldMinutes: {
    when: 'Raise it if coins are being added and dropped repeatedly, churning fees.',
    expect:
      'Serves double duty: a newly added coin is held at least this long before it can be dropped, and a dropped coin cannot be re-added for the same period. Raising it makes the universe stickier and cuts churn, at the cost of holding a fading coin longer.',
  },
  marketBreadthMinPercent: {
    when: 'Set it above 0 when you want discovery to stop adding coins during broad market selloffs.',
    expect:
      'Before any new coin is added, at least this share of the whole quote-asset universe must be up over 24h. Coins you already hold are never touched by this. Set it high and discovery goes quiet for long stretches; `0` disables the guard.',
  },
  enterOnAdd: {
    when: 'Leave off until a net-of-cost backtest justifies it. Turn it on only if you find discovery adds sitting unbought while the move runs away.',
    expect:
      "Off, a newly added coin still has to pass the strategy's normal buy gate, so it may never be bought. On, the first entry skips short-interval confirmation and buys on the move discovery already confirmed — faster entries, materially higher risk, with only a Strong-Sell reading left as a downside guard.",
  },
  'entryGuard.maxDistanceFrom24hHighPercent': {
    when: 'Set it above 0 if discovery entries keep landing at the top of a spike.',
    expect:
      'An entry is skipped while price is within this percent of the 24h high. It trades chasing risk for missed entries: on a coin trending cleanly upward, price sits near its 24h high most of the time, so this can block almost everything.',
  },
  'entryGuard.knifeCandles': {
    when: 'Set it above 0 to stop discovery buying into an active collapse. Pair it with the drop-percent setting — both must be non-zero for the guard to bite.',
    expect:
      'Entry is skipped while the last N closed candles are still falling. A small number (2–3) catches genuine collapses without blocking normal pullbacks.',
  },
  'entryGuard.knifeDropPercent': {
    when: 'Set it alongside knife candles. Raise it so only a serious drop blocks the entry, not any small consecutive decline.',
    expect:
      'The fall across the knife window must total at least this much for the entry to be blocked. Set very low and every minor dip blocks entry; `0` disables the guard whatever the candle count.',
  },
  'trendConfirm.adxPeriod': {
    when: 'Leave at 14 unless a backtest says otherwise — it is the standard lookback and the reference value below is calibrated to it.',
    expect:
      'Shortening it makes the trend reading jumpier, so coins qualify and disqualify more often. Lengthening it makes confirmation slower and rarer.',
  },
  'trendConfirm.adxMin': {
    when: 'Raise it to demand a stronger, more established trend. Lower it if too few coins ever confirm.',
    expect:
      'ADX measures trend strength regardless of direction. 25 is the conventional "trending" threshold; above 40 very few coins qualify at any one time.',
  },
  'trendConfirm.emaPeriod': {
    when: 'Shorten it to accept coins that have only recently turned up; lengthen it to require a more established uptrend.',
    expect:
      'Price must sit above this moving average. A long period rejects coins early in a recovery; a short one barely filters at all.',
  },
  'trendConfirm.volSmaPeriod': {
    when: 'Leave at the default unless the volume check is behaving oddly on your chosen interval.',
    expect:
      'Sets the baseline that "unusual volume" is measured against. A short baseline is easily beaten by a single busy candle; a long one is a steadier reference.',
  },
  'trendConfirm.volMultiple': {
    when: 'Raise it to require real participation behind a move. Lower it if the volume test is rejecting everything.',
    expect:
      "The latest candle's volume must exceed this multiple of the baseline. At `1.5` a coin needs 50% more volume than typical. Above about 3 only genuine volume spikes qualify.",
  },
  'correlation.maxPairwise': {
    when: 'Set it above 0 once discovery is holding several coins, so you are not unknowingly holding the same bet many times.',
    expect:
      'A new candidate is skipped if it moves too much like something already held. `0.8` blocks near-clones; lower is stricter and produces a genuinely diversified set but far fewer adds. `0` turns the check off, and in a market where most coins move together that means the auto-set is effectively one position.',
  },
  'correlation.lookbackCandles': {
    when: 'Only when the correlation cap is on. Lengthen it for a more stable estimate.',
    expect:
      'Correlation measured over very few candles is noisy and will let through pairs that are in fact closely linked. A longer window is steadier but slower to notice a relationship changing.',
  },
};
