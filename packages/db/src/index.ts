export {
  createPool,
  poolCheckoutTimeoutKind,
  POOL_CHECKOUT_TIMEOUT_MS,
  type CreatePoolOptions,
  type PoolCheckoutTimeout,
  type PoolKind,
} from './pool.js';
export { createDb, type Database } from './db.js';
export { migrate, type MigrateOptions, type MigrateResult } from './migrate.js';
export { assertTestDatabaseUrl } from './test-guard.js';
export { withStatementTimeout, isStatementTimeout } from './statement-timeout.js';
export { intervalToMs, computeMissingRanges, type MsRange } from './candle-intervals.js';
export * as schema from './schema/index.js';
export type {
  DiscoveryUniverseSnapshotPayload,
  DiscoveryUniverseSnapshotRow,
} from './schema/discovery-universe-snapshots.js';
export type { EquitySnapshotPayload, EquitySnapshotRow } from './schema/equity-snapshots.js';
export type { BackupConfigRow } from './schema/backup-config.js';
export type { AiProviderConfigRow } from './schema/ai-provider-config.js';
export { toAiProviderConfig } from './ai-provider-config.js';
export type { BacktestRunRow } from './schema/backtest-runs.js';
export type { BacktestResultLedgerRow } from './schema/backtest-result-ledger.js';
export type { BacktestAdvisorResultRow } from './schema/backtest-advisor-result.js';
export type { LedgerEntry, LedgerWindow } from './repo/result-ledger.js';
export type { ReapExpiredResult } from './repo/override-actions.js';
export type { RecoveryAttributionRow } from './repo/orders.js';
export type { ActionLogInsert, ActionLogRow } from './schema/action-logs.js';
export type { RetentionConfigRow } from './schema/retention-config.js';
export type { ActionLogCursor, ActionLogFilter } from './repo/action-logs.js';
// The subject sentinel every reader of `condition_states` needs to tell a
// profile-level row from a symbol row.
export { PROFILE_SUBJECT } from './repo/condition-states.js';
export {
  FLEET_COUNT_KEY,
  MEMBER_KEY_PREFIX,
  countWorkerMembers,
  listReadyMembers,
  parseFleetCount,
  type FleetCount,
  type MemberRecord,
} from './worker-members.js';
export * as repo from './repo/index.js';
export * as projections from './repo/projections/index.js';
export type { ProjectionRedis, AuditLogExportRow } from './repo/projections/index.js';
export {
  AccountNotOwnedError,
  BaseAssetConflictError,
  ProfileNotOwnedError,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
  scopeAccount,
  scopeProfile,
  toAccountScope,
  withAccountTx,
  withTx,
  accountRepo,
  accountRepoFromScope,
  profileRepo,
  profileRepoFromScope,
  type AccountRepo,
  type AccountScope,
  type ProfileRepo,
  type ProfileScope,
} from './repo/index.js';
export {
  createRedis,
  createBullMQConnection,
  type ScopedRedis,
  type ProfileRedisOps,
  type GlobalRedisOps,
  type RedisScope,
  type RedisProfileScope,
  type GlobalScope,
  type ProfileScopedKeyName,
  type GlobalScopedKeyName,
  type ProfileKeyParts,
  PROFILE_KEYS,
  GLOBAL_KEYS,
  ORPHAN_SNAPSHOT_TTL_S,
  DISCOVERY_ASSET_POLICY_ABORT_TTL_S,
  profileKey,
  profilePrefix,
  dashboardAggregateCacheKey,
  openOrdersKey,
  accountPermissionsKey,
  eventsChannelKey,
  eventsStreamKey,
  eventsSeqKey,
  auditStreamKey,
  EVENTS_CHANNEL_PATTERN,
} from './redis.js';
