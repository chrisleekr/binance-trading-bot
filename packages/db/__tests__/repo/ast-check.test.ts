import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Filesystem-walking guard test: generous headroom so CI coverage +
// parallel-suite contention on the fs walk cannot trip the test-level timeout.
vi.setConfig({ testTimeout: 30_000 });

// Static check on every `.ts` file under `packages/db/src/repo/` (including
// the `projections/` subtree): every exported function (declaration or arrow
// / function-expression const) is classified into one of these shapes and its
// parameter list is verified against the AST. This is the compile-time-adjacent
// guard that keeps the account-isolation boundary total:
//
//   - PROFILE_SCOPED (default): first parameter is `scope: ProfileScope`.
//     A `ProfileScope` can only be produced by `scopeProfile`, which runs the
//     single operator→account→profile ownership check — so a function in this
//     shape cannot be reached without ownership having been proven.
//   - ACCOUNT_LEVEL: first parameter is `scope: AccountScope` (account-tier ops
//     that name an account but no profile: account CRUD, api-key management,
//     profile create/list). `AccountScope` is produced only by `scopeAccount`.
//   - ACCOUNT_ID_SCOPED: `(db: Database, accountId: AccountId, ...)`. A
//     cross-profile read that joins `profiles` to bound a SUM / existence check
//     to one account; it spans profiles so it takes a raw accountId, not a
//     single-profile scope.
//   - OPERATOR_SCOPED: `(db: Database, <userId|operatorId>: UserId, ...)`. The
//     table carries the operator directly (audit_logs, users) or the op is
//     operator-owned account creation.
//   - GLOBAL: first parameter `db: Database`, no operator/account (cross-tenant
//     sweeps, global market data, pre-auth lookups).
//
// A new account-scoped query that forgets `scope` fails this test. A new
// non-profile-scoped function must be registered in the sets below, which forces
// a reviewer to look at why it sidesteps the profile scope. Keys are the file's
// path relative to the repo dir (POSIX separators), e.g. `profiles.ts` or
// `projections/profile-aggregate.ts`.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HERE, '..', '..', 'src', 'repo');

// Modules with no scoped query functions: the connection-type module, the
// scope primitive itself (`scopeAccount`/`scopeProfile` are the scope
// *constructors*, so they take the raw ids by definition), and the barrels.
const META_MODULES = new Set(['_db.ts', '_scoped.ts', 'index.ts', 'projections/index.ts']);

// Whole modules backed by tables with no account_id / profile_id column.
const GLOBAL_REPO_MODULES = new Set(['candles.ts']);

// Account-level functions: first parameter `scope: AccountScope`. They name an
// account but no profile — account CRUD, per-account api keys, profile
// create/list, and the per-account dashboard aggregate.
const ACCOUNT_LEVEL_FUNCTIONS = new Set([
  'accounts.ts:get',
  'accounts.ts:update',
  'accounts.ts:deleteById',
  'api-keys.ts:findForAccount',
  'api-keys.ts:upsert',
  'api-keys.ts:setVerification',
  'api-keys.ts:removeForAccount',
  'override-actions.ts:reapExpiredForAccount',
  'profiles.ts:listForAccount',
  'profiles.ts:insert',
  'projections/profile-aggregate.ts:getAggregateForAccount',
  // Account-wide order/position rollup keyed by profile id: two set-based queries
  // joined to `profiles` to bound to one account, replacing the per-profile
  // fan-out. Names the account, not a single profile.
  'projections/profile-aggregate.ts:rollupAllProfilesForAccount',
  // Delete-account guard: counts live orders + held positions across EVERY
  // profile of one account. It spans profiles by design (that is the exposure
  // the cascade would erase), so it names the account, not a single profile.
  'projections/account-exposure.ts:countAccountOpenExposure',
  // Seek-by-Binance-id: an order id is unique per ACCOUNT (not per profile), the
  // user-data stream that drives these is per account, and a DETACHED order
  // (profile_id NULL, left by a deleted profile) is reachable only by account.
  'orders.ts:findByBinanceOrderId',
  'orders.ts:closeByBinanceOrderId',
  'orders.ts:markFilledByBinanceOrderId',
  'orders.ts:stampRealizedPnl',
  'orders.ts:reapWithReason',
]);

