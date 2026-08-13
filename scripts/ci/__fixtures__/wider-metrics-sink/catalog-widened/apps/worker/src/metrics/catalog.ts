// The catalogue's own sink, widened to `string`. Every other module is measured
// against this one, so a widening here silently legalises every call site at
// once — the gate has to catch it in the file it exempts from the file scan.

export type MetricName = 'tick_latency_ms' | 'decision_count';

export interface MetricsSink {
  record(name: string, value: number, tags?: Readonly<Record<string, string>>): void;
  forget(name: string, tags: Readonly<Record<string, string>>): void;
}
