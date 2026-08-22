// discovery-health cron.
//
// The discovery-run cron is fail-safe by design: a wedged gate, a bad-data
// cycle, or a market-breadth floor set too high all leave the auto-set frozen
// WITHOUT an error — the profile simply stops rotating symbols, silently, until
// an operator happens to look. This monitor closes that visibility hole with two
// throttled, advisory alerts. It never mutates the symbol set or pauses anything.
//
// TRIGGER 1 (staleness): no discovery snapshot in over twice the profile's own
// refresh period — the scan has stopped producing, so discovery is likely wedged
// or stopped. The durable snapshot's `captured_at` is the source of truth here,
// NOT the Redis `discovery:lastrun` gate key: that key self-expires after ONE
// period, so it cannot witness a >2x stall (it would already be gone).
//
// TRIGGER 2 (persistent breadth block): the last N scans ALL have
// `funnel.breadthOk === false` — every add has been blocked by the market-breadth
// floor for N cycles, so the floor may be unreachable for this quote asset.
//
// Each (profile, trigger) is throttled fleet-wide via a self-expiring `SET NX PX`
// window (createRedisWindowThrottle), so a standing condition alerts once per
// window rather than every 5-minute tick. That is a TTL'd idempotency key, not a
// lock: no owner, no release, it self-expires.
//
// TRIGGER 1 has one exemption. A cycle that refused to rank on an asset-policy
// abort produces no snapshot, so the staleness bound trips on the very gap that
// refusal already explains — and the operator gets two pages about one fault,
// the interrupting one naming the wrong cause. While a parked abort is recent
// enough to still be that gap's reason, the stale trigger does not alert and
// does not OPEN its condition; the abort's own finding is what says what
// happened. Only that opening edge is suppressed. A close still runs, because a
// close is written from a not-stale verdict, which means a snapshot landed and
// "Discovery is scanning again" is true whatever is still parked. TRIGGER 2 is
// never suppressed — a breadth floor that admits nothing is a separate fault an
// abort says nothing about.
//
// Both verdicts are ALSO recorded as durable conditions, and that write is
// deliberately outside the alert throttle. The throttle limits how often the
// operator is interrupted; the condition store answers "what is true now, and
// since when", which an hourly suppression window would corrupt. It is the only
// path that ever CLEARS these conditions, so it runs on every pass, healthy or
// not — an alert has nothing to say when a problem goes away, and "recovered at
// 14:02" is exactly what the diagnosis needs.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  abortStillExplainsGap,
  assessDiscoveryHealth,
  DISCOVERY_HEALTH_WINDOW,
  unwrapId,
  type AssetPolicyAbortRecord,
  type Condition,
  type ProfileId,
  type SnapshotHealth,
} from '@app/contracts';
import { profileRepo, type DiscoveryUniverseSnapshotPayload } from '@app/db';
import { createRedisWindowThrottle } from 'executor/notifier-gap-throttle.js';
import { readAssetPolicyAbortRecord } from './discovery/abort-record.js';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';
import { parseDiscoveryConfig } from './discovery.cron.js';

/** One-hour suppression window per (profile, trigger); mirrors the notifier-gap default. */
export const DEFAULT_DISCOVERY_HEALTH_WINDOW_MS = 3_600_000;

export const DISCOVERY_HEALTH_KEY_PREFIX = 'discovery-health-throttle:';

/** The two health conditions, each throttled independently per profile. */
export type DiscoveryHealthTrigger = 'stale' | 'breadth-block';

/** The condition each trigger records, and the code it carries while open. */
const CONDITION_FOR: Record<DiscoveryHealthTrigger, { condition: Condition; code: string }> = {
  stale: { condition: 'discovery-stale', code: 'no-recent-scan' },
  'breadth-block': { condition: 'discovery-breadth-blocked', code: 'breadth-floor' },
};

export interface DiscoveryHealthDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Enabled discovery settings for a profile, or null when disabled / gone. */
  readonly loadConfig: (p: ActiveProfile) => Promise<{ readonly refreshPeriodMs: number } | null>;
  /** The profile's most-recent snapshots, newest-first, capped at `limit`. */
  readonly recentSnapshots: (p: ActiveProfile, limit: number) => Promise<readonly SnapshotHealth[]>;
  /** The profile's parked asset-policy abort, or null when none is recorded or it could not be read. */
  readonly readAssetPolicyAbort: (p: ActiveProfile) => Promise<AssetPolicyAbortRecord | null>;
  /** Notify the operator (gated by the profile's notify_events subscription). */
  readonly notify: NotifyEvent;
  /** Fleet-wide per-(profile, trigger) throttle; true when the alert may fire now. */
  readonly allowAlert: (profileId: ProfileId, trigger: DiscoveryHealthTrigger) => Promise<boolean>;
  /** Record a profile-level condition's current code; null means it no longer holds. */
  readonly recordCondition: (
    profile: ActiveProfile,
    input: { condition: Condition; code: string | null; msg: string },
  ) => Promise<void>;
  readonly clock?: { nowMs(): number };
}

const staleBody = (refreshPeriodMs: number): string =>
  `Auto-discovery has not produced a scan in over twice its refresh interval (${Math.round(
    refreshPeriodMs / 60_000,
  )} min). It may be wedged or stopped — new symbols will not rotate in until it resumes. Check the worker and this profile's discovery settings.`;

const breadthBody = `Every auto-discovery add has been blocked by the market-breadth floor for the last ${DISCOVERY_HEALTH_WINDOW} scans. The floor may be set too high to ever admit a symbol for this quote asset — review the market-breadth setting.`;

/**
 * Record one trigger's current truth. The writer itself is a no-op when nothing
 * changed, so calling this every pass costs one read per trigger per profile per
 * 5 minutes and writes only on a real transition.
 */
