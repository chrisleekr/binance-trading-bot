// Moved here with the function it covers. Two surfaces read this verdict now —
// the 5-minute alert cron and the on-demand diagnosis — so the behaviour has to
// be pinned once, at the definition, not once per caller.

import { describe, expect, it } from 'vitest';
import {
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
