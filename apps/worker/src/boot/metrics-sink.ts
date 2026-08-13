// Worker-side prom-client adapter for the `MetricsSink` seam.
//
// The tick handler, the symbol-state commit path and the audit drainer call
// `metrics?.record(name, value, tags?)`. This adapter translates each call into
// a lazily-registered prom-client metric on the registry the admin server
// already serves; the worker builds one at boot and injects it, so those series
// reach /metrics. The sink stays optional in the type, and an absent one makes
// every call a silent no-op — that is a deployment-shaped failure, not a
// tuning knob.
//
// The name space itself is enforced one level up, in `metrics/catalog.ts`:
// `record()` takes a `MetricName`, so an uncatalogued name cannot be written.
// The runtime miss below is unreachable from typed code and exists only for a
// caller that has already left the type system.

import { Counter, Gauge, Histogram, type MetricsRegistry } from '@app/observability';

import {
  CATALOG,
  LATENCY_MS_BUCKETS,
  type MetricName,
  type MetricSpec,
  type MetricsSink,
} from 'metrics/catalog.js';

type LabeledCounter = Counter<string>;
type LabeledGauge = Gauge<string>;
type LabeledHistogram = Histogram<string>;

type CatalogMetric = { readonly labelNames: readonly string[] } & (
  | { readonly kind: 'counter'; readonly metric: LabeledCounter }
  | { readonly kind: 'gauge'; readonly metric: LabeledGauge }
  | { readonly kind: 'histogram'; readonly metric: LabeledHistogram }
);

/**
 * Builds a {@link MetricsSink} backed by `registry`'s prom-client registry.
 * Metrics are registered lazily on first emission, so /metrics only carries
 * series that have actually fired. Pass the returned sink into
 * `createTickHandler({ metrics })` and `createStatePort({ metrics })`.
 */
export const createWorkerMetricsSink = (registry: MetricsRegistry): MetricsSink => {
  const promRegistry = registry.registry;
  const cache = new Map<string, CatalogMetric>();

  const build = (name: string, spec: MetricSpec): CatalogMetric => {
    const labelNames = spec.labelNames;
    const base = { name, help: spec.help, labelNames: [...labelNames], registers: [promRegistry] };
    switch (spec.kind) {
      case 'counter':
        return { kind: 'counter', metric: new Counter(base), labelNames };
      case 'gauge':
        return { kind: 'gauge', metric: new Gauge(base), labelNames };
      case 'histogram':
        return {
          kind: 'histogram',
          metric: new Histogram({ ...base, buckets: [...(spec.buckets ?? LATENCY_MS_BUCKETS)] }),
          labelNames,
        };
    }
  };

  const ensure = (name: MetricName): CatalogMetric | undefined => {
    const cached = cache.get(name);
    if (cached) return cached;
    const spec: MetricSpec | undefined = CATALOG[name];
    if (!spec) return undefined;
    const made = build(name, spec);
    cache.set(name, made);
    return made;
  };

  return {
    // `value` must be finite: prom-client's observe() rejects NaN/Infinity,
    // and inc(undefined) silently means inc(1). Every catalogued call site
    // passes a real number (latency, weight, count, or a literal 1).
    record(name, value, tags) {
      const entry = ensure(name);
      // Unreachable for a typed caller — `MetricName` has no member the catalogue
      // lacks. Kept because the drop is what makes an untyped or hand-rolled
      // caller degrade rather than throw inside the tick path.
      if (!entry) return;
      // Declared labels in order; a missing tag reads 'unknown' so the child
      // series stays valid and bounded rather than throwing on a partial set.
      const labels = entry.labelNames.map((key) => tags?.[key] ?? 'unknown');
      switch (entry.kind) {
        case 'counter':
          entry.metric.labels(...labels).inc(value);
          return;
        case 'gauge':
          entry.metric.labels(...labels).set(value);
          return;
        case 'histogram':
          entry.metric.labels(...labels).observe(value);
          return;
      }
    },
    // Reads the cache directly instead of going through `ensure()`. A teardown
    // path cannot know what the subject it is retiring ever emitted, so
    // registering the metric in order to remove a child from it would make the
    // cleanup the thing that creates the series — and leave an empty one behind.
    forget(name, tags) {
      const entry = cache.get(name);
      if (!entry) return;
      // Same positional order and 'unknown' default as `record`, or a child
      // recorded with a partial tag set could never be addressed to remove it.
      entry.metric.remove(...entry.labelNames.map((key) => tags?.[key] ?? 'unknown'));
    },
  };
};
