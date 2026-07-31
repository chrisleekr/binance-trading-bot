// Single source of truth for the kline intervals the worker feeds a trading
// symbol. This same set drives BOTH the subscription set (subscriptions-manager
// opens one WS kline stream per interval) AND the per-tick candle-load set
// (tick-handler reads one window per interval). Sharing one helper guarantees
// the streams a symbol subscribes always match the candle windows a tick reads;
// previously these were two independent lists that had to be kept in sync, and
// drift meant a tick cold-loaded an unsubscribed interval over REST every tick.
//
// The set is the profile's trading interval plus '1m' (bounds currentPrice
// staleness to ≤1min so stop-losses fire within the minute, not a full
// trading-candle late) and '1d' (daily regime / ATH refresh), deduped.

const MINUTE_INTERVAL = '1m';
const DAILY_INTERVAL = '1d';

export const feedIntervals = (candleInterval: string): readonly string[] => [
  ...new Set([candleInterval, MINUTE_INTERVAL, DAILY_INTERVAL]),
];
