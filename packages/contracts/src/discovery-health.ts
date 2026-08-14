// Discovery health: is the scan producing, and is the breadth floor admitting
// anything? Pure verdict over persisted snapshots, no I/O.
//
// This lives here rather than beside the cron that alerts on it because two
// surfaces now need the SAME answer: the 5-minute monitor that notifies, and
// the on-demand profile diagnosis that explains. Two implementations of one
// verdict is how a monitor and a report come to disagree about the same
// profile, and the operator is left with no way to tell which one is lying.

/** The two facts the health assessment reads off one persisted snapshot. */
export interface SnapshotHealth {
  readonly capturedAtMs: number;
  /** `funnel.breadthOk`, or undefined for a snapshot persisted before the funnel field. */
  readonly breadthOk: boolean | undefined;
}

/**
 * How many recent snapshots the breadth-block verdict inspects. A documented
 * constant, not a config knob: it is the evidence window for "persistently
 * blocked", tuned to the ~5-min monitor cadence, not something the operator sizes.
 */
export const DISCOVERY_HEALTH_WINDOW = 8;

/**
 * Pure health verdict from a profile's recent snapshots (newest-first). Total:
 * an empty history reads as stale (the scan is producing nothing). `breadthBlocked`
 * requires a FULL window of snapshots all breadth-blocked — fewer than `window`
 * rows is not yet evidence of persistence, and an old row missing `breadthOk`
 * (undefined) is not `=== false`, so it breaks the run and fails safe.
 */
export const assessDiscoveryHealth = (
  snapshots: readonly SnapshotHealth[],
  refreshPeriodMs: number,
  nowMs: number,
  window: number,
): { stale: boolean; breadthBlocked: boolean } => {
  if (snapshots.length === 0) return { stale: true, breadthBlocked: false };
  const newestMs = Math.max(...snapshots.map((s) => s.capturedAtMs));
  const stale = nowMs - newestMs > 2 * refreshPeriodMs;
  const breadthBlocked =
    snapshots.length >= window && snapshots.slice(0, window).every((s) => s.breadthOk === false);
  return { stale, breadthBlocked };
};
