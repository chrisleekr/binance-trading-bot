// The same widening as `catalog-widened`, written as a union instead. This is
// the spelling an author reaches for when they want the closed union kept for
// autocomplete and one escape hatch beside it, and it accepts every string all
// the same. Reading the annotation one word at a time sees `MetricName` here and
// agrees the sink is narrow, so which side of the `|` got written would decide
// whether CI catches it.

export type MetricName = 'tick_latency_ms' | 'decision_count';

export interface MetricsSink {
  record(name: MetricName | string, value: number, tags?: Readonly<Record<string, string>>): void;
  forget(name: MetricName, tags: Readonly<Record<string, string>>): void;
}
