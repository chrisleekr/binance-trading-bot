import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Database } from './_db.js';
import { bindAccountModule, bindModule, type AccountScopeBound, type ScopeBound } from './_bind.js';
import { scopeAccount, scopeProfile, type AccountScope, type ProfileScope } from './_scoped.js';

import * as accountsMod from './accounts.js';
import * as actionLogs from './action-logs.js';
import * as aiProviderConfig from './ai-provider-config.js';
import * as apiKeys from './api-keys.js';
import * as appliedFills from './applied-fills.js';
import * as auditLogs from './audit-logs.js';
import * as backtestAdvisorResults from './backtest-advisor-results.js';
import * as backtestRuns from './backtest-runs.js';
import * as backupConfig from './backup-config.js';
import * as candles from './candles.js';
import * as conditionStates from './condition-states.js';
import * as diagnosisRuns from './diagnosis-runs.js';
import * as discoveryUniverseSnapshots from './discovery-universe-snapshots.js';
import * as equitySnapshots from './equity-snapshots.js';
import * as avgEntryPrices from './avg-entry-prices.js';
import * as manualOrders from './manual-orders.js';
import * as opsNotifyConfig from './ops-notify-config.js';
import * as orders from './orders.js';
import * as overrideActions from './override-actions.js';
import * as profileKv from './profile-kv.js';
import * as profileNotifiers from './profile-notifiers.js';
import * as profileStateHistory from './profile-state-history.js';
import * as profileSymbols from './profile-symbols.js';
import * as profilesMod from './profiles.js';
import * as resultLedger from './result-ledger.js';
import * as retentionConfig from './retention-config.js';
import * as symbolStatesMod from './symbol-states.js';
import * as tradeArchive from './trade-archive.js';
import * as users from './users.js';

export {
  accountsMod as accounts,
  actionLogs,
  aiProviderConfig,
  apiKeys,
  appliedFills,
  auditLogs,
  backtestAdvisorResults,
  backtestRuns,
  backupConfig,
  candles,
  conditionStates,
  diagnosisRuns,
  discoveryUniverseSnapshots,
  equitySnapshots,
  avgEntryPrices,
  manualOrders,
  opsNotifyConfig,
  orders,
  overrideActions,
  profileKv,
  profileNotifiers,
  profileStateHistory,
  profileSymbols,
  resultLedger,
  retentionConfig,
  tradeArchive,
  users,
};
export { symbolStatesMod as symbolStates };
export { profilesMod as profiles };
export type { Database } from './_db.js';
export {
  AccountNotOwnedError,
  BaseAssetConflictError,
  ProfileNotOwnedError,
  scopeAccount,
  scopeProfile,
  SiblingQuoteConflictError,
  SymbolOwnershipConflictError,
  toAccountScope,
  withAccountTx,
  withTx,
  type AccountScope,
  type ProfileScope,
} from './_scoped.js';

/**
 * Per-request profile-scoped surface. Each bound method delegates to the
 * matching scoped repo function with the `ProfileScope` already threaded
 * in, so route handlers and the worker stop passing it by hand. Construct
 * one per request via {@link profileRepo}.
 *
 * Ownership is checked exactly once — by `scopeProfile`, when the scope is
 * resolved. The scoped repo functions trust the `ProfileScope` they
 * receive and never re-assert, so a route driving N bound calls performs
 * exactly one ownership query, not N+1.
 */
export interface ProfileRepo {
  readonly scope: ProfileScope;
  readonly profile: ScopeBound<typeof profilesMod>;
  readonly actionLogs: ScopeBound<typeof actionLogs>;
  readonly appliedFills: ScopeBound<typeof appliedFills>;
  readonly auditLogs: ScopeBound<typeof auditLogs>;
  readonly backtestAdvisorResults: ScopeBound<typeof backtestAdvisorResults>;
  readonly backtestRuns: ScopeBound<typeof backtestRuns>;
  readonly conditionStates: ScopeBound<typeof conditionStates>;
  readonly diagnosisRuns: ScopeBound<typeof diagnosisRuns>;
  readonly discoveryUniverseSnapshots: ScopeBound<typeof discoveryUniverseSnapshots>;
  readonly equitySnapshots: ScopeBound<typeof equitySnapshots>;
  readonly avgEntryPrices: ScopeBound<typeof avgEntryPrices>;
  readonly manualOrders: ScopeBound<typeof manualOrders>;
  readonly orders: ScopeBound<typeof orders>;
  readonly overrideActions: ScopeBound<typeof overrideActions>;
  readonly profileKv: ScopeBound<typeof profileKv>;
  readonly profileNotifiers: ScopeBound<typeof profileNotifiers>;
  readonly profileStateHistory: ScopeBound<typeof profileStateHistory>;
  readonly profileSymbols: ScopeBound<typeof profileSymbols>;
  readonly resultLedger: ScopeBound<typeof resultLedger>;
  readonly symbolStates: ScopeBound<typeof symbolStatesMod>;
  readonly tradeArchive: ScopeBound<typeof tradeArchive>;
}

