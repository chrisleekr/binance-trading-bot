// Pin the resolveProfile branch logic without spinning a Postgres
// container. Three branches matter: foreign profile → null, missing
// api-key → null, happy path → fully-wired bindings whose persistence
// closures route into the scoped repo layer. ProfileNotOwnedError from
// the `profileRepo` ownership check is folded into null so the executor
// sees one shape for "not yours" and "doesn't exist".

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { ProfileNotOwnedError, type ProfileScope } from '@app/db';

// `vi.mock` is hoisted; declaring the spies via `vi.hoisted` keeps them
// reachable from the factory without a TDZ error at module init.
// Credentials + environment are per-account now: `findApiKey` stands in for
// `repo.apiKeys.findByAccountId` and `findMode` for `repo.accounts.binanceModeById`.
const {
  findProfile,
  findApiKey,
  findMode,
  listNotifiers,
  ordersInsert,
  ordersUpsertLive,
  profileRepoSpy,
  profileRepoFromScopeSpy,
} = vi.hoisted(() => ({
  findProfile: vi.fn(),
  findApiKey: vi.fn(),
  findMode: vi.fn(),
  listNotifiers: vi.fn().mockResolvedValue([]),
  ordersInsert: vi.fn(),
  ordersUpsertLive: vi.fn(),
  profileRepoSpy: vi.fn(),
  profileRepoFromScopeSpy: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return {
    ...orig,
    profileRepo: profileRepoSpy,
    // The tick path resolves bindings from an already-proven scope, so it goes
    // through `profileRepoFromScope`, not the ownership-proving `profileRepo`.
    profileRepoFromScope: profileRepoFromScopeSpy,
    // Seeking / closing an order by Binance id is account-domain now; the bindings
    // widen their proven profile scope for it. Collapse both onto the same stub.
    toAccountScope: vi.fn((scope: unknown) => scope),
    accountRepoFromScope: vi.fn(() => makeRepo()),
    repo: {
      ...orig.repo,
      apiKeys: { ...orig.repo.apiKeys, findByAccountId: findApiKey },
      accounts: { ...orig.repo.accounts, binanceModeById: findMode },
    },
  };
});

const { createBinanceRestSpy } = vi.hoisted(() => ({
  createBinanceRestSpy: vi.fn().mockReturnValue({ __mock: 'rest' }),
}));
vi.mock('@app/binance', () => ({ createBinanceRest: createBinanceRestSpy }));

const { buildProfileBindings, buildProfileBindingsFromScope, DEFAULT_BINANCE_WEIGHT_LIMIT_1M } =
  await import('../../src/profile-bindings/index.js');

const userId = 'u-1' as UserId;
const accountId = 'a-1' as AccountId;
const profileId = 'p-1' as ProfileId;
const db = {} as unknown as Parameters<typeof buildProfileBindings>[0]['db'];

// `profileRepo` resolves a scoped `ProfileRepo`; the stub exposes only
// the surface `buildProfileBindings` + its persistence closures touch.
const makeRepo = () => ({
  scope: { db, operatorId: userId, accountId, profileId },
  profile: { findById: findProfile },
  profileNotifiers: { listForProfile: listNotifiers },
  orders: {
    insert: ordersInsert,
    upsertLive: ordersUpsertLive,
    findByBinanceOrderId: vi.fn(),
    closeByBinanceOrderId: vi.fn(),
  },
  actionLogs: { append: vi.fn() },
});

beforeEach(() => {
  findProfile.mockReset();
  findApiKey.mockReset();
  findMode.mockReset();
  // Environment is per-account; default to a valid mode so mode-agnostic
  // tests exercise the happy path without restating it.
  findMode.mockResolvedValue('test');
  listNotifiers.mockClear();
  ordersInsert.mockReset();
  ordersUpsertLive.mockReset();
  createBinanceRestSpy.mockClear();
  profileRepoSpy.mockReset();
  profileRepoSpy.mockResolvedValue(makeRepo());
  // `profileRepoFromScope` is synchronous — it hands back the scoped repo built
  // from an already-proven scope, no ownership query.
  profileRepoFromScopeSpy.mockReset();
  profileRepoFromScopeSpy.mockReturnValue(makeRepo());
});

const aProfileRow = (overrides: Record<string, unknown> = {}) => ({
  id: profileId,
  accountId,
  name: 'profile-1',
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  config: {},
  state: {},
  enabled: true,
  binanceMode: 'test',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('buildProfileBindings — null branches', () => {
  it('returns null when the profile row is deleted between the scope check and the read', async () => {
    findProfile.mockResolvedValueOnce(null);
    const out = await buildProfileBindings({ db }, userId, accountId, profileId);
    // Null is the whole contract here. The credential/mode reads are issued
    // concurrently with the existence read, so whether they ran is timing, not
    // behaviour — asserting on it would pin the call order rather than the guard.
    expect(out).toBeNull();
  });

  it('returns null when api-key row is missing for the owning profile', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce(null);
    const out = await buildProfileBindings({ db }, userId, accountId, profileId);
    expect(out).toBeNull();
  });

  it('folds ProfileNotOwnedError from the ownership check into the null branch', async () => {
    profileRepoSpy.mockRejectedValueOnce(new ProfileNotOwnedError(userId, accountId, profileId));
    const out = await buildProfileBindings({ db }, userId, accountId, profileId);
    expect(out).toBeNull();
    expect(findProfile).not.toHaveBeenCalled();
  });

  it('throws if profile.binanceMode falls outside the live/test union (constraint drift)', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce({ key: 'k', secret: 's', last4: '0000' });
    // Environment is per-account: mode resolves via repo.accounts.binanceModeById.
    findMode.mockResolvedValueOnce('paper');
    await expect(buildProfileBindings({ db }, userId, profileId)).rejects.toThrow(
      /binanceMode out of range/,
    );
  });

  it('rethrows unknown errors from the ownership check so the worker can retry/DLQ', async () => {
    profileRepoSpy.mockRejectedValueOnce(new Error('pg pool exhausted'));
    await expect(buildProfileBindings({ db }, userId, profileId)).rejects.toThrow(
      'pg pool exhausted',
    );
  });
});

describe('buildProfileBindings — happy path wiring', () => {
  it('produces bindings with mode from the profile row, and the default weight limit', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce({ key: 'pub', secret: 'priv', last4: '1234' });
    findMode.mockResolvedValueOnce('live');

    const out = await buildProfileBindings({ db }, userId, accountId, profileId);
    if (!out) throw new Error('expected non-null bindings on happy path');
    expect(out.mode).toBe('live');
    expect(out.weightLimit1m).toBe(DEFAULT_BINANCE_WEIGHT_LIMIT_1M);
    expect(out.binance).toEqual({ __mock: 'rest' });
    expect(createBinanceRestSpy).toHaveBeenCalledWith({
      mode: 'live',
      credentials: { apiKey: 'pub', secretKey: 'priv' },
    });
  });

  it('honours a caller-provided defaultWeightLimit1m so tests can pin a small ceiling', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce({ key: 'k', secret: 's', last4: '0000' });
    const out = await buildProfileBindings(
      { db, defaultWeightLimit1m: 50 },
      userId,
      accountId,
      profileId,
    );
    expect(out?.weightLimit1m).toBe(50);
  });

  it('persistOrder routes a live row through the scoped orders.upsertLive', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce({ key: 'k', secret: 's', last4: '0000' });
    ordersUpsertLive.mockResolvedValueOnce({ id: 'order-1' });
    const out = await buildProfileBindings({ db }, userId, accountId, profileId);
    if (!out) throw new Error('expected non-null bindings');
    await out.persistence.persistOrder(
      {
        userId,
        profileId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        intent: 'grid-buy',
        binanceOrderId: 1n,
        clientOrderId: 'c',
        status: 'NEW',
        raw: {},
      },
      { closePrevious: true },
    );
    expect(ordersUpsertLive).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', binanceOrderId: 1n }),
      { closePrevious: true },
    );
  });
});

