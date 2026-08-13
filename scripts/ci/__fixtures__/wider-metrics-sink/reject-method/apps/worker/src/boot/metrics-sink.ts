// A second sink declaration, typed on `string`. It compiles, it satisfies every
// consumer of the real sink, and it accepts a metric name that is in no
// catalogue — which is how an alert rule ends up watching a series nothing emits.

export interface LooseSink {
  record(name: string, value: number): void;
}
