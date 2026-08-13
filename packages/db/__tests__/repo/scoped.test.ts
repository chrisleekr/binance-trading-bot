import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/repo/_db.js';
import type { AccountScope, ProfileScope } from '../../src/repo/_scoped.js';
import {
  accountRepoFromScope,
  ProfileNotOwnedError,
  profileRepo,
  profileRepoFromScope,
  scopeProfile,
} from '../../src/repo/index.js';
import { createRepoAstReader } from './_exported-fns.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const repoAst = createRepoAstReader();

afterAll(() => {
  repoAst.close();
});

// Non-DB unit tests for the binding shape. The runtime objects built by
// `profileRepoFromScope` / `accountRepoFromScope` must carry exactly the
// module's scope-first exports for their tier — no fewer (a name the `only`
// list forgets is `undefined` at call time while still typechecking, which is
// the `storeProgress` class of bug) and no more (a two-arg bind over
// a module that also exports db-first globals binds those with the scope landing
// in the `db` parameter slot).
//
// The expectations are DERIVED from the module sources, never spelled out here:
// a hardcoded name list is the `only` list a second time, so it would agree with
// the bug rather than catch it.

// Namespace on the bound surface → the repo module it is bound from. A namespace
// with no entry fails the mapping test rather than being skipped, because a
// silently unmapped namespace is exactly the unchecked surface this guards.
const PROFILE_NAMESPACE_MODULES: Readonly<Record<string, string>> = {
  profile: 'profiles.ts',
  actionLogs: 'action-logs.ts',
  appliedFills: 'applied-fills.ts',
  auditLogs: 'audit-logs.ts',
  backtestAdvisorResults: 'backtest-advisor-results.ts',
  backtestRuns: 'backtest-runs.ts',
  conditionStates: 'condition-states.ts',
  discoveryUniverseSnapshots: 'discovery-universe-snapshots.ts',
  equitySnapshots: 'equity-snapshots.ts',
  avgEntryPrices: 'avg-entry-prices.ts',
  manualOrders: 'manual-orders.ts',
  orders: 'orders.ts',
  overrideActions: 'override-actions.ts',
  profileKv: 'profile-kv.ts',
  profileNotifiers: 'profile-notifiers.ts',
  profileStateHistory: 'profile-state-history.ts',
  profileSymbols: 'profile-symbols.ts',
  resultLedger: 'result-ledger.ts',
  symbolStates: 'symbol-states.ts',
  tradeArchive: 'trade-archive.ts',
};

const ACCOUNT_NAMESPACE_MODULES: Readonly<Record<string, string>> = {
  account: 'accounts.ts',
  apiKeys: 'api-keys.ts',
  orders: 'orders.ts',
  overrideActions: 'override-actions.ts',
  profiles: 'profiles.ts',
};

const profileStub = {
  db: { __stub: 'db' } as unknown as Database,
  operatorId: asUserId('00000000-0000-0000-0000-0000000a0001'),
  accountId: asAccountId('00000000-0000-0000-0000-0000000ac001'),
  profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
} as unknown as ProfileScope;

const accountStub = {
  db: { __stub: 'db' } as unknown as Database,
  operatorId: asUserId('00000000-0000-0000-0000-0000000a0001'),
  accountId: asAccountId('00000000-0000-0000-0000-0000000ac001'),
} as unknown as AccountScope;

/** The bound namespaces, minus the `scope` field the surfaces also carry. */
const boundNamespaces = (surface: Record<string, unknown>): [string, string[]][] =>
  Object.entries(surface)
    .filter(([name]) => name !== 'scope')
    .map(([name, ns]) => [name, Object.keys(ns as object).sort()]);

