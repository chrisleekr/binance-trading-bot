// Fixture stand-in for the worker metric catalogue: the one module allowed to
// declare the sink, and the reason the gate exists — the union is what keeps a
// metric name from being invented at a call site.

export type MetricName = 'tick_latency_ms' | 'decision_count';

export interface MetricsSink {
  record(name: MetricName, value: number, tags?: Readonly<Record<string, string>>): void;
  forget(name: MetricName, tags: Readonly<Record<string, string>>): void;
}