/**
 * Resolves a {@link ProfileScope} (single ownership check) and returns a
 * scoped repository bound to it. Apps MUST use this rather than calling
 * scoped repo functions directly — the typed surface makes "forgot the
 * userId" a type error at every account-scoped boundary.
 *
 * Throws {@link ProfileNotOwnedError} when the profile is not owned by
 * the user.
 */
export async function profileRepo(
  db: Database,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<ProfileRepo> {
  const scope = await scopeProfile(db, operatorId, accountId, profileId);
  return profileRepoFromScope(scope);
}

/**
 * Variant that skips re-resolving ownership when the caller already holds
 * a scope from {@link scopeProfile}. Use in the worker's per-profile
 * binding closure to assemble a `ProfileRepo` once per tick.
 */
export function profileRepoFromScope(scope: ProfileScope): ProfileRepo {
  return {
    scope,
    profile: bindModule(scope, profilesMod, [
      'findById',
      'setEnabled',
      'setDiscoveryConfig',
      'setRiskConfig',
      'update',
      'switchStrategy',
      'commitState',
      'deleteById',
    ]),
    actionLogs: bindModule(scope, actionLogs, [
      'listRecent',
      'listPage',
      'listLoggedSymbols',
      'listForSymbolRange',
      'listForProfileRange',
      'listErrorsForProfile',
      'listConditionEdges',
      'append',
    ]),
    appliedFills: bindModule(scope, appliedFills),
    auditLogs: bindModule(scope, auditLogs, ['listForProfile', 'listAllForProfile']),
    // `only` excludes the GLOBAL `failStaleRunning` (db-first, cross-profile
    // boot sweep) from the bound surface.
    backtestAdvisorResults: bindModule(scope, backtestAdvisorResults, [
      'listForRun',
      'getVariant',
      'transitionToRunning',
      'completeVariant',
      'upsertManual',
    ]),
    // `only` excludes the GLOBAL `failById` / `listNonTerminalOlderThan` (worker
    // recovery + the cross-profile backtest sweep).
    backtestRuns: bindModule(scope, backtestRuns, [
      'create',
      'findDoneBySignature',
      'get',
      'recentDone',
      'list',
      'count',
      'markRunning',
      'updateProgress',
      'complete',
      'markCancelled',
      'deleteById',
      'fail',
    ]),
    conditionStates: bindModule(scope, conditionStates),
    // `only` excludes the GLOBAL `failStaleNonTerminal` (db-first, cross-profile
    // sweep for runs stranded by a dead job).
    diagnosisRuns: bindModule(scope, diagnosisRuns, [
      'create',
      'findById',
      'listForProfile',
      'patchSteps',
      'finish',
      'fail',
      'pruneKeepNewest',
    ]),
    // `only` excludes the GLOBAL `pruneOlderThan` (db-first retention sweep)
    // from the bound surface.
    discoveryUniverseSnapshots: bindModule(scope, discoveryUniverseSnapshots, [
      'record',
      'listForProfile',
    ]),
    // `only` excludes the GLOBAL `pruneOlderThan` retention sweep.
    equitySnapshots: bindModule(scope, equitySnapshots, ['record', 'listForProfileInRange']),
    // `only` excludes the ACCOUNT-ID-scoped `sumDeployedQuoteForAccount`, which
    // spans an account's profiles for the cross-profile exposure cap.
    avgEntryPrices: bindModule(scope, avgEntryPrices, [
      'findBySymbol',
      'findBySymbols',
      'listForProfile',
      'upsert',
      'remove',
    ]),
    manualOrders: bindModule(scope, manualOrders),
    // `only` excludes the GLOBAL `listLiveBinanceOrderIdsByAccount` /
    // `listLiveDetached` (db-first sweeps) and the five ACCOUNT-scoped
    // seek-by-Binance-id functions,
    // which live on AccountRepo because a Binance order id is unique per account
    // and a detached row is reachable only by account.
    orders: bindModule(scope, orders, [
      'listLiveForSymbol',
      'listLiveForSymbols',
      // Bound but unused today: the one consumer (the profile-exposure projection)
      // imports the module function directly because it already holds a scope. It
      // stays on the profile surface because it IS profile-scoped — omitting it
      // would make this list read as "this function is account-scoped or global",
      // which is the exact distinction the list exists to state.
      'listLiveForProfile',
      'listRecordedAmong',
      'listHistoryForSymbol',
      'findLive',
      'listHistory',
      'insert',
      'insertTracking',
      'upsertLive',
      'close',
      'findById',
    ]),
    // `only` excludes the ACCOUNT-LEVEL `reapExpiredForAccount` (one statement
    // for the whole sweep) from the profile surface.
    overrideActions: bindModule(scope, overrideActions, [
      'listPending',
      'listDustTransferHistory',
      'record',
      'claimAction',
      'markPickedUp',
      'finalize',
      'settle',
      'releaseClaim',
      'reapStaleProcessing',
      'findActiveForSymbol',
      'findLatestForSymbol',
      'deletePendingForSymbol',
      'findActiveDustTransfer',
      'deletePendingDustTransfer',
    ]),
    profileKv: bindModule(scope, profileKv),
    // `only` excludes the GLOBAL `listAllEnabled` and the ACCOUNT-ID-scoped
    // `listEnabledForAccount` — both fan ops alerts out beyond one profile.
    profileNotifiers: bindModule(scope, profileNotifiers, [
      'listForProfile',
      'findByProvider',
      'insert',
      'setEnabled',
      'upsertByProvider',
    ]),
    profileStateHistory: bindModule(scope, profileStateHistory),
    profileSymbols: bindModule(scope, profileSymbols, [
      'listForProfile',
      'findForSymbol',
      'upsert',
      'remove',
      'setSource',
      'setReserve',
      'recordFlatten',
      'removeAutoIfFlat',
      'profileManagesBase',
    ]),
    resultLedger: bindModule(scope, resultLedger),
    symbolStates: bindModule(scope, symbolStatesMod),
    tradeArchive: bindModule(scope, tradeArchive),
  };
}

/**
 * Per-request account-scoped surface: account CRUD, api-key management, and
 * profile create/list — the operations that name an account but no profile.
 * Ownership is checked exactly once by `scopeAccount` when the scope is
 * resolved; the bound methods trust it. Construct via {@link accountRepo}.
 */
export interface AccountRepo {
  readonly scope: AccountScope;
  readonly account: AccountScopeBound<typeof accountsMod>;
  readonly apiKeys: AccountScopeBound<typeof apiKeys>;
  readonly orders: AccountScopeBound<typeof orders>;
  readonly overrideActions: AccountScopeBound<typeof overrideActions>;
  readonly profiles: AccountScopeBound<typeof profilesMod>;
}

/**
 * Resolves an {@link AccountScope} (single ownership check) and returns an
 * account-scoped repository bound to it. Apps MUST use this for account-level
 * work rather than calling scoped repo functions directly.
 *
 * Throws {@link AccountNotOwnedError} when the operator does not own the account.
 */
export async function accountRepo(
  db: Database,
  operatorId: UserId,
  accountId: AccountId,
): Promise<AccountRepo> {
  const scope = await scopeAccount(db, operatorId, accountId);
  return accountRepoFromScope(scope);
}

/** Variant that skips re-resolving ownership when the caller already holds a scope. */
export function accountRepoFromScope(scope: AccountScope): AccountRepo {
  return {
    scope,
    // `only` excludes the operator-scoped `create` / `listForOwner`
    // (Database-first) from the bound surface.
    account: bindAccountModule(scope, accountsMod, ['get', 'update', 'deleteById']),
    // `only` excludes the ACCOUNT-ID-scoped `findByAccountId` (worker path, no
    // scope in hand) and the OPERATOR-scoped `accountIdsWithKeyForOwner`.
    apiKeys: bindAccountModule(scope, apiKeys, [
      'findForAccount',
      'upsert',
      'setVerification',
      'removeForAccount',
    ]),
    // Order reconciliation is account-domain: a Binance order id is unique per
    // account, the user-data stream is per account, and a DETACHED order
    // (profile_id NULL) is reachable only by account. `only` binds those five;
    // every other orders function is profile-scoped and lives on ProfileRepo.
    orders: bindAccountModule(scope, orders, [
      'findByBinanceOrderId',
      'closeByBinanceOrderId',
      'markFilledByBinanceOrderId',
      'stampRealizedPnl',
      'reapWithReason',
    ]),
    // `only` binds just the account-tier sweep; every other override-action
    // function is profile-scoped and lives on ProfileRepo.
    overrideActions: bindAccountModule(scope, overrideActions, ['reapExpiredForAccount']),
    // `only` binds just the account-scoped profile functions; the profile-scoped
    // and global ones live on ProfileRepo / the flat namespace.
    profiles: bindAccountModule(scope, profilesMod, ['listForAccount', 'insert']),
  };
}
