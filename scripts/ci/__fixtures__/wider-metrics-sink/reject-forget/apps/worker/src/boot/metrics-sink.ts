// The second sink method, widened. `record` here is narrow, so a gate that
// matches only `record` reports this file clean while a name in no catalogue
// reaches `forget` — which retires nothing, leaves the child exporting its last
// value, and turns the stale-gauge fix into a no-op nobody notices.

// The name literal is written out rather than imported, like its siblings: these
// trees are walked by a regex and never resolved by a compiler, so a fixture that
// leans on resolution is one that breaks if that ever changes.
export interface LooseSink {
  record(name: 'tick_latency_ms', value: number): void;
  forget(name: string, tags: Readonly<Record<string, string>>): void;
}
