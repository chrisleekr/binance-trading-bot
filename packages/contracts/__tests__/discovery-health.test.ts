// Moved here with the function it covers. Two surfaces read this verdict now —
// the 5-minute alert cron and the on-demand diagnosis — so the behaviour has to
// be pinned once, at the definition, not once per caller.

import { describe, expect, it } from 'vitest';
import {
  abortStillExplainsGap,
  assessDiscoveryHealth,
  DISCOVERY_HEALTH_WINDOW,
  type SnapshotHealth,
} from '../src/discovery-health.js';

const NOW = 1_700_000_000_000;
const REFRESH = 900_000; // 15 min

const snap = (capturedAtMs: number, breadthOk: boolean | undefined): SnapshotHealth => ({
  capturedAtMs,
  breadthOk,
});

const fullWindow = (breadthOk: boolean): SnapshotHealth[] =>
  Array.from({ length: DISCOVERY_HEALTH_WINDOW }, (_, i) => snap(NOW - i * 60_000, breadthOk));

describe('assessDiscoveryHealth', () => {
  it('reads an empty history as stale and not breadth-blocked', () => {
    expect(assessDiscoveryHealth([], REFRESH, NOW, DISCOVERY_HEALTH_WINDOW)).toEqual({
      stale: true,
      breadthBlocked: false,
    });
  });

  it('is stale when the newest snapshot is older than twice the refresh period', () => {
    const r = assessDiscoveryHealth(
      [snap(NOW - 3 * REFRESH, true)],
      REFRESH,
      NOW,
      DISCOVERY_HEALTH_WINDOW,
    );
    expect(r.stale).toBe(true);
  });

  it('is not stale at exactly twice the refresh period (strict >)', () => {
    const r = assessDiscoveryHealth(
      [snap(NOW - 2 * REFRESH, true)],
      REFRESH,
      NOW,
      DISCOVERY_HEALTH_WINDOW,
    );
    expect(r.stale).toBe(false);
  });

  it('breadth-blocks only on a FULL window that is all breadthOk=false', () => {
    expect(
      assessDiscoveryHealth(fullWindow(false), REFRESH, NOW, DISCOVERY_HEALTH_WINDOW)
        .breadthBlocked,
    ).toBe(true);
    // One fewer than a full window is not yet evidence of persistence.
    expect(
      assessDiscoveryHealth(
        fullWindow(false).slice(0, DISCOVERY_HEALTH_WINDOW - 1),
        REFRESH,
        NOW,
        DISCOVERY_HEALTH_WINDOW,
      ).breadthBlocked,
    ).toBe(false);
  });

  it('does not breadth-block when any snapshot is not strictly false (undefined breaks the run)', () => {
    const withGap = fullWindow(false);
    withGap[3] = snap(NOW - 3 * 60_000, undefined); // an old row predating the funnel field
    expect(
      assessDiscoveryHealth(withGap, REFRESH, NOW, DISCOVERY_HEALTH_WINDOW).breadthBlocked,
    ).toBe(false);
  });
});

// A parked abort explains the missing scan only while it is recent enough to be
// the reason for THIS gap, and "recent enough" is the same lease the staleness
// verdict measures. Two copies of that bound is how a monitor comes to alert on
// a gap another surface is simultaneously explaining, so these pin the helper
// against the verdict rather than against a second copy of the number.
describe('abortStillExplainsGap', () => {
  const staleAtAge = (ageMs: number): boolean =>
    assessDiscoveryHealth([snap(NOW - ageMs, true)], REFRESH, NOW, DISCOVERY_HEALTH_WINDOW).stale;

  it.each([REFRESH, 2 * REFRESH, 2 * REFRESH + 1, 3 * REFRESH])(
    'is the exact complement of the stale verdict at an age of %d ms',
    (ageMs) => {
      expect(abortStillExplainsGap(NOW - ageMs, REFRESH, NOW)).toBe(!staleAtAge(ageMs));
    },
  );

  it('refuses a stamp from the future, which would otherwise suppress forever', () => {
    // The value is a plain Redis record the schema already treats as untrusted, and a clock step-back reaches the same state honestly. A negative age satisfies an upper bound at every later instant, so an open-ended `<=` would mute the staleness monitor for the record's whole TTL — the one direction this helper must never fail in.
    expect(abortStillExplainsGap(NOW + 1, REFRESH, NOW)).toBe(false);
    expect(abortStillExplainsGap(NOW + 10 * REFRESH, REFRESH, NOW)).toBe(false);
    // The boundary itself is not the future.
    expect(abortStillExplainsGap(NOW, REFRESH, NOW)).toBe(true);
  });

  it('still explains the gap at exactly twice the refresh period, and not one ms later', () => {
    // Absolute, not relative: the complement cases above hold trivially if both sides collapse to one answer, and only these say which answer the boundary itself gives.
    expect(abortStillExplainsGap(NOW - 2 * REFRESH, REFRESH, NOW)).toBe(true);
    expect(abortStillExplainsGap(NOW - (2 * REFRESH + 1), REFRESH, NOW)).toBe(false);
  });
});
