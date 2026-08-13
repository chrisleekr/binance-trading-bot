// Same widening as the method form, written as a property. A gate that only
// reads method signatures leaves this spelling as a way through.

export interface LooseSink {
  record: (name: string, value: number) => void;
}