// On the order-emitting tick path the profile is already resolved
// (buildProfileTickContext holds quoteAsset + weightLimit1m), so the config
// VALUES are single-sourced from that snapshot. The `profile.findById` read is
// NOT skipped: it is the existence guard against a mid-tick dispose (dispose
// chains on `profileId`, the tick on `profileId:symbol` — different keys, so
// they interleave; a deleted profile must skip the order). `mode` + credentials
// stay FRESH. API: `buildProfileBindingsFromScope(deps, scope, resolved?)` where
// `resolved = { quoteAsset, weightLimit1m }`; when present it sources the config
// values from `resolved` while findById still runs for existence.
const aScope = (): ProfileScope =>
  ({ db, operatorId: userId, accountId, profileId }) as unknown as ProfileScope;

describe('buildProfileBindingsFromScope — tick path with pre-resolved config scalars', () => {
  it('sources config from resolved (ignoring the row values) while still reading findById + mode + api-key', async () => {
    // Seed findById with DIFFERENT values so the assertion proves the config
    // comes from `resolved`, not the freshly-read row: the row's quoteAsset is a
    // decoy that must be ignored.
    findProfile.mockResolvedValue(aProfileRow({ quoteAsset: 'STALE' }));
    findApiKey.mockResolvedValueOnce({ key: 'k', secret: 's', last4: '0000' });
    findMode.mockResolvedValueOnce('live');

    const out = await buildProfileBindingsFromScope({ db }, aScope(), {
      quoteAsset: 'USDT',
      weightLimit1m: 999,
    });

    // Existence guard: the profile read still runs so a mid-tick dispose is seen.
    expect(findProfile).toHaveBeenCalled();
    // Mode is mutable → always read fresh (never served from the stale context).
    expect(findMode).toHaveBeenCalled();
    // Credentials are read fresh per tick.
    expect(findApiKey).toHaveBeenCalled();

    if (!out) throw new Error('expected non-null bindings on the tick path');
    // Values come from the caller-supplied resolved config, not the decoy row.
    expect(out.quoteAsset).toBe('USDT');
    expect(out.weightLimit1m).toBe(999);
    // Mode still comes from the fresh account read.
    expect(out.mode).toBe('live');
  });

  it('returns null when the profile was deleted mid-tick, even with resolved present (deletion-race guard)', async () => {
    // The tick proved the row moments ago, but dispose-profile can interleave
    // (separate chain key) and delete it before the executor resolves bindings.
    // findById → null MUST fold to null so the order is skipped, not placed
    // against a deleting profile (orphan Binance order / FK-DLQ).
    findProfile.mockResolvedValueOnce(null);
    findApiKey.mockResolvedValue({ key: 'k', secret: 's', last4: '0000' });
    findMode.mockResolvedValue('live');

    const out = await buildProfileBindingsFromScope({ db }, aScope(), {
      quoteAsset: 'USDT',
      weightLimit1m: 999,
    });

    // The deletion-race guard is the null return, nothing else: the credential
    // and mode reads are issued alongside the existence read rather than after
    // it, so their call count is timing detail, not the invariant under test.
    expect(out).toBeNull();
  });
});

describe('buildProfileBindings — pipeline/standalone path stays a full read', () => {
  it('without pre-resolved scalars still reads findById + mode + api-key', async () => {
    findProfile.mockResolvedValueOnce(aProfileRow());
    findApiKey.mockResolvedValueOnce({ key: 'k', secret: 's', last4: '0000' });
    findMode.mockResolvedValueOnce('test');

    const out = await buildProfileBindings({ db }, userId, accountId, profileId);

    expect(out).not.toBeNull();
    expect(findProfile).toHaveBeenCalled();
    expect(findMode).toHaveBeenCalled();
    expect(findApiKey).toHaveBeenCalled();
  });
});
