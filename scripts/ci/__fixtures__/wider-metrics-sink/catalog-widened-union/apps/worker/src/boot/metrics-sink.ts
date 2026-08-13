// Benign consumer, present only so the file scan has a candidate to walk and
// the widened-catalogue case cannot pass through the zero-candidate floor.

import type { MetricsSink } from '../metrics/catalog.js';

export const useSink = (sink: MetricsSink): void => sink.record('tick_latency_ms', 1);