const recordHealthCondition = async (
  deps: DiscoveryHealthDeps,
  profile: ActiveProfile,
  trigger: DiscoveryHealthTrigger,
  open: boolean,
  openMsg: string,
): Promise<void> => {
  const { condition, code } = CONDITION_FOR[trigger];
  await deps.recordCondition(profile, {
    condition,
    code: open ? code : null,
    msg: open
      ? openMsg
      : `Discovery ${trigger === 'stale' ? 'is scanning again' : 'is admitting symbols again'}.`,
  });
};

/**
 * Per-profile health scan. One profile's failure is isolated (logged, loop
 * continues) so a single bad profile never aborts the fleet-wide check. Never
 * throws for a per-profile fault; the surrounding cron wrapper only sees a clean
 * completion, matching the fail-safe contract of the discovery-run cron.
 */
export const discoveryHealthHandler =
  (deps: DiscoveryHealthDeps) =>
  async (_job: Job): Promise<void> => {
    const nowMs = (deps.clock ?? { nowMs: () => Date.now() }).nowMs();
    for (const p of deps.listActive()) {
      try {
        const cfg = await deps.loadConfig(p);
        if (!cfg) continue;
        const snapshots = await deps.recentSnapshots(p, DISCOVERY_HEALTH_WINDOW);
        const { stale, breadthBlocked } = assessDiscoveryHealth(
          snapshots,
          cfg.refreshPeriodMs,
          nowMs,
          DISCOVERY_HEALTH_WINDOW,
        );
        // Fail-safe on its own read: an unreadable record is not evidence of an abort, and a monitor that mutes itself whenever its lookup blips is quiet exactly when it should not be. The reader already degrades to null, so this catch only covers a wiring that does not.
        const abort = await deps.readAssetPolicyAbort(p).catch(() => null);
        const suppressStale =
          abort !== null && abortStillExplainsGap(abort.atMs, cfg.refreshPeriodMs, nowMs);
        if (stale && !suppressStale && (await deps.allowAlert(p.profileId, 'stale'))) {
          deps.logger.warn(
            { profileId: unwrapId(p.profileId) },
            'discovery-health: no recent snapshot — discovery may be wedged or stopped',
          );
          await deps.notify({
            category: 'discovery-health',
            operatorId: p.operatorId,
            accountId: p.accountId,
            profileId: p.profileId,
            body: staleBody(cfg.refreshPeriodMs),
          });
        }
        if (breadthBlocked && (await deps.allowAlert(p.profileId, 'breadth-block'))) {
          deps.logger.warn(
            { profileId: unwrapId(p.profileId) },
            'discovery-health: market-breadth floor has blocked every add for the whole window',
          );
          await deps.notify({
            category: 'discovery-health',
            operatorId: p.operatorId,
            accountId: p.accountId,
            profileId: p.profileId,
            body: breadthBody,
          });
        }
        // After the alerts, so a condition write can never suppress one. Both
        // are recorded every pass, including the healthy pass that clears them —
        // except for the stale condition's OPENING edge while an abort explains
        // the gap, which would put a cause on the profile that no check produced.
        // Only the open edge: a close is written when `stale` is false, which
        // means a snapshot landed, so "Discovery is scanning again" is true by
        // construction. Suppressing that too would strand an already-open finding
        // on a profile that is demonstrably scanning, which is reachable because
        // the record's own clear swallows a failed delete.
        if (!(suppressStale && stale)) {
          await recordHealthCondition(deps, p, 'stale', stale, staleBody(cfg.refreshPeriodMs));
        }
        await recordHealthCondition(deps, p, 'breadth-block', breadthBlocked, breadthBody);
      } catch (err) {
        deps.logger.warn(
          { profileId: unwrapId(p.profileId), err: err },
          'discovery-health: profile check failed (will retry next tick)',
        );
      }
    }
  };

export const buildDiscoveryHealthCron = (ctx: BootContext): CronDef => {
  const throttle = createRedisWindowThrottle({
    redis: ctx.redis,
    logger: ctx.logger,
    prefix: DISCOVERY_HEALTH_KEY_PREFIX,
    windowMs: DEFAULT_DISCOVERY_HEALTH_WINDOW_MS,
  });
  return defineCron({
    name: 'discovery-health',
    queue: QUEUE_NAMES.discoveryHealth,
    pattern: '0 */5 * * * *',
    handler: discoveryHealthHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      loadConfig: async (p) => {
        const repo = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
        const profile = await repo.profile.findById();
        if (!profile) return null;
        // An unparseable config is the discovery cron's condition to record, not
        // this monitor's; here it just means there is no cadence to judge
        // staleness against.
        const parsed = parseDiscoveryConfig(
          (profile as { discoveryConfig?: unknown }).discoveryConfig,
        );
        if (!parsed.ok || !parsed.cfg.enabled) return null;
        return { refreshPeriodMs: parsed.cfg.refreshPeriodMs };
      },
      recentSnapshots: async (p, limit) => {
        const repo = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
        const rows = await repo.discoveryUniverseSnapshots.listForProfile(limit);
        return rows.map((r) => ({
          capturedAtMs: r.capturedAt.getTime(),
          breadthOk: (r.snapshot as DiscoveryUniverseSnapshotPayload).funnel?.breadthOk,
        }));
      },
      readAssetPolicyAbort: (p) =>
        readAssetPolicyAbortRecord(ctx.redis, ctx.logger, unwrapId(p.profileId)),
      notify: ctx.notifyEvent,
      allowAlert: (profileId, trigger) => throttle.allow(`${trigger}:${unwrapId(profileId)}`),
      recordCondition: async (p, input) => {
        const repo = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
        await repo.conditionStates.recordCondition({ ...input, now: new Date() });
      },
    }),
  });
};
