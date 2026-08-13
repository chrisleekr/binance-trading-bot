// Closed-catalogue prom-client adapter for the MetricsSink seam.
// Asserts each catalogued name maps to the right metric type, lazy
// registration, label defaulting, and the unknown-name bounded drop.

import { describe, expect, it } from 'vitest';

import { createMetricsRegistry } from '@app/observability';

import { createWorkerMetricsSink } from '../../src/boot/metrics-sink.js';

const setUp = (): {
  registry: ReturnType<typeof createMetricsRegistry>;
  sink: ReturnType<typeof createWorkerMetricsSink>;
} => {
  // `version` is pinned so the exposition does not depend on npm_package_version:
  // left to default it becomes "unknown", which any assertion about a missing
  // label value would then trip over depending on how the file was invoked.
  const registry = createMetricsRegistry({ service: 'worker-test', version: 'test' });
  return { registry, sink: createWorkerMetricsSink(registry) };
};

describe('createWorkerMetricsSink', () => {
  it('records a counter with its declared labels', async () => {
    const { registry, sink } = setUp();
    sink.record('state_commit_persist_error', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('state_commit_persist_error', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(
      /state_commit_persist_error\{[^}]*profileId="p1"[^}]*symbol="BTCUSDT"[^}]*\}\s+2/,
    );
  });

  it('records the kill-switch and timeout counters', async () => {
    const { registry, sink } = setUp();
    sink.record('tick_throttled_kill_switch', 1, { profileId: 'p1', symbol: 'ETHUSDT' });
    sink.record('state_commit_persist_timeout', 1, { profileId: 'p1', symbol: 'ETHUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/tick_throttled_kill_switch\{[^}]*symbol="ETHUSDT"[^}]*\}\s+1/);
    expect(body).toMatch(/state_commit_persist_timeout\{[^}]*symbol="ETHUSDT"[^}]*\}\s+1/);
  });

  it('accumulates decision_count by the recorded value', async () => {
    const { registry, sink } = setUp();
    sink.record('decision_count', 3, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('decision_count', 2, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/decision_count\{[^}]*symbol="BTCUSDT"[^}]*\}\s+5/);
  });

  it('records tick_latency_ms as a histogram (buckets + count + sum)', async () => {
    const { registry, sink } = setUp();
    sink.record('tick_latency_ms', 42, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE tick_latency_ms histogram/);
    expect(body).toMatch(/tick_latency_ms_count\{[^}]*symbol="BTCUSDT"[^}]*\}\s+1/);
    expect(body).toMatch(/tick_latency_ms_sum\{[^}]*symbol="BTCUSDT"[^}]*\}\s+42/);
    // 42ms lands in the le="50" bucket but not le="25".
    expect(body).toMatch(/tick_latency_ms_bucket\{[^}]*le="50"[^}]*\}\s+1/);
    expect(body).toMatch(/tick_latency_ms_bucket\{[^}]*le="25"[^}]*\}\s+0/);
  });

  it('records binance_api_weight as a gauge that takes the latest value', async () => {
    const { registry, sink } = setUp();
    sink.record('binance_api_weight', 120, { profileId: 'p1' });
    sink.record('binance_api_weight', 240, { profileId: 'p1' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE binance_api_weight gauge/);
    // Gauge takes the latest set value, not an accumulation.
    expect(body).toMatch(/binance_api_weight\{[^}]*profileId="p1"[^}]*\}\s+240/);
  });

  it('drops an unlisted metric name without throwing or registering a series', async () => {
    const { registry, sink } = setUp();
    expect(() => sink.record('totally_unknown_metric', 1, { profileId: 'p1' })).not.toThrow();
    const body = await registry.metrics();
    expect(body).not.toContain('totally_unknown_metric');
  });

  it('exports a series for every silent tick skip', async () => {
    // These two skips write nothing else: no order, no state commit, no audit row, and
    // for the claim gate no action_log either. An unlisted name is DROPPED by `record`,
    // so a missing catalogue entry would not merely lose a measurement, it would make
    // the skip invisible. Asserted through the exposition, which is the only place the
    // catalogue's contents are observable.
    const { registry, sink } = setUp();
    sink.record('tick_throttled_override_claim', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('tick_throttled_redis_unavailable', 1, { profileId: 'p1' });
    const body = await registry.metrics();
    expect(body).toMatch(/tick_throttled_override_claim\{[^}]*profileId="p1"[^}]*\}\s+1/);
    expect(body).toMatch(/tick_throttled_redis_unavailable\{[^}]*profileId="p1"[^}]*\}\s+1/);
  });

  it('registers lazily — an un-recorded metric is absent from the exposition', async () => {
    const { registry, sink } = setUp();
    sink.record('decision_count', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    // decision_count fired, so it is present …
    expect(body).toContain('decision_count');
    // … but tick_latency_ms was never recorded, so it has no series yet.
    expect(body).not.toContain('tick_latency_ms');
  });

  it('defaults a missing declared label to "unknown" rather than throwing', async () => {
    const { registry, sink } = setUp();
    // symbol omitted — the counter still records under symbol="unknown".
    expect(() => sink.record('decision_count', 1, { profileId: 'p1' })).not.toThrow();
    const body = await registry.metrics();
    expect(body).toMatch(/decision_count\{[^}]*symbol="unknown"[^}]*\}\s+1/);
  });

  // The state-commit and audit-drainer emitters below all reach `record()` on the
  // wired sink. An uncatalogued name is dropped silently, so the series reads zero
  // forever — indistinguishable from a healthy path that never degraded. Asserted
  // through the exposition, the only place the catalogue's contents are observable.

  // Each asserts `# TYPE … counter` and accumulation across two records. A gauge
  // renders `set(1)` as the identical single line, so without both of these a
  // wrong kind in the CATALOG would pass — and rate()/increase() over a gauge
  // pinned at 1 answers nothing, which is the only question these metrics exist
  // for.
  it('records the CAS-miss commit counter as an accumulating counter', async () => {
    const { registry, sink } = setUp();
    sink.record('state_commit_cas_miss', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('state_commit_cas_miss', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE state_commit_cas_miss counter/);
    expect(body).toMatch(/state_commit_cas_miss\{[^}]*profileId="p1"[^}]*\}\s+2/);
    expect(body).toMatch(/state_commit_cas_miss\{[^}]*symbol="BTCUSDT"[^}]*\}\s+2/);
  });

  it('records the latch-merged commit counter as an accumulating counter', async () => {
    const { registry, sink } = setUp();
    sink.record('state_commit_latch_merged', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('state_commit_latch_merged', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE state_commit_latch_merged counter/);
    expect(body).toMatch(/state_commit_latch_merged\{[^}]*profileId="p1"[^}]*\}\s+2/);
    expect(body).toMatch(/state_commit_latch_merged\{[^}]*symbol="BTCUSDT"[^}]*\}\s+2/);
  });

  it('records the latch-merge-exhausted counter as an accumulating counter', async () => {
    const { registry, sink } = setUp();
    sink.record('state_commit_latch_merge_exhausted', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('state_commit_latch_merge_exhausted', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE state_commit_latch_merge_exhausted counter/);
    expect(body).toMatch(/state_commit_latch_merge_exhausted\{[^}]*profileId="p1"[^}]*\}\s+2/);
    expect(body).toMatch(/state_commit_latch_merge_exhausted\{[^}]*symbol="BTCUSDT"[^}]*\}\s+2/);
  });

  it('records the latch-merge-error counter as an accumulating counter', async () => {
    const { registry, sink } = setUp();
    sink.record('state_commit_latch_merge_error', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    sink.record('state_commit_latch_merge_error', 1, { profileId: 'p1', symbol: 'BTCUSDT' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE state_commit_latch_merge_error counter/);
    expect(body).toMatch(/state_commit_latch_merge_error\{[^}]*profileId="p1"[^}]*\}\s+2/);
    expect(body).toMatch(/state_commit_latch_merge_error\{[^}]*symbol="BTCUSDT"[^}]*\}\s+2/);
  });

  it('records audit_batch_size as an unlabelled, count-bucketed histogram', async () => {
    const { registry, sink } = setUp();
    // Emitted with no tags at all: the drainer batches across every stream, so
    // there is no bounded label to slice by.
    sink.record('audit_batch_size', 3);
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE audit_batch_size histogram/);
    expect(body).toMatch(/audit_batch_size_count\{[^}]*\}\s+1/);
    expect(body).toMatch(/audit_batch_size_sum\{[^}]*\}\s+3/);
    // Declaring labels this call site never supplies would fill them with the
    // "unknown" placeholder, inventing a dimension the metric does not have.
    // Named explicitly rather than matched on the placeholder value, which the
    // registry also uses for an unset default label.
    expect(body).not.toMatch(/audit_batch_size[^\n]*(?:profileId|symbol|stream)=/);
    // le="2" exists only in count-shaped buckets; reusing LATENCY_MS_BUCKETS
    // (1, 5, 10, 25, …) would drop it and fail here.
    expect(body).toMatch(/audit_batch_size_bucket\{[^}]*le="2"[^}]*\}\s+0/);
    expect(body).toMatch(/audit_batch_size_bucket\{[^}]*le="5"[^}]*\}\s+1/);
  });

  it('records audit_stream_length as a per-stream gauge taking the latest value', async () => {
    const { registry, sink } = setUp();
    sink.record('audit_stream_length', 900, { stream: 'audit:acct1' });
    sink.record('audit_stream_length', 120, { stream: 'audit:acct1' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE audit_stream_length gauge/);
    // Stream depth is a level, not a total: a counter would report 1020 here.
    expect(body).toMatch(/audit_stream_length\{[^}]*stream="audit:acct1"[^}]*\}\s+120/);
  });

  it('records audit_consumer_lag as a per-stream gauge taking the latest value', async () => {
    const { registry, sink } = setUp();
    sink.record('audit_consumer_lag', 500, { stream: 'audit:acct1' });
    sink.record('audit_consumer_lag', 7, { stream: 'audit:acct1' });
    const body = await registry.metrics();
    expect(body).toMatch(/# TYPE audit_consumer_lag gauge/);
    // Backlog is a level: a counter would hide the drain by reporting 507.
    expect(body).toMatch(/audit_consumer_lag\{[^}]*stream="audit:acct1"[^}]*\}\s+7/);
  });

  it('records audit_consumer_pending as a per-stream gauge taking the latest value', async () => {
    const { registry, sink } = setUp();
    sink.record('audit_consumer_pending', 40, { stream: 'audit:acct1' });
    sink.record('audit_consumer_pending', 12_345, { stream: 'audit:acct1' });
    const body = await registry.metrics();
    // Gauge because each record is an absolute reading of the pending-entries
    // list, not an increment: a counter would add the readings and report 12385.
    // Note it returns to zero only over several passes: the reclaim path waits
    // out a min-idle window and claims one batch per stream per pass, which is
    // why the alert reads its growth rather than thresholding its value.
    expect(body).toMatch(/# TYPE audit_consumer_pending gauge/);
    expect(body).toMatch(/audit_consumer_pending\{[^}]*stream="audit:acct1"[^}]*\}\s+12345/);
  });

  it('forgets a per-profile child so the series leaves the scrape', async () => {
    // A gauge child outlives the profile that owned it: prom-client keeps
    // exporting the last value forever, so a disabled profile still reports a
    // live-looking weight and any alert reading it can never resolve.
    const { registry, sink } = setUp();
    sink.record('binance_api_weight', 240, { profileId: 'p1' });
    sink.record('binance_api_weight', 10, { profileId: 'p2' });
    sink.forget('binance_api_weight', { profileId: 'p1' });
    const body = await registry.metrics();
    expect(body).not.toMatch(/binance_api_weight\{[^}]*profileId="p1"/);
    // Only the named child goes: forgetting one profile must not blind the rest.
    expect(body).toMatch(/binance_api_weight\{[^}]*profileId="p2"[^}]*\}\s+10/);
  });

  it('no-ops on forgetting a metric that was never recorded, without registering it', async () => {
    // `forget` runs on teardown paths that cannot know what a profile ever
    // emitted. Registering the metric to remove a child from it would turn the
    // cleanup into the thing that creates the series.
    const { registry, sink } = setUp();
    expect(() =>
      sink.forget('tick_latency_ms', { profileId: 'p1', symbol: 'BTCUSDT' }),
    ).not.toThrow();
    const body = await registry.metrics();
    expect(body).not.toContain('tick_latency_ms');
  });

  it('records audit_consumer_lag_unknown as an accumulating per-stream, per-cause counter', async () => {
    const { registry, sink } = setUp();
    sink.record('audit_consumer_lag_unknown', 1, {
      stream: 'audit:acct1',
      cause: 'probe-failed',
    });
    sink.record('audit_consumer_lag_unknown', 1, {
      stream: 'audit:acct1',
      cause: 'probe-failed',
    });
    const body = await registry.metrics();
    // Counter, not gauge: the alert reads increase() over a window, which needs
    // a monotonic series. A gauge would sit at 1 and make repeated failures
    // indistinguishable from a single one.
    expect(body).toMatch(/# TYPE audit_consumer_lag_unknown counter/);
    expect(body).toMatch(/audit_consumer_lag_unknown\{[^}]*stream="audit:acct1"[^}]*\}\s+2/);
    // `cause` separates a transport error from reported data loss. Undeclared it
    // would be dropped from the series, collapsing the two into one number.
    expect(body).toMatch(/audit_consumer_lag_unknown\{[^}]*cause="probe-failed"[^}]*\}\s+2/);
  });
});
