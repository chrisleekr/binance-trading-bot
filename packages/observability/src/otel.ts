// OpenTelemetry SDK init for the bun services. Exposes a single
// `startOtel()` so the apps own the boot ordering: the call must happen
// BEFORE any code that imports `pg`, `ioredis`, `http`, or `bullmq` so
// the auto-instrumentations see those modules at load time.

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';

/** `deployment.environment` resource attr key — pinned here so a semantic-conventions bump can't drift the resource shape. */
const DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

/**
 * Inputs to `startOtel`. The SDK needs the static service identity at
 * boot (resource attrs are immutable for the process lifetime) and the
 * `onDrop` seam so the OTel SDK can push to `MetricsRegistry` without
 * the observability package having to re-import its own registry.
 */
export interface StartOtelOptions {
  /** Logical service name for `service.name` resource attr. */
  readonly service: string;
  /** Version surfaced as `service.version`. Defaults to `process.env.npm_package_version` then `'0.0.0'`. */
  readonly version?: string;
  /** Override `deployment.environment`. Defaults to `DEPLOY_ENV` then `NODE_ENV` then `'development'`. */
  readonly environment?: string;
  /** Override the prod sampler ratio (`ParentBased(TraceIdRatio(.))`). Defaults to `0.10`. */
  readonly samplingRatio?: number;
  /** Drop counter sink. Apps wire this to `metricsRegistry.incOtelDrop`. */
  readonly onDrop?: (reason: string) => void;
  /** Inject env for tests. Production callers should leave it unset. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Handle returned by `startOtel`. `shutdown()` is idempotent and
 * safe to call from a SIGTERM handler — the no-op handle returns
 * immediately, the active handle drains the BSP queue.
 */
export interface OtelHandle {
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: OtelHandle = { shutdown: async () => undefined };

/**
 * Wraps the OTLP exporter to bump the drop counter on
 * `export_error` (FAILED) and `export_timeout` (a watchdog timer
 * that fires when the underlying request hangs past
 * `OTEL_EXPORTER_OTLP_TIMEOUT`). The counter is the operator's
 * only signal that observability is silently shedding load.
 */
export class CountingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly onDrop: (reason: string) => void,
    private readonly timeoutMs: number,
  ) {}

  /** Forwards to the inner exporter and instruments the result with the watchdog + FAILED branch so a slow or failing collector becomes visible as a drop counter increment. */
  export(spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.onDrop('export_timeout');
      cb({ code: ExportResultCode.FAILED });
    }, this.timeoutMs);
    this.inner.export(spans, (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (result.code === ExportResultCode.FAILED) this.onDrop('export_error');
      cb(result);
    });
  }

  /** Forwards shutdown to the inner exporter; the watchdog timer is cleared on each completed export so nothing dangles. */
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  /** Forwards forceFlush when the inner exporter exposes one; falls back to a resolved Promise so the SDK's flush path stays uniform. */
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Subclass of `BatchSpanProcessor` that bumps the drop counter
 * when a span lands in a full buffer. The base class drops
 * silently; this wrapper makes the loss observable.
 */
export class CountingBatchSpanProcessor extends BatchSpanProcessor {
  constructor(
    exporter: SpanExporter,
    opts: ConstructorParameters<typeof BatchSpanProcessor>[1],
    private readonly onDrop: (reason: string) => void,
  ) {
    super(exporter, opts);
  }

  /** Inspects the BSP buffer length before delegating; flags `queue_full` when the next push will be silently dropped. */
  override onEnd(span: ReadableSpan): void {
    const buf = (this as unknown as { _finishedSpans?: unknown[] })._finishedSpans;
    const max = (this as unknown as { _maxQueueSize?: number })._maxQueueSize;
    if (Array.isArray(buf) && typeof max === 'number' && buf.length >= max) {
      this.onDrop('queue_full');
    }
    super.onEnd(span);
  }
}

const buildSampler = (isProd: boolean, ratio: number): Sampler =>
  new ParentBasedSampler({
    root: isProd ? new TraceIdRatioBasedSampler(ratio) : new AlwaysOnSampler(),
  });

/**
 * Constructs and starts the SDK if `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set. Otherwise returns the no-op handle so unset-env deployments
 * pay zero cost. Auto-instrumentations need to patch the relevant
 * modules at load time, so callers MUST call `startOtel` before
 * importing anything that wraps `pg`, `ioredis`, `http`, or BullMQ
 * — typically by putting it in a tiny boot file imported first.
 */
export const startOtel = (opts: StartOtelOptions): OtelHandle => {
  const env = opts.env ?? process.env;
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint || endpoint.length === 0) return NOOP_HANDLE;

  const onDrop = opts.onDrop ?? ((): void => undefined);
  const timeoutMs = Number(env['OTEL_EXPORTER_OTLP_TIMEOUT'] ?? 3000);
  const isProd = (opts.environment ?? env['DEPLOY_ENV'] ?? env['NODE_ENV']) === 'production';
  const samplingRatio = opts.samplingRatio ?? 0.1;

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    timeoutMillis: timeoutMs,
  });
  const wrappedExporter = new CountingExporter(exporter, onDrop, timeoutMs);
  const bsp: SpanProcessor = new CountingBatchSpanProcessor(
    wrappedExporter,
    {
      maxQueueSize: 4096,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 5000,
    },
    onDrop,
  );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.version ?? env['npm_package_version'] ?? '0.0.0',
      [DEPLOYMENT_ENVIRONMENT]:
        opts.environment ?? env['DEPLOY_ENV'] ?? env['NODE_ENV'] ?? 'development',
    }),
    spanProcessors: [bsp],
    sampler: buildSampler(isProd, samplingRatio),
    instrumentations: [
      ...getNodeAutoInstrumentations({
        // ioredis / pg / http / fetch / bullmq are the four the worker
        // hot-path actually exercises; the rest of the auto-set is left
        // at its defaults so a future Express-route addition (api admin
        // server) gets traced for free.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
      new BullMQInstrumentation(),
    ],
  });

  sdk.start();

  let shut = false;
  return {
    shutdown: async () => {
      if (shut) return;
      shut = true;
      await sdk.shutdown();
    },
  };
};
