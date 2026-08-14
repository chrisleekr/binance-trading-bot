// Cron registry.
//
// `buildCrons(ctx)` returns the worker's CronDef array, constructed from
// the BootContext. Adding a cron = one new `*.cron.ts` file + one entry
// here. There is no central god-union deps interface: each `*.cron.ts`
// closes over only what it needs from `ctx` at its `build...Cron(ctx)`
// call site.

import type { BootContext } from 'boot/boot-context.js';
import type { CronDef } from './define.js';

import { buildAccountSnapshotSafetyCron } from './account-snapshot-safety.cron.js';
import { buildActionLogPruneCron } from './action-log-prune.cron.js';
import { buildAliveCron } from './alive.cron.js';
import { buildArchiveRecoverySweepCron } from './archive-recovery-sweep.cron.js';
import { buildAuditPruneCron } from './audit-prune.cron.js';
import { buildBacktestSweepCron } from './backtest-sweep.cron.js';
import { buildDailyAthCron } from './daily-ath.cron.js';
import { buildDbBackupCron } from './db-backup.cron.js';
import { buildDetachedOrdersReconcileCron } from './detached-orders-reconcile.cron.js';
import { buildDiscoveryCron } from './discovery.cron.js';
import { buildDiscoveryHealthCron } from './discovery-health.cron.js';
import { buildDiscoverySnapshotPruneCron } from './discovery-snapshot-prune.cron.js';
import { buildDustSnapshotCron } from './dust-snapshot.cron.js';
import { buildEdgeDecayMonitorCron } from './edge-decay-monitor.cron.js';
import { buildEquitySnapshotCron } from './equity-snapshot.cron.js';
import { buildEquitySnapshotPruneCron } from './equity-snapshot-prune.cron.js';
import { buildExchangeInfoRefreshCron } from './exchange-info-refresh.cron.js';
import { buildHeldQuantityReconcileCron } from './held-quantity-reconcile.cron.js';
import { buildStaleOrderReapCron } from './stale-order-reap.cron.js';
import { buildMarketTrendCron } from './market-trend.cron.js';
import { buildOrphanOrdersDetectCron } from './orphan-orders-detect.cron.js';
import { buildPortfolioRiskCron } from './portfolio-risk.cron.js';
import { buildTechnicalsComputeCron } from './technicals-compute.cron.js';

export const buildCrons = (ctx: BootContext): readonly CronDef[] => [
  buildExchangeInfoRefreshCron(ctx),
  buildActionLogPruneCron(ctx),
  buildAuditPruneCron(ctx),
  buildAliveCron(ctx),
  buildTechnicalsComputeCron(ctx),
  buildDailyAthCron(ctx),
  buildAccountSnapshotSafetyCron(ctx),
  buildDustSnapshotCron(ctx),
  buildOrphanOrdersDetectCron(ctx),
  buildDetachedOrdersReconcileCron(ctx),
  buildHeldQuantityReconcileCron(ctx),
  buildArchiveRecoverySweepCron(ctx),
  buildStaleOrderReapCron(ctx),
  buildDiscoveryCron(ctx),
  buildDiscoveryHealthCron(ctx),
  buildDiscoverySnapshotPruneCron(ctx),
  buildMarketTrendCron(ctx),
  buildPortfolioRiskCron(ctx),
  buildEdgeDecayMonitorCron(ctx),
  buildBacktestSweepCron(ctx),
  buildEquitySnapshotCron(ctx),
  buildEquitySnapshotPruneCron(ctx),
  buildDbBackupCron(ctx),
];