// Account-id-scoped functions: `(db, accountId: AccountId, ...)`. Cross-profile
// reads that join `profiles` to bound a result to one account, so they span
// profiles and take a raw accountId rather than a single-profile scope.
const ACCOUNT_ID_SCOPED_FUNCTIONS = new Set([
  // Account-wide deployed-quote sum for the cross-profile exposure cap — joins
  // to `profiles` to bound the SUM to one account.
  'avg-entry-prices.ts:sumDeployedQuoteForAccount',
  // Symbol-exclusivity guard: joins to `profiles` to find a sibling profile
  // under the same account already managing a base asset.
  'profile-symbols.ts:findOwningSiblingByBase',
  // Symmetric exclusivity guard: scans `profiles` for a sibling under the same
  // account whose settlement (quote) asset is the candidate base asset.
  'profile-symbols.ts:findSiblingQuotingBase',
  // Reads one account's environment; accountId arrives from an already-proven scope.
  'accounts.ts:binanceModeById',
  // Reads one account's key row; accountId arrives from an already-proven scope.
  'api-keys.ts:findByAccountId',
  // Account-level ops alerts fan out to the notifiers of the ONE account the
  // event concerns; joins to `profiles` to span that account's profiles.
  'profile-notifiers.ts:listEnabledForAccount',
]);

// Operator-scoped functions: `(db, <userId|operatorId>: UserId, ...)`. The table
// carries the operator directly (audit_logs, users) or the op creates/lists the
// operator's own accounts. No profile to scope to.
const OPERATOR_SCOPED_FUNCTIONS = new Set([
  'audit-logs.ts:append',
  'audit-logs.ts:pruneOlderThan',
  'accounts.ts:create',
  'accounts.ts:listForOwner',
  'api-keys.ts:accountIdsWithKeyForOwner',
  'users.ts:findById',
  'users.ts:insert',
  'users.ts:update',
]);

// Global functions: `(db, ...)` with no operator/account. Each intentionally
// spans every tenant (retention sweeps, worker-boot rehydration) or runs
// pre-auth (operator recovery), so an owner parameter would be wrong or
// circular.
const GLOBAL_FUNCTIONS = new Set([
  // Global singleton: backup is a whole-database dump, not account-scoped, so
  // the config repo is db-first with no owner / ProfileScope.
  'backup-config.ts:get',
  'backup-config.ts:upsert',
  'backup-config.ts:touchLastBackup',
  // Global singleton: AI-assist provider settings are system-wide, not
  // account-scoped, so the config repo is db-first (mirrors backup-config).
  'ai-provider-config.ts:get',
  'ai-provider-config.ts:upsert',
  // Global singleton: account-level ops notification toggles, not account-scoped.
  'ops-notify-config.ts:get',
  'ops-notify-config.ts:setEvents',
  // Account-level ops alerts fan out to the union of every configured notifier;
  // they have no owning profile, so this read is cross-tenant by design.
  'profile-notifiers.ts:listAllEnabled',
  // Worker `action-log-prune` cron — cross-tenant retention sweep.
  'action-logs.ts:pruneOlderThan',
  // Worker audit drainer — bulk append already-attributed rows across profiles
  // (each row carries its own profileId from the audit stream).
  'action-logs.ts:insertMany',
  // Worker `audit-prune` cron — cross-tenant retention sweep.
  'audit-logs.ts:pruneAllOlderThan',
  // Worker `discovery-snapshot-prune` cron — cross-tenant retention sweep.
  'discovery-universe-snapshots.ts:pruneOlderThan',
  // Worker `equity-snapshot-prune` cron — cross-tenant retention sweep.
  'equity-snapshots.ts:pruneOlderThan',
  // Worker-boot crash-only rehydration loads every enabled profile.
  'profiles.ts:listAllEnabled',
  // onboarding-status reads "does any user exist"; an owner would be circular.
  'users.ts:count',
  // LIVE_DEMO resolves the sole operator id to inject; the id is the *result*,
  // so an owner parameter would be circular. There is one users row forever.
  'users.ts:findSingleId',
  // LIVE_DEMO boot guard: "is any account on the live environment" across the
  // whole deployment; a deployment-wide check has no owner to scope to.
  'accounts.ts:anyLiveMode',
  // reset-password CLI looks up the auth user by email pre-auth; the id is the
  // *result* of this lookup, so requiring it as input would be circular.
  'users.ts:findByEmail',
  // Cross-profile boot sweep reclaiming advisor rows left `running` by a lost or
  // dead background job; db-first like the retention sweeps.
  'backtest-advisor-results.ts:failStaleRunning',
  // Worker recovery: mark one backtest run errored by id when the failure
  // happened before the run was scoped (the ownership lookup threw); the runId
  // is off an already-enqueued job, so there is no scope to prove.
  'backtest-runs.ts:failById',
  // Cross-profile read feeding the periodic backtest-sweep cron, which
  // reconciles each non-terminal run against its BullMQ job and reclaims the
  // abandoned ones; spans every tenant, so db-first with no owner.
  'backtest-runs.ts:listNonTerminalOlderThan',
  // Orphan-detection cron + adopt route diff each Binance account's open orders
  // against the live rows tracked for THAT account; symbol-agnostic, spans every
  // account, so db-first with no scope.
  'orders.ts:listLiveBinanceOrderIdsByAccount',
  // Detached-order reconcile cron. A detached row's account may have NO profiles
  // left (deleting the last one is what detached it), so no scope exists to prove
  // and no active-profile sweep can reach it; the query itself carries the
  // owner/account the reconcile then scopes to.
  'orders.ts:listLiveDetached',
]);

