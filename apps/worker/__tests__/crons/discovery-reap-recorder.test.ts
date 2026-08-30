// The discovery reap counter's only non-zero write site.
//
// It lives in a factory rather than inline at the cron's port adapter because that adapter is not under test, and all three parts of the emission fail SILENTLY when wrong: the sink drops a name it does not recognise, `inc(0)` never moves a series, and a mistyped label key resolves to `unknown` because `record`'s tags are a plain string record rather than a type derived from `labelNames`. Each of those leaves a counter reading a healthy flat zero, which is the exact failure the counter exists to detect.

import { describe, expect, it, vi } from 'vitest';
import { DISCOVERY_REAP_OUTCOMES, reapOutcomeRecorder } from '../../src/crons/discovery-reap.js';
import { CATALOG, type MetricsSink } from '../../src/metrics/catalog.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

const sink = () => {
  const record = vi.fn();
  return { record, metrics: { record, forget: vi.fn() } as MetricsSink };
};

describe('reapOutcomeRecorder', () => {
  it.each(DISCOVERY_REAP_OUTCOMES)(
    'increments the counter by one for %s, labelled by profile and outcome',
    (outcome) => {
      const { record, metrics } = sink();
      reapOutcomeRecorder(metrics, PROFILE_ID)(outcome);
      expect(record).toHaveBeenCalledWith('discovery_reap_outcome_total', 1, {
        profileId: PROFILE_ID,
        outcome,
      });
      expect(record).toHaveBeenCalledTimes(1);
    },
  );

  it('emits exactly the label keys the catalogue declares, in no more and no fewer', () => {
    // The sink reads `labelNames.map((key) => tags?.[key] ?? 'unknown')`, so a key the catalogue does not declare is dropped and a declared key the caller omits becomes the string `unknown`. Neither throws, and both collapse every series into one useless child. Derived from CATALOG rather than restated so a label added there without a caller change fails here.
    const { record, metrics } = sink();
    reapOutcomeRecorder(metrics, PROFILE_ID)('wallet-held');
    const tags = record.mock.calls[0]?.[2] as Record<string, string>;
    expect(Object.keys(tags).sort()).toEqual(
      [...CATALOG.discovery_reap_outcome_total.labelNames].sort(),
    );
  });

  it('binds one profile per recorder, so a wake over several profiles cannot cross-label', () => {
    const { record, metrics } = sink();
    const other = '00000000-0000-4000-8000-000000000002';
    reapOutcomeRecorder(metrics, PROFILE_ID)('removed');
    reapOutcomeRecorder(metrics, other)('pinned');
    expect(record.mock.calls.map((c) => (c[2] as { profileId: string }).profileId)).toEqual([
      PROFILE_ID,
      other,
    ]);
  });
});
