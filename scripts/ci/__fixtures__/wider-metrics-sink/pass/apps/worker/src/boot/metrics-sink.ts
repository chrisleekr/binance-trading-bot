// Legitimate shapes the gate must NOT reject, all in one file so a false
// positive here is caught by the accept case rather than by a broken build:
// the adapter implements the catalogue's sink (parameters carry no annotation
// at all), and the dedup ledger declares its own `record` whose first parameter
// is a client order id, which is a string and always will be.

import type { MetricsSink } from '../metrics/catalog.js';

export const createWorkerMetricsSink = (): MetricsSink => ({
  record(name, value, tags) {
    void name;
    void value;
    void tags;
  },
  forget(name, tags) {
    void name;
    void tags;
  },
});

export interface PlacementDedup {
  record: (clientOrderId: string, at: number) => void;
}
