// A second sink whose widening hides inside a union. The names still autocomplete
// and a reviewer skimming the line sees the closed union first, but `| string`
// accepts anything — so this is the same uncatalogued-metric hole as a bare
// `string`, wearing the spelling most likely to survive review.
//
// The literal is written out rather than imported so the fixture stands alone:
// these trees are walked by a regex, never resolved by a compiler.

export interface LooseSink {
  record(name: 'tick_latency_ms' | string, value: number): void;
}
