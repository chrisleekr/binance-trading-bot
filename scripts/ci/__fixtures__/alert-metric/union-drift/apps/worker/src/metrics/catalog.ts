// The MetricName union lists a name CATALOG does not define. TypeScript rejects
// this shape outright (`Record<MetricName, MetricSpec>` fails on a missing key),
// so it can only mean the gate's two parsers have drifted apart: one of them is
// reading something the other is not. The gate reports the symmetric difference
// rather than quietly trusting whichever set it happened to build.

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly help: string;
  readonly labelNames: readonly string[];
}

export type MetricName =
  | 'tick_latency_ms'
  | 'decision_count'
  | 'binance_api_weight'
  | 'declared_in_union_only';

export const CATALOG: Readonly<Record<MetricName, MetricSpec>> = {
  tick_latency_ms: {
    kind: 'histogram',
    help: 'Tick handler wall-clock latency in milliseconds.',
    labelNames: ['profileId', 'symbol'],
  },
  decision_count: {
    kind: 'counter',
    help: 'Strategy decisions emitted, accumulated across ticks.',
    labelNames: ['profileId', 'symbol'],
  },
  binance_api_weight: {
    kind: 'gauge',
    help: 'Binance used request weight in the last 1m window.',
    labelNames: ['profileId'],
  },
};

export interface MetricsSink {
  record(name: MetricName, value: number, tags?: Readonly<Record<string, string>>): void;
}
