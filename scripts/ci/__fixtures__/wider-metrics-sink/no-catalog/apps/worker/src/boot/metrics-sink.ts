// Candidate file with no catalogue beside it, so the scan has something to walk
// and the run reaches the catalogue lookup. The offence is deliberate: it must
// be reported as a missing catalogue, never scanned past as a clean tree.

export interface LooseSink {
  record(name: string, value: number): void;
}
