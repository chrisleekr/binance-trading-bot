import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Database } from './_db.js';
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
 * Strips the leading `scope: ProfileScope` from a scoped repo function so
 * a bound method reads `p.orders.insert(row)` instead of
 * `orders.insert(scope, row)`.
 */
type Bound<F> = F extends (scope: ProfileScope, ...rest: infer R) => infer Ret
  ? (...args: R) => Ret
  : never;

/**
 * Selects the account-scoped functions of a module — those whose first
 * parameter is a {@link ProfileScope} — and binds each to a `scope`. A
 * module's user-scoped / global functions (first parameter `Database`)
 * are excluded from the public surface.
 */
type ScopeBound<M> = {
  [
    K in keyof M as M[K] extends (scope: ProfileScope, ...rest: never[]) => unknown ? K : never
  ]: Bound<M[K]>;
};

/**
 * Binds a repo module's account-scoped functions to `scope`.
 *
 * For a pure module — every function account-scoped — call with two args.
 * For a mixed module (one that also exports user-scoped / global
 * functions, e.g. `profiles`, `auditLogs`, `actionLogs`), pass `only` with
 * the account-scoped function names so the user-scoped / global ones stay
 * off the runtime surface, keeping it identical to the `ScopeBound<M>`
 * type. A function key in `only` that does not exist would not typecheck.
 */
const bindModule = <M extends Record<string, unknown>>(
  scope: ProfileScope,
  mod: M,
  only?: readonly (keyof M & string)[],
): ScopeBound<M> => {
  const out: Record<string, unknown> = {};
  const names = only ?? Object.keys(mod);
  for (const name of names) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(scope, ...args);
  }
  return out as ScopeBound<M>;
};

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
      'listForSymbolRange',
      'listForProfileRange',
      'listErrorsForProfile',
      'append',
    ]),
    appliedFills: bindModule(scope, appliedFills),
    auditLogs: bindModule(scope, auditLogs, ['listForProfile', 'listAllForProfile']),
    // `only` excludes the GLOBAL `failStaleRunning` (db-first, cross-profile
    // boot sweep) from the bound surface, keeping it identical to ScopeBound<M>.
    backtestAdvisorResults: bindModule(scope, backtestAdvisorResults, [
      'listForRun',
      'getVariant',
      'transitionToRunning',
      'completeVariant',
      'upsertManual',
    ]),
    backtestRuns: bindModule(scope, backtestRuns),
    // `only` excludes the GLOBAL `pruneOlderThan` (db-first retention sweep)
    // from the bound surface, keeping the runtime object identical to ScopeBound<M>.
    discoveryUniverseSnapshots: bindModule(scope, discoveryUniverseSnapshots, [
      'record',
      'listForProfile',
    ]),
    // `only` excludes the GLOBAL `pruneOlderThan` retention sweep.
    equitySnapshots: bindModule(scope, equitySnapshots, ['record', 'listForProfileInRange']),
    avgEntryPrices: bindModule(scope, avgEntryPrices),
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
    // for the whole sweep) from the profile surface, keeping the runtime object
    // identical to ScopeBound<M>.
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
    ]),
    profileKv: bindModule(scope, profileKv),
    profileNotifiers: bindModule(scope, profileNotifiers),
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
    ]),
    // Pure module (every fn is scope-first) → two-arg bind, no `only`, like
    // backtestRuns. A method missing from the bound surface despite typechecking
    // is the storeProgress class of bug, so keep this in lockstep with the module.
    resultLedger: bindModule(scope, resultLedger),
    symbolStates: bindModule(scope, symbolStatesMod),
    tradeArchive: bindModule(scope, tradeArchive),
  };
}

/** {@link Bound} for the account tier: strips a leading `scope: AccountScope`. */
type AccountBound<F> = F extends (scope: AccountScope, ...rest: infer R) => infer Ret
  ? (...args: R) => Ret
  : never;

/**
 * Selects a module's account-scoped functions — those whose first parameter is
 * an {@link AccountScope} — and binds each to a `scope`. A module's
 * operator-scoped / global functions (first parameter `Database`, e.g.
 * `accounts.create` / `accounts.listForOwner`, `profiles.insert`) are excluded.
 */
type AccountScopeBound<M> = {
  [
    K in keyof M as M[K] extends (scope: AccountScope, ...rest: never[]) => unknown ? K : never
  ]: AccountBound<M[K]>;
};

/** {@link bindModule} for the account tier. */
const bindAccountModule = <M extends Record<string, unknown>>(
  scope: AccountScope,
  mod: M,
  only?: readonly (keyof M & string)[],
): AccountScopeBound<M> => {
  const out: Record<string, unknown> = {};
  const names = only ?? Object.keys(mod);
  for (const name of names) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(scope, ...args);
  }
  return out as AccountScopeBound<M>;
};

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
    // `only` excludes the operator-scoped `create` / `listForOwner` (Database-
    // first) from the bound surface, keeping it identical to AccountScopeBound<M>.
    account: bindAccountModule(scope, accountsMod, ['get', 'update', 'deleteById']),
    apiKeys: bindAccountModule(scope, apiKeys),
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
