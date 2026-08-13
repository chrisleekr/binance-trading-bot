// The declaration the off-spelling hole would let through. `observe` never
// reaches the derived method list, so nothing ever checks its parameter and this
// file would read as clean. It is here so the loud stop has something to be
// worth stopping for: without a candidate, the case proves only that the gate
// can refuse an empty tree.

export interface LooseSink {
  observe(metric: string, value: number): void;
}
