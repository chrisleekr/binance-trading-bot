// Trace-context propagation tests. Drive the propagator with a real
// SDK-backed tracer + InMemorySpanExporter so the assertions exercise the
// same code path BullMQInstrumentation will exercise at runtime — no
// stubs of OTel internals.

import { context, propagation, trace, type Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRACEPARENT_KEY,
  carrierHasTraceparent,
  extractTraceparent,
  injectTraceparent,
  traceIdFromCarrier,
  withExtractedContext,
} from '../src/propagation.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    sampler: new AlwaysOnSampler(),
  });
  trace.setGlobalTracerProvider(provider);
  // AsyncLocalStorage-backed context manager so `context.with(...)` actually
  // makes the supplied context the value `context.active()` returns inside the
  // closure. Without it, the OTel API falls back to ROOT_CONTEXT and the
  // propagator sees no active span.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  // BullMQInstrumentation registers the same propagator at runtime; we set
  // it explicitly here so the tests run identically with or without the SDK.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(async () => {
  await provider.shutdown();
});

describe('injectTraceparent', () => {
  it('writes nothing when no span is active', () => {
    const carrier: Record<string, string> = {};
    injectTraceparent(carrier);
    expect(carrierHasTraceparent(carrier)).toBe(false);
    expect(carrier).toEqual({});
  });

  it('writes a W3C-shaped traceparent when a span is active', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('producer');
    const carrier: Record<string, string> = {};
    context.with(trace.setSpan(context.active(), span), () => {
      injectTraceparent(carrier);
    });
    span.end();
    expect(carrierHasTraceparent(carrier)).toBe(true);
    // version-trace-span-flags
    expect(carrier[TRACEPARENT_KEY]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });
});

describe('extractTraceparent + withExtractedContext', () => {
  it('round-trip preserves trace id end-to-end', () => {
    const tracer = trace.getTracer('test');
    const producer = tracer.startSpan('producer');
    const producerCtx = trace.setSpan(context.active(), producer);
    const producerTraceId = producer.spanContext().traceId;

    const carrier: Record<string, string> = {};
    context.with(producerCtx, () => injectTraceparent(carrier));
    producer.end();

    const extractedCtx = extractTraceparent(carrier);
    const consumerSpan: Span = tracer.startSpan('consumer', undefined, extractedCtx);
    const consumerTraceId = consumerSpan.spanContext().traceId;
    const consumerParentSpanId = trace.getSpan(extractedCtx)?.spanContext().spanId;
    consumerSpan.end();
    void withExtractedContext; // smoke: helper exists for callers that prefer the with-block style

    expect(consumerTraceId).toBe(producerTraceId);
    expect(consumerParentSpanId).toBe(producer.spanContext().spanId);
    expect(traceIdFromCarrier(carrier)).toBe(producerTraceId);
  });

  it('returns the parent context unchanged when the carrier has no traceparent', () => {
    const ctxBefore = context.active();
    const ctxAfter = extractTraceparent({});
    // No span has been activated on either context — both should yield the no-op span.
    expect(trace.getSpan(ctxAfter)?.spanContext().traceId).toBe(
      trace.getSpan(ctxBefore)?.spanContext().traceId,
    );
  });
});

describe('traceIdFromCarrier', () => {
  it('returns null for a missing or malformed traceparent', () => {
    expect(traceIdFromCarrier({})).toBeNull();
    expect(traceIdFromCarrier({ [TRACEPARENT_KEY]: 'nope' })).toBeNull();
    expect(traceIdFromCarrier({ [TRACEPARENT_KEY]: '00-short-001-01' })).toBeNull();
  });

  it('returns the 32-char trace id segment for a valid traceparent', () => {
    const valid = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    expect(traceIdFromCarrier({ [TRACEPARENT_KEY]: valid })).toBe(
      '0123456789abcdef0123456789abcdef',
    );
  });
});

describe('no-op behaviour when OTel is disabled', () => {
  it('inject is a no-op against the global no-op span (no active span scope)', () => {
    // Top-level — no producer span has been started. Inject must not throw and must not write.
    const carrier: Record<string, string> = {};
    injectTraceparent(carrier);
    expect(carrierHasTraceparent(carrier)).toBe(false);
  });
});
