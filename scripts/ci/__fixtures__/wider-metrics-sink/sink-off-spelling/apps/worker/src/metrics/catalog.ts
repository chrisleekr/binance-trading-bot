// A sink that grew a second method taking its metric name under another
// spelling. The gate matches candidates on the parameter being named `name`, so
// `observe` would be dropped from the guarded list in silence and every module
// could declare `observe(metric: string, …)` freely. The gate cannot tell a
// renamed metric name from a parameter that is not one, so it stops here.

export type MetricName = 'tick_latency_ms' | 'decision_count';

export interface MetricsSink {
  record(name: MetricName, value: number): void;
  observe(metric: MetricName, value: number): void;
}
