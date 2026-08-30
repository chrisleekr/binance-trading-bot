// W3C TraceContext propagation helpers for arbitrary key/value carriers.
//
// `BullMQInstrumentation` (wired into `startOtel`) auto-injects/extracts
// `traceparent` for every BullMQ `add()` and `process()` call, so producers and
// consumers that go through BullMQ get propagation for free. These helpers exist
// for the few code paths that enqueue *outside* BullMQ — anywhere a span needs
// to ride a JSON payload across an async boundary the auto-instrumentation
// cannot reach.
//
// When `startOtel` runs in the unset-env branch the global propagator is the
// SDK default (W3C TraceContext) but `trace.getActiveSpan()` returns the
// no-op span, so `injectTraceparent` writes nothing and `extractTraceparent`
// returns the no-op context. That keeps the helpers safe to call regardless of
// whether the OTel SDK is actually live.

import {
  context as otelContext,
  propagation,
  trace,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';

/**
 * The `traceparent` header field as carried inside a BullMQ job-data object.
 * Pinned here so a consumer cannot drift the key independently of the producer.
 */
export const TRACEPARENT_KEY = 'traceparent';

/**
 * Subset of a BullMQ job-data shape we need to manipulate. Values are
 * `unknown` because real job payloads carry mixed types (numbers, nested
 * objects); narrowing to `string` at the read site lets callers pass their
 * actual job-data without unsafe casts, while the traceparent slot stays
 * string-typed.
 */
export type TraceparentCarrier = Record<string, unknown>;

const setter: TextMapSetter<TraceparentCarrier> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<TraceparentCarrier> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    const value = carrier[key];
    return typeof value === 'string' ? value : undefined;
  },
};

/**
 * Writes the active span's `traceparent` (and optional `tracestate`) into
 * the supplied carrier. When no span is active the call is a no-op — the
 * carrier is returned unchanged.
 */
export const injectTraceparent = (
  carrier: TraceparentCarrier,
  ctx: Context = otelContext.active(),
): TraceparentCarrier => {
  propagation.inject(ctx, carrier, setter);
  return carrier;
};

/**
 * Returns a `Context` derived from the carrier's `traceparent` (and any
 * `tracestate`). Pass the result to `context.with(extracted, fn)` so spans
 * created inside `fn` become children of the upstream span.
 */
export const extractTraceparent = (
  carrier: TraceparentCarrier,
  ctx: Context = otelContext.active(),
): Context => propagation.extract(ctx, carrier, getter);

/**
 * Returns true when the carrier carries a non-empty `traceparent` string.
 * Cheap presence check (no parsing of the W3C field), suitable for asserting
 * that a producer wrote the header. Use {@link traceIdFromCarrier} when the
 * caller actually needs the trace id.
 */
export const carrierHasTraceparent = (carrier: TraceparentCarrier): boolean => {
  const tp = carrier[TRACEPARENT_KEY];
  return typeof tp === 'string' && tp.length > 0;
};

/**
 * Convenience: extracts and returns the trace ID from a carrier, or `null`
 * when the carrier has no `traceparent` (or the value is malformed). The
 * trace ID is the first 32 hex chars after the version byte.
 */
export const traceIdFromCarrier = (carrier: TraceparentCarrier): string | null => {
  const tp = carrier[TRACEPARENT_KEY];
  if (typeof tp !== 'string' || tp.length === 0) return null;
  // W3C TraceContext: `<version>-<trace-id>-<span-id>-<trace-flags>`.
  const parts = tp.split('-');
  if (parts.length !== 4) return null;
  const traceId = parts[1];
  if (!traceId || traceId.length !== 32) return null;
  return traceId;
};

/**
 * Re-exports the OTel API surface this module depends on so callers do not
 * need a second `@opentelemetry/api` import. Wrapping `context.with` keeps
 * the call site terse: `withExtracted(jobData, () => process(job))`.
 */
export const withExtractedContext = <T>(carrier: TraceparentCarrier, fn: () => T): T =>
  otelContext.with(extractTraceparent(carrier), fn);

/**
 * Re-export for downstream call sites that need to start a child span after
 * extracting context — the alternative is forcing them to depend on the
 * @opentelemetry/api package directly.
 */
export const tracer = (name: string): ReturnType<typeof trace.getTracer> => trace.getTracer(name);