// Functions exempt from the scope contract entirely — pure, DB-free
// helpers that take neither a `Database` nor a scope.
const EXEMPT_FUNCTIONS = new Set([
  // `JSON.parse` wrapper for Redis blobs — takes a raw string, no DB.
  'projections/_json.ts:tryParseJson',
  // Pure row → DTO mapper; takes an in-memory `OrderRow`, no DB / scope.
  'projections/orders-view.ts:orderToResponse',
  // Pure readers of the opaque strategy-state blob; take `state`, no DB / scope.
  'projections/orders-view.ts:readEntryBlocker',
  'projections/orders-view.ts:readProtectiveStopBlocker',
  // Write-side cache buster: takes a raw redis del-port + `accountId` (and an
  // optional profileId), no Database / scope. It only deletes cache keys derived
  // from `accountId`; ownership is already proven by the write it follows, so it
  // needs neither a DB handle nor a scope.
  'projections/profile-aggregate.ts:invalidateDashboardCaches',
  // Pure string builder for the reserved recovery-row intent; takes an intent and
  // a Binance order id, no DB / scope.
  'orders.ts:untrackedIntent',
]);

interface ExportedFn {
  key: string;
  name: string;
  paramNames: string[];
  paramTypes: string[];
}

// Collects every exported function in a repo module — both
// `export [async] function name(...)` declarations and
// `export const name = [async] (...) => ...` arrow / function-expression
// consts. Covering both shapes keeps the scope contract un-bypassable: a
// future query written as an exported arrow cannot slip past the check.
const collectExportedFns = (absPath: string, relKey: string): ExportedFn[] => {
  const src = ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const out: ExportedFn[] = [];
  const push = (name: string, params: ts.NodeArray<ts.ParameterDeclaration>): void => {
    out.push({
      key: relKey,
      name,
      paramNames: params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '<destructured>')),
      paramTypes: params.map((p) => (p.type ? p.type.getText(src) : '<no-type>')),
    });
  };

  src.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node)) {
      const isExported = (ts.getModifiers(node) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (isExported && node.name) push(node.name.text, node.parameters);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const isExported = (ts.getModifiers(node) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) return;
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          push(decl.name.text, init.parameters);
        }
      }
    }
  });
  return out;
};

