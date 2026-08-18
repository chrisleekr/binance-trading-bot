import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { collectRepoFiles, createRepoAstReader, REPO_DIR } from './_exported-fns.js';

const repoAst = createRepoAstReader();

afterAll(() => {
  repoAst.close();
});

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

// Modules with no scoped query functions: the connection-type module, the
// scope primitive itself (`scopeAccount`/`scopeProfile` are the scope
// *constructors*, so they take the raw ids by definition), the binder (generic
// over any module, so it takes a scope but issues no query), and the barrels.
const META_MODULES = new Set([
  '_bind.ts',
  '_db.ts',
  '_scoped.ts',
  'index.ts',
  'projections/index.ts',
]);

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
  // Realised P/L for EVERY profile of one account in one grouped read, replacing
  // a per-profile fan-out whose connection burst grew with the profile count.
  // Left-joined from `profiles` so a profile that closed nothing still reports a
  // zero, which is why it names the account rather than a single profile.
  'projections/profile-aggregate.ts:rollupRealizedByProfileForAccount',
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
  // Global singleton: log retention horizons apply to every account's rows in one
  // cross-tenant sweep, so scoping the config to an account would let one
  // account's setting silently govern another's data.
  'retention-config.ts:get',
  'retention-config.ts:update',
  // Account-level ops alerts fan out to the union of every configured notifier;
  // they have no owning profile, so this read is cross-tenant by design.
  'profile-notifiers.ts:listAllEnabled',
  // Worker `action-log-prune` cron — cross-tenant retention sweep.
  'action-logs.ts:pruneOlderThan',
  // Same cron's second rule. The cap is applied per profile, but the sweep
  // itself spans every tenant and runs with no caller to prove ownership; the
  // profile id is an iteration cursor over the deployment, not a scope.
  'action-logs.ts:pruneBeyondRowCap',
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
  // The action-log cron's row cap walks every profile in the deployment,
  // disabled ones included: their old rows still count against growth.
  'profiles.ts:listAllIds',
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
  // Same shape for diagnosis runs: the sweep reclaims non-terminal rows across
  // every profile, so it has no scope to prove.
  'diagnosis-runs.ts:failStaleNonTerminal',
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
  'projections/orders-view.ts:readExitBlocker',
  'projections/orders-view.ts:readProtectiveStopBlocker',
  // Write-side cache buster: takes a raw redis del-port + `accountId` (and an
  // optional profileId), no Database / scope. It only deletes cache keys derived
  // from `accountId`; ownership is already proven by the write it follows, so it
  // needs neither a DB handle nor a scope.
  'projections/profile-aggregate.ts:invalidateDashboardCaches',
  // Pure string builder for the reserved recovery-row intent; takes an intent and
  // a Binance order id, no DB / scope.
  'orders.ts:untrackedIntent',
  // Pure snapshot-row → diagnosis-input mapper; takes already-read rows, no
  // DB / scope. The read that produced them is scoped by its own caller.
  'projections/diagnosis-view.ts:toDiagnosisSnapshots',
]);

describe('repo layer scope-parameter enforcement', () => {
  const files = collectRepoFiles().filter((f) => !META_MODULES.has(f.relKey));

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
      for (const fn of repoAst.collectExportedFns(absPath)) {
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

/**
 * A scope is minted by `scopeAccount` / `scopeProfile` and rebound by `withTx` / `withAccountTx`, and those are the only four constructions allowed to produce one.
 *
 * A spread is the exception that has to be refused by name. `{ ...scope, db: tx }` carries the ownership brand forward — the brand is an ordinary property, so a spread copies it — while the same object literal is free to overwrite `accountId` or `profileId` beside it. The result type-checks as a proven scope while naming an account nobody proved, which is precisely the guarantee CLAUDE.md states as "ownership proven exactly once at compile time". `withTx` swaps the handle and nothing else, so there is no case a spread is needed for.
 *
 * Matched only inside an object literal, so an array spread of an unrelated binding that happens to be called `scope` is not a hit, and matched over the whole file rather than line by line so a multi-line literal cannot hide one. The literal may carry one level of nesting before the spread (`{ meta: { x: 1 }, ...scope }`), which a brace-free run would have stopped at — deeper nesting is not reachable without a parser, and the shape that matters is a scope handed to a repo call, which is written flat.
 *
 * Scanned textually and repo-wide rather than through the AST reader above, which is bound to this package's TypeScript project: the two spreads this gate was written for lived in `apps/api`, so a check that could only see `packages/db/src/repo` would have passed while the defect was in the tree.
 */
const SCOPE_SPREAD = /\{(?:[^{}]|\{[^{}]*\})*\.\.\.[A-Za-z0-9_$.]*[Ss]cope\b/g;

/** Every `.ts`/`.tsx` file under a `src/` tree, which is where the invariant binds. A test may legitimately build a malformed scope to prove a repo function refuses it. */
const collectSourceFiles = (dir: string, inSrc: boolean): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full, inSrc || entry.name === 'src'));
    } else if (inSrc && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
};

describe('scope construction', () => {
  const WORKSPACE_ROOT = resolve(REPO_DIR, '..', '..', '..', '..');

  it('detects a spread of a scope, so the sweep below cannot pass vacuously', () => {
    // The sweep asserts an ABSENCE, which is also what a detector that can never match returns.
    const hits = (source: string): boolean => new RegExp(SCOPE_SPREAD.source).test(source);
    expect(hits('const s = { ...scope, db: tx };')).toBe(true);
    expect(hits('const s = { ...p.scope, db: tx };')).toBe(true);
    expect(hits('const s = {\n  ...a.scope,\n  db: tx,\n};')).toBe(true);
    expect(hits('const s = { meta: { x: 1 }, ...p.scope };')).toBe(true);
    expect(hits('const s = withTx(p.scope, tx);')).toBe(false);
    // An array spread of an unrelated binding, and a plural that is not a scope.
    expect(hits('const bars = [...scope.querySelectorAll(sel)];')).toBe(false);
    expect(hits('const all = { ...scopes };')).toBe(false);
  });

  const sourceFiles = ['apps', 'packages'].flatMap((dirName) =>
    collectSourceFiles(join(WORKSPACE_ROOT, dirName), false),
  );

  it('reaches the app source trees, so the sweep below is not walking an empty list', () => {
    // The sweep asserts an ABSENCE, and an empty file list produces the same result as a clean tree. `readdirSync` only throws if `apps` or `packages` vanish entirely, which is not the realistic failure — a layout where sources stop living under a directory literally named `src` would silently retire the gate instead. `apps/api/src` is named specifically because both spreads this gate was written for lived there, and it is exactly the tree this package's AST reader cannot see.
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(sourceFiles.some((f) => f.includes(join('apps', 'api', 'src')))).toBe(true);
  });

  it('no source file rebuilds a scope by spreading one', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(SCOPE_SPREAD)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.slice(WORKSPACE_ROOT.length + 1)}:${line}`);
      }
    }
    expect(offenders, 'rebind a scope with withTx / withAccountTx instead of spreading it').toEqual(
      [],
    );
  });
});
