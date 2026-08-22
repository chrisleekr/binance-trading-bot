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
 * The gap a missing scan is allowed before it counts as a stall: twice the profile's own refresh period, inclusive, so a silence of exactly two periods is still healthy and anything past it is not.
 *
 * Module-private and shared, because the staleness verdict and {@link abortStillExplainsGap} are two halves of ONE lease. Two literals for one bound is how a monitor comes to alert on a gap that another surface is simultaneously explaining away, and nothing would fail until an operator read both pages.
 *
 * @param refreshPeriodMs - The profile's configured discovery cadence.
 * @returns The maximum silence, in ms, that is not yet a stall.
 */
const staleAfterMs = (refreshPeriodMs: number): number => 2 * refreshPeriodMs;

/**
 * Whether a parked asset-policy abort is recent enough to be the reason THIS gap in scans exists.
 *
 * The exact complement of the staleness verdict, over the same bound: a cycle that refused to rank produced no snapshot, so the abort and the stall are one event seen twice. Past the bound the abort is history rather than this gap's cause, and the stall has to be reported on its own terms again.
 *
 * A record stamped in the FUTURE explains nothing and is refused rather than trusted. The stamp is a plain Redis value the schema already treats as untrusted, and a clock step-back reaches the same state honestly; either way a negative age would satisfy an upper bound forever, muting the staleness monitor for the record's whole TTL — the one direction this helper must never fail in.
 *
 * @param abortAtMs - When the newest refusal happened, epoch ms, as parked by the discovery cron.
 * @param refreshPeriodMs - The profile's configured discovery cadence, the same one the staleness verdict is measured against.
 * @param nowMs - The instant being judged.
 * @returns True while the abort still accounts for the missing scans.
 */
export const abortStillExplainsGap = (
  abortAtMs: number,
  refreshPeriodMs: number,
  nowMs: number,
): boolean => {
  const ageMs = nowMs - abortAtMs;
  return ageMs >= 0 && ageMs <= staleAfterMs(refreshPeriodMs);
};

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
  const stale = nowMs - newestMs > staleAfterMs(refreshPeriodMs);
  const breadthBlocked =
    snapshots.length >= window && snapshots.slice(0, window).every((s) => s.breadthOk === false);
  return { stale, breadthBlocked };
};
