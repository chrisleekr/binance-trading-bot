// EnabledSetReconciler: periodically converges this pod's ProfileManager to the
// fleet-global enabled set in the DB, then re-elects stream ownership.
//
// subscribe/unsubscribe/reconfigure arrive as single-consumer BullMQ pipeline
// jobs, delivered to exactly one pod. At replicas>1 the other pods never learn
// of a post-boot change, so their `listActive()` diverges and HRW ownership can
// elect a pod that doesn't know the account exists (missed fills) or keep
// streaming a disabled one. This loop closes that gap: every pod re-reads the
// enabled set on an interval and converges membership, so a runtime change
// propagates fleet-wide within one interval.
//
// Membership only — opening/closing the account user-data stream is
// subscription-ownership's job. This loop calls `ownership.reconcile()` after
// applying the membership diff so a newly-enabled (or removed) account's stream
// converges in the same pass rather than waiting for ownership's own tick.
//
// Single replica: the pipeline job already applied the change on the sole pod,
// so each pass is a no-op diff; the cost is one `listAllEnabled` read per
// interval, negligible for a single account with a handful of profiles.

import type { Logger } from 'pino';

import type { ProfileLoadRow, ProfileManager } from './profile-manager.js';

/** Default cadence. Longer than the member heartbeat: runtime changes are
 *  applied instantly on the consuming pod (and its ownership kick), so this is
 *  the fleet-wide backstop, not the fast path. */
export const ENABLED_SET_RECONCILE_MS = 30_000;

export interface EnabledSetReconcilerDeps {
  readonly loadEnabledProfiles: () => Promise<readonly ProfileLoadRow[]>;
  readonly profileManager: Pick<ProfileManager, 'reconcile'>;
  /** Re-elects stream ownership over the converged membership. */
  readonly ownership: { reconcile(): Promise<void> };
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface EnabledSetReconciler {
  /** Run one reconcile now, then on the interval. */
  start(): Promise<void>;
  stop(): void;
  /** One membership converge + ownership re-election. Best-effort. Exposed for tests. */
  reconcile(): Promise<void>;
}

export const createEnabledSetReconciler = (
  deps: EnabledSetReconcilerDeps,
): EnabledSetReconciler => {
  const intervalMs = deps.intervalMs ?? ENABLED_SET_RECONCILE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;

  const reconcile = async (): Promise<void> => {
    // Serialise: a slow load/reconcile must not overlap the next interval tick.
    if (inFlight) return;
    inFlight = true;
    try {
      let rows: readonly ProfileLoadRow[];
      try {
        rows = await deps.loadEnabledProfiles();
      } catch (err) {
        // A DB blip must not tear down the active set: skip this pass and keep
        // the current membership. The next tick reconverges.
        deps.logger.warn(
          { err: err },
          'enabled-set-reconciler: enabled-set read failed; keeping current membership',
        );
        return;
      }
      await deps.profileManager.reconcile(rows);
      // A pass that began before stop() must not re-elect ownership during
      // drain: stop() only clears the timer, so an in-flight pass could
      // otherwise reopen a stream the shutdown is tearing down. Bail before the
      // re-election once stopped.
      if (stopped) return;
      // Converge streams to the new membership immediately rather than waiting
      // for ownership's own interval.
      await deps.ownership.reconcile();
    } catch (err) {
      // Best-effort: a converge/re-election error (e.g. a market-hook reject in
      // profileManager.reconcile) must not reject the timer callback (an
      // unhandled rejection) or fail boot via start()'s awaited first pass. The
      // next interval reconverges. Mirrors subscription-ownership, which wraps
      // its whole body for the same reason.
      deps.logger.error(
        { err: err },
        'enabled-set-reconciler: converge failed; will retry next interval',
      );
    } finally {
      inFlight = false;
    }
  };

  return {
    reconcile,
    async start() {
      await reconcile();
      timer = setInterval(() => void reconcile(), intervalMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
};
