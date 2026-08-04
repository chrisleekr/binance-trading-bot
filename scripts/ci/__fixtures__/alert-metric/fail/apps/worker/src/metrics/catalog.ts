// Fixture stand-in for the worker metric catalogue. It mirrors the SHAPE the gate
// parses, not just the names: a multi-line union with a leading `|` per member,
// entry keys at 2 spaces and spec fields at 4, comments between entries, a
// `buckets` field, and a declaration after CATALOG's closing brace so the
// parser's terminator is exercised rather than end-of-file.

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly buckets?: readonly number[];
}

export const LATENCY_MS_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500] as const;

export type MetricName =
  | 'tick_latency_ms'
  | 'decision_count'
  | 'binance_api_weight';

export const CATALOG: Readonly<Record<MetricName, MetricSpec>> = {
  tick_latency_ms: {
    kind: 'histogram',
    help: 'Tick handler wall-clock latency in milliseconds.',
    labelNames: ['profileId', 'symbol'],
    buckets: LATENCY_MS_BUCKETS,
  },
  // A counter whose own name ends in `_count`. Prometheus derives `_sum` from a
  // histogram and never from a counter, so `decision_count_sum` has to stay
  // reportable: this entry is what makes that half of the rule executable.
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
