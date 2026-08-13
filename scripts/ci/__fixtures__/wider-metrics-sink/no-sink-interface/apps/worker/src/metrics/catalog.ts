// A catalogue whose sink declaration has been renamed or moved away. The gate
// reads the method names it guards out of that declaration, so with nothing to
// read it guards nothing — and the widened file beside it would pass.

export type MetricName = 'tick_latency_ms' | 'decision_count';

export interface Recorder {
  record(name: MetricName, value: number): void;
}