describe('profileRepoFromScope (binding shape)', () => {
  const surface = profileRepoFromScope(profileStub) as unknown as Record<string, unknown>;

  it('maps every bound namespace to a repo module', () => {
    const unmapped = boundNamespaces(surface)
      .map(([name]) => name)
      .filter((name) => !(name in PROFILE_NAMESPACE_MODULES));
    expect(unmapped, 'add these to PROFILE_NAMESPACE_MODULES so they are checked').toEqual([]);
    // Vacuity guard: an empty walk would make every derived check below pass.
    expect(boundNamespaces(surface).length).toBe(Object.keys(PROFILE_NAMESPACE_MODULES).length);
  });

  for (const [namespace, moduleFile] of Object.entries(PROFILE_NAMESPACE_MODULES)) {
    it(`${namespace} binds exactly ${moduleFile}'s ProfileScope-first exports`, () => {
      const bound = Object.keys((surface[namespace] ?? {}) as object).sort();
      expect(bound).toEqual(repoAst.scopeFirstExportNames(moduleFile, 'ProfileScope'));
    });
  }

  it('exposes the same scope object that was passed in', () => {
    expect(profileRepoFromScope(profileStub).scope).toBe(profileStub);
  });
});

describe('accountRepoFromScope (binding shape)', () => {
  const surface = accountRepoFromScope(accountStub) as unknown as Record<string, unknown>;

  it('maps every bound namespace to a repo module', () => {
    const unmapped = boundNamespaces(surface)
      .map(([name]) => name)
      .filter((name) => !(name in ACCOUNT_NAMESPACE_MODULES));
    expect(unmapped, 'add these to ACCOUNT_NAMESPACE_MODULES so they are checked').toEqual([]);
    expect(boundNamespaces(surface).length).toBe(Object.keys(ACCOUNT_NAMESPACE_MODULES).length);
  });

  for (const [namespace, moduleFile] of Object.entries(ACCOUNT_NAMESPACE_MODULES)) {
    it(`${namespace} binds exactly ${moduleFile}'s AccountScope-first exports`, () => {
      const bound = Object.keys((surface[namespace] ?? {}) as object).sort();
      expect(bound).toEqual(repoAst.scopeFirstExportNames(moduleFile, 'AccountScope'));
    });
  }

  it('exposes the same scope object that was passed in', () => {
    expect(accountRepoFromScope(accountStub).scope).toBe(accountStub);
  });
});

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('scopeProfile + profileRepo', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('scopeProfile returns the scope for a valid owner', async () => {
    const scope = await scopeProfile(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    expect(scope.db).toBe(fx.db);
    expect(scope.operatorId).toBe(fx.alice.userId);
    expect(scope.accountId).toBe(fx.alice.accountId);
    expect(scope.profileId).toBe(fx.alice.profileId);
  });

  it('scopeProfile sets the runtime brand symbol on the returned scope', async () => {
    // Regression: the brand was originally `declare const profileScopeBrand`
    // which is type-only — `[profileScopeBrand]: true` at runtime threw a
    // ReferenceError and every account-scoped route 500'd. The brand must
    // exist as a real Symbol at runtime so the property assignment lands.
    const scope = await scopeProfile(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    const symbols = Object.getOwnPropertySymbols(scope);
    expect(symbols).toHaveLength(1);
    const [brandKey] = symbols;
    expect(brandKey).toBeDefined();
    expect((scope as Record<symbol, unknown>)[brandKey as symbol]).toBe(true);
  });

  it('scopeProfile throws ProfileNotOwnedError when the operator does not own the profile', async () => {
    await expect(
      scopeProfile(fx.db, fx.alice.userId, fx.alice.accountId, fx.bob.profileId),
    ).rejects.toBeInstanceOf(ProfileNotOwnedError);
  });

  it('profileRepo throws ProfileNotOwnedError for a cross-account scope', async () => {
    await expect(
      profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.bob.profileId),
    ).rejects.toBeInstanceOf(ProfileNotOwnedError);
  });

  it('profileRepo exposes bound domain methods that close over scope', async () => {
    const p = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    expect(p.scope.profileId).toBe(fx.alice.profileId);
    // Round-trip a domain call to confirm the binding shape — listForProfile
    // returns an array (possibly empty) instead of throwing.
    const rows = await p.profileSymbols.listForProfile();
    expect(Array.isArray(rows)).toBe(true);
  });
});
