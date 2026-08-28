// Per-service Prometheus metrics registry + drop-counter trio.
//
// `startOtel` (the OTel SDK init) is deliberately NOT re-exported here. It
// pulls the auto-instrumentation packages, which hook `require` at load time
// and `bun build` cannot inline, so a barrel re-export drags them into every
// consumer's bundle and breaks the slim runtime image (the bundle references
// node_modules the image does not ship). It is reachable from the
// `@app/observability/otel` subpath for the boot site that will start tracing;
// no app wires it today. The prom-client `incOtelDrop` counter below is the
// bundleable half the exporter feeds.

/**
 * Re-exported from `./propagation.js` so apps import tracing-propagation
 * helpers from this single observability entrypoint instead of coupling to
 * an internal module path. Keeping the re-export here means renaming the
 * internal file is a non-breaking change.
 */
export {
  TRACEPARENT_KEY,
  type TraceparentCarrier,
  injectTraceparent,
  extractTraceparent,
  carrierHasTraceparent,
  traceIdFromCarrier,
  withExtractedContext,
  tracer,
} from './propagation.js';
/**
 * Closed enum for `otel_dropped_spans_total{reason}`. Bounding the label
 * set caps Prometheus cardinality; unknown inputs are mapped to `other`
 * inside `incOtelDrop` so a future reason added at a call site never
 * breaks the time series.
 */
export type OtelDropReason = 'queue_overflow' | 'export_timeout' | 'export_error' | 'other';
//
// Each apps/* binary calls `createMetricsRegistry({ service: '<name>' })`
// once at boot, owning the returned `Registry` for the process lifetime.
// `metrics()` returns the wire-format exposition the admin /metrics
// route serves; `dropped*Total` are the three drop counters the
// observability plan calls out so that observability itself never
// blocks the hot path (logger drop, OTel queue overflow, slow scrape).
//
// Domain counters (tick_*, binance_api_*, technicals_*, bullmq_*,
// ws_*) and the per-subsystem histograms (http, pg, redis) ride the
// subsystem they instrument and are added in per-subsystem follow-up
// MRs.

import promClient, { Counter, type Registry as PromRegistry, Histogram } from 'prom-client';

// Re-exported so each app can register its own subsystem metrics (the
// http / pg / redis histograms noted above, the worker's tick_* / state_*
// series) on the registry returned by `createMetricsRegistry` without taking
// a direct prom-client dependency — keeping the prom-client version
// single-sourced in this package.
export { Counter, Gauge, Histogram } from 'prom-client';
export type { Registry } from 'prom-client';

/**
 * Public handle returned by `createMetricsRegistry`. Apps hold one of
 * these for the process lifetime; the admin /metrics route calls
 * `metrics()` to serve the exposition body. Helpers like `incOtelDrop`
 * are exposed so the OTel exporter and the logger transport
 * can bump the counters without re-importing prom-client.
 */
export interface MetricsRegistry {
  /** The underlying prom-client registry. Subsystem code that needs to register its own metrics imports this. */
  readonly registry: PromRegistry;
  /** Returns the Prometheus exposition body. Used by /metrics handlers. */
  metrics(): Promise<string>;
  /** Content-type the admin /metrics route should serve. */
  readonly contentType: string;
  /** Bumps `otel_dropped_spans_total{reason}`. Called from the OTel exporter on queue overflow / export error. */
  incOtelDrop(reason: OtelDropReason | string): void;
  /** Bumps `pino_dropped_logs_total`. Called from the logger transport when the async destination's drop policy fires. */
  incPinoDrop(): void;
  /** Records `metrics_scrape_duration_seconds` for one /metrics call so a slow scrape stands out in its own series. */
  observeScrapeDuration(seconds: number): void;
}

/**
 * Inputs for `createMetricsRegistry`. `service` lands as a default
 * label on every metric so multi-service Prometheus scrapes can
 * disambiguate without per-call tagging.
 */
export interface CreateMetricsRegistryOptions {
  /** Logical service name (e.g. `api`, `worker`). Becomes the default `service` label on every series. */
  readonly service: string;
  /** Optional version string surfaced on the `service.version` resource attr. Default: `process.env.npm_package_version`. */
  readonly version?: string;
}

/**
 * Builds and registers the per-service metrics surface. Idempotent
 * across modules: prom-client's default registry is process-global, so
 * each service should call this exactly once at boot and pass the
 * returned handle through DI to the admin server and any subsystem
 * that needs to record metrics.
 */
export const createMetricsRegistry = (opts: CreateMetricsRegistryOptions): MetricsRegistry => {
  const registry = new promClient.Registry();
  registry.setDefaultLabels({
    service: opts.service,
    version: opts.version ?? process.env['npm_package_version'] ?? 'unknown',
  });

  // Standard process / nodejs metrics (process_cpu_*, process_memory_*,
  // nodejs_eventloop_lag, process_uptime_seconds, etc.). Bun implements
  // the prom-client compat shims; the same library works for both.
  promClient.collectDefaultMetrics({ register: registry, prefix: '' });

  const otelDropped = new Counter({
    name: 'otel_dropped_spans_total',
    help: 'OTel spans dropped before export. Bumped by the SDK exporter on queue overflow / export timeout.',
    labelNames: ['reason'],
    registers: [registry],
  });

  const pinoDropped = new Counter({
    name: 'pino_dropped_logs_total',
    help: 'Log lines dropped by pino async destination when the in-process buffer is saturated.',
    registers: [registry],
  });

  const scrapeDuration = new Histogram({
    name: 'metrics_scrape_duration_seconds',
    help: 'Latency of /metrics endpoint scrapes. A slow scrape masks Prometheus alerting; this series surfaces it.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return {
    registry,
    metrics: () => registry.metrics(),
    contentType: registry.contentType,
    incOtelDrop: (reason) => {
      const bounded: OtelDropReason =
        reason === 'queue_overflow' ||
        reason === 'export_timeout' ||
        reason === 'export_error' ||
        reason === 'other'
          ? reason
          : 'other';
      otelDropped.labels(bounded).inc();
    },
    incPinoDrop: () => {
      pinoDropped.inc();
    },
    observeScrapeDuration: (seconds) => {
      scrapeDuration.observe(seconds);
    },
  };
};
