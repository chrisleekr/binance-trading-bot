// Worker-internal market-data event shapes.
//
// The event-router consumes a discriminated `ParsedMarketEvent` produced by
// the `MarketSubscriptionsManager`. The shape originally lived alongside the
// retired `MarketDataSubscriber`; with that file deleted, it moves here so
// the consumers (event-router, subscriptions-manager) import a stable home
// instead of resurrecting the dead module.

export type ParsedMarketEvent =
  | {
      readonly kind: 'mini-ticker';
      readonly symbol: string;
      readonly closePrice: string;
      readonly eventTimeMs: number;
    }
  | {
      readonly kind: 'kline';
      readonly symbol: string;
      readonly interval: string;
      readonly openTimeMs: number;
      readonly closeTimeMs: number;
      readonly open: string;
      readonly high: string;
      readonly low: string;
      readonly close: string;
      readonly volume: string;
      readonly isClosed: boolean;
    };