// Every `.ts` file under REPO_DIR, recursively, keyed by its POSIX-relative
// path. Recursion is mandatory: `repo/projections/*.ts` carries scoped
// functions too, and a non-recursive scan would leave them un-guarded.
const collectRepoFiles = (dir: string, prefix = ''): { relKey: string; absPath: string }[] => {
  const out: { relKey: string; absPath: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectRepoFiles(join(dir, entry.name), relKey));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ relKey, absPath: join(dir, entry.name) });
    }
  }
  return out;
};

describe('repo layer scope-parameter enforcement', () => {
  const files = collectRepoFiles(REPO_DIR).filter((f) => !META_MODULES.has(f.relKey));

  it('finds the repo modules, including the projections subtree', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.relKey.startsWith('projections/'))).toBe(true);
  });

  for (const { relKey, absPath } of files) {
    const isGlobalModule = GLOBAL_REPO_MODULES.has(relKey);

    it(`${relKey}: exported functions follow the scope contract`, () => {
      // A file may legitimately export zero functions (e.g. a port that is
      // only a TypeScript interface); the suite-level check above guards
      // against the walk silently collecting nothing.
      for (const fn of collectExportedFns(absPath, relKey)) {
        const key = `${relKey}:${fn.name}`;
        if (EXEMPT_FUNCTIONS.has(key)) continue;

        const takesAnyScope = fn.paramTypes.some(
          (t) => t.includes('ProfileScope') || t.includes('AccountScope'),
        );

        if (isGlobalModule || GLOBAL_FUNCTIONS.has(key)) {
          expect(fn.paramNames[0], `${key}: global fn must take db as the first parameter`).toBe(
            'db',
          );
          expect(fn.paramTypes[0], `${key}: db parameter must be typed Database`).toBe('Database');
          expect(takesAnyScope, `${key}: global fn must not take a scope`).toBe(false);
          continue;
        }

        if (OPERATOR_SCOPED_FUNCTIONS.has(key)) {
          expect(fn.paramNames[0], `${key}: operator-scoped fn must take db first`).toBe('db');
          expect(fn.paramTypes[0], `${key}: db parameter must be typed Database`).toBe('Database');
          expect(
            fn.paramNames[1] === 'operatorId' || fn.paramNames[1] === 'userId',
            `${key}: operator-scoped fn must take operatorId/userId second`,
          ).toBe(true);
          expect(fn.paramTypes[1], `${key}: operator parameter must be typed UserId`).toBe(
            'UserId',
          );
          expect(takesAnyScope, `${key}: operator-scoped fn must not take a scope`).toBe(false);
          continue;
        }

        if (ACCOUNT_ID_SCOPED_FUNCTIONS.has(key)) {
          expect(fn.paramNames[0], `${key}: account-id-scoped fn must take db first`).toBe('db');
          expect(fn.paramTypes[0], `${key}: db parameter must be typed Database`).toBe('Database');
          expect(fn.paramNames[1], `${key}: account-id-scoped fn must take accountId second`).toBe(
            'accountId',
          );
          expect(fn.paramTypes[1], `${key}: accountId parameter must be typed AccountId`).toBe(
            'AccountId',
          );
          expect(takesAnyScope, `${key}: account-id-scoped fn must not take a scope`).toBe(false);
          continue;
        }

        if (ACCOUNT_LEVEL_FUNCTIONS.has(key)) {
          expect(
            fn.paramNames[0],
            `${key}: account-level fn must take scope as the first parameter`,
          ).toBe('scope');
          expect(fn.paramTypes[0], `${key}: scope parameter must be typed AccountScope`).toBe(
            'AccountScope',
          );
          continue;
        }

        // Default: profile-scoped. The single non-negotiable rule — the first
        // parameter is a ProfileScope, so ownership is already proven.
        expect(
          fn.paramNames[0],
          `${key}: profile-scoped fn must take scope as the first parameter ` +
            `(or be registered in ACCOUNT_LEVEL / ACCOUNT_ID_SCOPED / OPERATOR_SCOPED / ` +
            `GLOBAL / EXEMPT function sets)`,
        ).toBe('scope');
        expect(fn.paramTypes[0], `${key}: scope parameter must be typed ProfileScope`).toBe(
          'ProfileScope',
        );
      }
    });
  }
});
