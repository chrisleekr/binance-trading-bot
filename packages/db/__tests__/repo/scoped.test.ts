import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/repo/_db.js';
import {
  ProfileNotOwnedError,
  profileRepo,
  profileRepoFromScope,
  scopeProfile,
} from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

// Non-DB unit tests for the binding shape. The runtime object built by
// `profileRepoFromScope` must match the public `ProfileRepo` type exactly
// so untyped / reflective callers can't reach user-scoped functions on a
// profile-scoped surface (e.g. `auditLogs.append` was a real footgun that
// finding #1 caught — append has `Function.length === 3`, so a naive
// length-based filter would bind it with the profileId in the input slot).
describe('profileRepoFromScope (binding shape)', () => {
  const stub: { scope: Parameters<typeof profileRepoFromScope>[0] } = {
    scope: {
      db: { __stub: 'db' } as unknown as Database,
      operatorId: asUserId('00000000-0000-0000-0000-0000000a0001'),
      accountId: asAccountId('00000000-0000-0000-0000-0000000ac001'),
      profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
    },
  };

  it('exposes exactly the profile-scoped methods on `profile`', () => {
    const p = profileRepoFromScope(stub.scope);
    expect(Object.keys(p.profile).sort()).toEqual(
      [
        'commitState',
        'deleteById',
        'findById',
        'setDiscoveryConfig',
        'setRiskConfig',
        'setEnabled',
        'switchStrategy',
        'update',
      ].sort(),
    );
  });

  it('exposes only the profile-scoped funcs on `auditLogs` (filters out user-scoped funcs)', () => {
    const p = profileRepoFromScope(stub.scope);
    expect(Object.keys(p.auditLogs).sort()).toEqual(['listAllForProfile', 'listForProfile']);
  });

  it('binds the ProfileScope on a pure-shape module', () => {
    const p = profileRepoFromScope(stub.scope);
    // Sanity: a pure-shape namespace carries every exported function. The full
    // surface check is the type system; here we lock the names so a future
    // export drift is caught. (api-keys moved to the account scope, so it is no
    // longer on the profile-scoped surface — see AccountRepo.)
    expect(Object.keys(p.resultLedger).sort()).toEqual(['listForMarket', 'upsert']);
  });

  it('keeps the user-scoped findOwningSiblingByBase off the profile-scoped surface', () => {
    const p = profileRepoFromScope(stub.scope);
    // `findOwningSiblingByBase(db, userId, ...)` spans an account's profiles, so
    // it must not be reachable on the single-profile bound surface (it would be
    // mis-bound with the scope in the `db` slot).
    expect(Object.keys(p.profileSymbols).sort()).toEqual([
      'findForSymbol',
      'listForProfile',
      'recordFlatten',
      'remove',
      'removeAutoIfFlat',
      'setReserve',
      'setSource',
      'upsert',
    ]);
  });

  it('exposes the same scope object that was passed in', () => {
    const p = profileRepoFromScope(stub.scope);
    expect(p.scope).toBe(stub.scope);
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
