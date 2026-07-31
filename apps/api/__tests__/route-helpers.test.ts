import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DI } from '../src/di.js';
import type { Env } from '../src/types.js';

// `requireOwnedProfile` adds exactly one branch over `scopeOf`: a 404 when the
// row vanished between the ownership query and `findById` (a delete-between
// race). That branch is otherwise covered only by Docker-gated route
// integration tests, so mock `profileRepo` and exercise it DB-free here.
const { findByIdMock } = vi.hoisted(() => ({ findByIdMock: vi.fn() }));
vi.mock('@app/db', async (importActual) => ({
  ...(await importActual<typeof import('@app/db')>()),
  profileRepo: vi.fn(async () => ({
    scope: { userId: 'u', profileId: 'p' },
    profile: { findById: findByIdMock },
  })),
}));

import { RECONCILE_FEES_JOB_OPTS, requireOwnedProfile, scopeOf } from '../src/route-helpers.js';

const U = asUserId('00000000-0000-0000-0000-000000000001');
const P = asProfileId('00000000-0000-0000-0000-000000000002');
const A = asAccountId('00000000-0000-0000-0000-000000000003');
// scopeOf reads userId from the context and :accountId from the URL params.
const fakeCtx = {
  get: (k: string) => (k === 'userId' ? U : undefined),
  req: { param: (k: string) => (k === 'accountId' ? A : undefined) },
} as unknown as Context<Env>;
const fakeDi = { db: {} } as unknown as DI;

// The reconcile-fees enqueue contract is load-bearing: a static jobId would
// make BullMQ dedupe the reconcile against a retained completed job and silently
// skip every request after the first, so a profile's fees would never true up.
// The profiles route that enqueues this only has infra-gated integration tests
// (skipped in CI), so lock the shared options shape here in a unit test that
// always runs.
describe('RECONCILE_FEES_JOB_OPTS (reconcile-fees enqueue contract)', () => {
  it('carries no static jobId so every mutation enqueues a fresh resync', () => {
    expect(RECONCILE_FEES_JOB_OPTS).not.toHaveProperty('jobId');
  });

  it('drops completed jobs (frees the id, bounds the failed set)', () => {
    expect(RECONCILE_FEES_JOB_OPTS.removeOnComplete).toBe(true);
    expect(RECONCILE_FEES_JOB_OPTS.removeOnFail).toEqual({ count: 1_000 });
  });
});

describe('requireOwnedProfile (ownership + row guard)', () => {
  beforeEach(() => findByIdMock.mockReset());

  it('returns the bound repo and the row when the profile exists', async () => {
    const row = { id: P, name: 'x' };
    findByIdMock.mockResolvedValueOnce(row);
    const { p, profile } = await requireOwnedProfile(fakeCtx, fakeDi, P);
    expect(profile).toBe(row);
    expect(p.profile.findById).toBe(findByIdMock);
  });

  it('throws NOT_FOUND when the row vanished after the ownership check (delete-between race)', async () => {
    findByIdMock.mockResolvedValueOnce(null);
    await expect(requireOwnedProfile(fakeCtx, fakeDi, P)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('scopeOf resolves the bound repo without fetching the row', async () => {
    const p = await scopeOf(fakeCtx, fakeDi, P);
    expect(p.scope.profileId).toBe('p');
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
