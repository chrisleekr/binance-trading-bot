// The widened declaration that must NOT slip through while the gate has no
// method list to check it against. Its presence is what makes the missing-sink
// case a real fail-open rather than a hypothetical one.

export interface LooseSink {
  record(name: string, value: number): void;
}
