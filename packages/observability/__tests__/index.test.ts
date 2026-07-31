import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '../src/index.js';

// The package's contract is small: every helper must produce a series
// in the exposition body that downstream Prometheus tools accept.
// Tests here cover the surface — service-name default label, the
// drop-counter trio, and the scrape-duration histogram — so subsystem
// follow-ups can extend with confidence.

describe('createMetricsRegistry', () => {
  it('decorates every series with the service default label', async () => {
    const m = createMetricsRegistry({ service: 'api', version: '1.2.3' });
    m.incPinoDrop();
    const exposition = await m.metrics();
    expect(exposition).toContain('service="api"');
    expect(exposition).toContain('version="1.2.3"');
    expect(exposition).toContain('pino_dropped_logs_total{');
  });

  it('exposes otel_dropped_spans_total per reason label, bounding unknown reasons to "other"', async () => {
    const m = createMetricsRegistry({ service: 'worker' });
    m.incOtelDrop('queue_overflow');
    m.incOtelDrop('export_timeout');
    m.incOtelDrop('queue_overflow');
    // Unknown reasons fall through to the bounded `other` bucket so the
    // Prometheus cardinality stays capped.
    m.incOtelDrop('unknown_reason_xyz');
    const exposition = await m.metrics();
    expect(exposition).toMatch(/otel_dropped_spans_total\{[^}]*reason="queue_overflow"[^}]*\}\s+2/);
    expect(exposition).toMatch(/otel_dropped_spans_total\{[^}]*reason="export_timeout"[^}]*\}\s+1/);
    expect(exposition).toMatch(/otel_dropped_spans_total\{[^}]*reason="other"[^}]*\}\s+1/);
  });

  it('observes metrics_scrape_duration_seconds and the buckets render', async () => {
    const m = createMetricsRegistry({ service: 'api' });
    m.observeScrapeDuration(0.012);
    m.observeScrapeDuration(0.07);
    const exposition = await m.metrics();
    // _bucket lines render once per histogram bucket; we just assert
    // the histogram is present and non-empty.
    expect(exposition).toContain('metrics_scrape_duration_seconds_bucket');
    expect(exposition).toMatch(/metrics_scrape_duration_seconds_count\{[^}]*\}\s+2/);
  });

  it('emits the standard nodejs process metrics from collectDefaultMetrics', async () => {
    const m = createMetricsRegistry({ service: 'api' });
    const exposition = await m.metrics();
    // Two stable members of the default-metrics set across prom-client
    // versions.
    expect(exposition).toContain('process_cpu_user_seconds_total');
    expect(exposition).toContain('nodejs_eventloop_lag_seconds');
  });

  it('serves a content-type compatible with the Prometheus exposition format', () => {
    const m = createMetricsRegistry({ service: 'api' });
    expect(m.contentType).toContain('text/plain');
    expect(m.contentType).toContain('version=0.0.4');
  });
});
