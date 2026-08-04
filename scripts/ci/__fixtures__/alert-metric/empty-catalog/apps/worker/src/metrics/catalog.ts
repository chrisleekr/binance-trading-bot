// A catalogue the parser cannot read names out of: the union is spelled with a
// type alias per member instead of string literals, so the literal harvest finds
// nothing. Whatever the cause, an empty allowed set would make EVERY alert rule
// look like a phantom, or, if the resolution order changed, make every rule
// resolve against nothing at all. The gate refuses to run on it.

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly help: string;
  readonly labelNames: readonly string[];
}

type TickLatency = string;
type DecisionCount = string;

export type MetricName = TickLatency | DecisionCount;

export const CATALOG: Readonly<Record<string, MetricSpec>> = {};
