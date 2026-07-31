// Turn a strategy's structured entry-blocker (reason code + sparse detail) into
// one plain-language "why isn't the bot buying this coin?" sentence for a
// non-finance operator (invariant #3). Shared so the symbol page and the
// discovery dashboard gloss the same code identically. Stays off decimal.js —
// detail numbers arrive as strings and are shown verbatim.

/** Loose blocker shape: any strategy's reason code + optional sparse detail. */
interface EntryBlocker {
  readonly reason: string;
  readonly detail?: Record<string, unknown> | undefined;
}

/** Read a detail value as a display string, or null when absent. */
function str(detail: EntryBlocker['detail'], key: string): string | null {
  const v = detail?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * Glossed "not buying because ..." sentence per reason code. Spells out the
 * trading term the first time it appears rather than naming the internal gate,
 * and folds in the detail numbers where they help an operator understand. Every
 * known reason maps to a non-empty sentence; an unrecognised code falls back to
 * a generic line so a future strategy reason never renders blank.
 */
export function glossEntryBlocker(blocker: EntryBlocker): string {
  const d = blocker.detail;
  switch (blocker.reason) {
    case 'awaiting-trigger-price': {
      const price = str(d, 'currentPrice');
      const low = str(d, 'windowLow');
      return low && price
        ? `Waiting for the price to dip to your buy trigger. The recent low was ${low} and the price is ${price} — no buy until it pulls back to the trigger.`
        : 'Waiting for the price to dip to your buy trigger before the first buy.';
    }
    case 'regime-downtrend':
      return 'The daily trend filter is holding back the next averaging-down buy: price is below its moving average (a down phase), so the ladder stops deepening into the dip.';
    case 'regime-unavailable':
      return "Not enough daily history yet to read the trend, so buys are paused until there's enough data to judge it safely.";
    case 'regime-exit-bear':
      return 'The daily trend filter is confirmed down, so the bot is staying in cash and not opening new positions until price recovers above its moving average.';
    case 'regime-not-uptrend': {
      // The require-uptrend gate folds "too little history" into the same block
      // as flat/falling; the `need` detail (present only on the unavailable case)
      // lets us tell the operator which it is.
      const need = str(d, 'need');
      const have = str(d, 'have');
      return need && have
        ? `You set this profile to open only in a confirmed uptrend, and there is not enough daily history yet to read the trend (${have} of ${need} days). The bot waits before the first buy until it can judge the trend.`
        : 'You set this profile to open only in a confirmed uptrend. The daily trend is flat or falling, not a confirmed uptrend, so the bot is waiting before the first buy.';
    }
    case 'technicals-no-signal':
      return 'No technical rating has arrived yet for this coin, so the bot is waiting for a signal before its first buy.';
    case 'technicals-stale':
      return 'The latest technical rating is too old to trust, so the buy is paused until a fresh one comes in.';
    case 'technicals-sell':
      return 'The technical rating is a Sell, so the bot is not opening a position against it.';
    case 'technicals-disallowed': {
      // NOT a sell: the rating is bullish but the operator left that buy level
      // unchecked on this timeframe, so the gate blocks it anyway.
      const rec = str(d, 'recommendation');
      const interval = str(d, 'interval');
      const pretty = rec === 'STRONG_BUY' ? 'Strong Buy' : rec === 'BUY' ? 'Buy' : rec;
      return pretty && interval
        ? `The ${interval} technical rating is a ${pretty}, but you have not enabled buying on a ${pretty} for the ${interval} timeframe, so the bot is holding off. Tick that level in this profile's Technicals settings to allow it.`
        : "The technical rating is a buy the bot isn't allowed to act on, because that buy level is unchecked for this timeframe in your Technicals settings.";
    }
    case 'indicator-rsi':
      return 'The momentum gauge (RSI) is outside your buy range, so the buy is held until it comes back in.';
    case 'indicator-sma':
    case 'indicator-ema':
      return 'Price is on the wrong side of your moving-average filter, so the buy is held until the bias lines up.';
    case 'indicator-mean-reversion':
      return 'Price is not far enough below its recent average for your mean-reversion (buy-the-dip) filter, so the buy is held until it dips to the level you set.';
    case 'indicator-unavailable':
      return 'The indicator values are not computed yet (cold start or a short candle window), so the buy waits until they are.';
    case 'exposure-cap':
      return 'This buy would push this coin past your per-coin exposure cap, so it was skipped.';
    case 'account-exposure-cap':
      return 'This buy would push your whole account past its total exposure cap, so it was skipped.';
    case 'loss-budget':
      return 'This buy would exceed the worst-case loss budget you set for the position, so it was skipped.';
    case 'force-sell-cooldown':
      return 'The bot recently force-sold this coin and is in a cooldown, so it will not buy back in yet.';
    case 'loss-cooldown': {
      const minutesLeft = str(d, 'minutesLeft');
      return minutesLeft
        ? `The bot took a loss on this coin and is waiting before buying back in, so it does not jump straight back into the drop. About ${minutesLeft} minute(s) left.`
        : 'The bot took a loss on this coin and is waiting before buying back in, so it does not jump straight back into the drop.';
    }
    case 'technicals-confirming': {
      const reads = str(d, 'reads');
      const required = str(d, 'required');
      return reads && required
        ? `The technical rating just turned to a buy and the bot is waiting for it to hold (${reads} of ${required} readings) before its first buy, so one brief flicker does not open a position.`
        : 'The technical rating just turned to a buy and the bot is waiting for it to hold for a few readings before its first buy, so one brief flicker does not open a position.';
    }
    case 'discovery-no-stop':
      return 'This auto-discovered coin was set to enter on add but has no valid stop-loss, so the entry was refused (a momentum entry with no safety net is unsafe).';
    case 'chase-guard': {
      const high = str(d, 'high24h');
      const price = str(d, 'currentPrice');
      const dist = str(d, 'distancePct');
      return high && price && dist
        ? `Not buying yet: the price (${price}) is within ${dist}% of the 24h high (${high}), so the bot is holding off rather than chasing a coin that already ran up.`
        : 'Not buying yet: the price is too close to its 24h high, so the bot is holding off rather than chasing a coin that already ran up.';
    }
    case 'knife-guard': {
      const drop = str(d, 'dropPct');
      const candles = str(d, 'candles');
      return drop && candles
        ? `Not buying yet: the price has fallen about ${drop}% over the last ${candles} candles and is still dropping, so the bot waits for the slide to stop before catching the falling knife.`
        : 'Not buying yet: the price is still falling sharply, so the bot waits for the slide to stop before catching the falling knife.';
    }
    case 'min-qty':
    case 'min-notional':
    case 'min-purchase':
      return "Your buy amount is below the exchange's minimum order size for this coin, so no order can be placed. Raise the purchase amount.";
    case 'invalid-filters':
      return "The exchange's trading rules for this coin could not be read, so the buy was skipped.";
    default:
      return 'The bot is not buying this coin right now.';
  }
}
