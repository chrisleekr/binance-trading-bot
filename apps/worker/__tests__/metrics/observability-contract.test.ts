// The alert file and the metric catalogue are one contract read from two ends.
// A rule over a series nothing emits parses clean under `promtool` and then
// evaluates empty forever: it never fires and never errors, which reads exactly
// like a healthy rule that has not tripped. `no-phantom-alert-metric.sh` catches
// that in CI; this pins the other half — that the rules an operator is promised
// are actually in the file, and that the file stops advertising coverage gaps it
// no longer has.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ASSET_POLICY_ABORT_CAUSES } from '@app/contracts';
import { CATALOG, type MetricName } from '../../src/metrics/catalog.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ALERTS = join(REPO_ROOT, 'deploy', 'observability', 'alerts.yml');
const METRICS_PARTIAL = join(REPO_ROOT, 'docs', '_generated', 'config', 'metrics.md');

const alerts = (): string => readFileSync(ALERTS, 'utf8');

/** The rule block for `name`, from its `- alert:` line to the next one or EOF. */
const ruleBlock = (source: string, name: string): string => {
  const start = source.indexOf(`- alert: ${name}`);
  if (start === -1) return '';
  const next = source.indexOf('- alert: ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

// The four the file itself lists as removed-for-want-of-a-series, each named
// beside the metric it reads.
// Annotated, never cast. `as MetricName[]` would let a name that has left the
// union sit here unnoticed, which is the one failure this list exists to catch.
const RESTORED: readonly (readonly [string, readonly MetricName[]])[] = [
  ['HighTickFailureRate', ['tick_failures_total', 'tick_total']],
  ['QueueBacklog', ['bullmq_queue_wait_jobs']],
  ['DBPoolStarved', ['pg_pool_waiting']],
  ['WSDisconnectsHigh', ['binance_ws_disconnects_total']],
];

const AUDIT_ENTRIES_STUCK: MetricName = 'audit_entries_stuck';

describe('alert rules against the metric catalogue', () => {
  it('carries a rule for every failure mode whose series the worker now emits', () => {
    const source = alerts();
    for (const [name] of RESTORED) {
      expect(ruleBlock(source, name)).not.toBe('');
    }
  });

  it('reads only series the catalogue registers, so no rule evaluates empty forever', () => {
    const source = alerts();
    for (const [name, metrics] of RESTORED) {
      const block = ruleBlock(source, name);
      for (const metric of metrics) {
        // Only the rule side is asserted at runtime. The catalogue side is
        // already total by construction — `CATALOG` is annotated
        // `Readonly<Record<MetricName, MetricSpec>>`, so a name in the union
        // with no entry does not compile — and a `toBeDefined()` on top of that
        // can never fail while the build is green. It would read as a check and
        // hold nothing. The names below are typed `MetricName`, so dropping one
        // from the union breaks this file at compile time instead.
        expect(block).toContain(metric);
      }
    }
    expect(ruleBlock(source, 'AuditEntriesStuck')).toContain(AUDIT_ENTRIES_STUCK);
  });

  it('no longer advertises these failure modes as unwatched', () => {
    // The trailing block is what an operator reads to know what does NOT page
    // them. Leaving a restored rule listed there is worse than a missing rule:
    // it tells them not to expect a page that will now arrive.
    const source = alerts();
    for (const [name] of RESTORED) {
      expect(source).not.toMatch(new RegExp(`#\\s+- ${name} wanted`));
    }
  });
});

describe('the asset-policy abort rule against the cause union', () => {
  it('routes every cause the worker can label, by name', () => {
    // The description is the whole remedy: it tells the operator which upstream fault this cause means and what to do about it, per cause. Nothing else ties that prose to the union — the CI gate reads metric names and label keys and skips annotations entirely — so a cause added to the union reaches an operator as a bare literal with no guidance beside it, which is what happened to the two product-feed causes across five surfaces. Iterated from the runtime array on purpose: a type-level guard is erased before this file runs and would hold nothing.
    const block = ruleBlock(alerts(), 'DiscoveryAssetPolicyAborting');
    expect(block).not.toBe('');
    for (const cause of ASSET_POLICY_ABORT_CAUSES) {
      expect(block).toContain(cause);
    }
  });
});

describe('the Binance weight rule comment', () => {
  it('describes the gauge as retired on teardown rather than stuck forever', () => {
    const block = ruleBlock(alerts(), 'BinanceWeightExhausted');
    // The paragraph told the operator to distrust a firing instance. Once the
    // child is removed on disable and dispose the series goes stale on its own,
    // and advice to second-guess a real page is how a real page gets ignored.
    expect(block).not.toContain('KNOWN HAZARD');
    expect(block).toContain('forget');
  });

  it('still evaluates the bare weight gauge, with no activity series ANDed in', () => {
    const block = ruleBlock(alerts(), 'BinanceWeightExhausted');
    const expr = block.split('\n').find((line) => line.trimStart().startsWith('expr:')) ?? '';

    // A ban fails every REST call, so any tick-derived guard goes flat exactly
    // when the weight is exhausted and would send a RESOLVED notification in the
    // middle of the incident. A page that falsely reports recovery is worse than
    // one that sticks.
    expect(expr.trim()).toBe('expr: binance_api_weight > 1000');
  });
});

describe('the generated metrics catalogue page', () => {
  it('documents every metric the worker can emit', () => {
    // The page is generated from CATALOG and checked by `docs:gen --check`, so a
    // metric added without regenerating fails the docs gate. This asserts the
    // page exists and is keyed on the same source, which is what makes that gate
    // mean anything.
    expect(existsSync(METRICS_PARTIAL)).toBe(true);
    const page = readFileSync(METRICS_PARTIAL, 'utf8');
    for (const name of Object.keys(CATALOG)) {
      expect(page).toContain(name);
    }
  });
});
