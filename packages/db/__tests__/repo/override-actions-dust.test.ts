import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profileRepo, profileRepoFromScope, type ProfileRepo } from '../../src/repo/index.js';
import { overrideActions } from '../../src/schema/override-actions.js';
import { asAccountId, asProfileId, asUserId } from '@app/contracts';
import type { Database } from '../../src/repo/_db.js';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import { createRepoAstReader } from './_exported-fns.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

/**
 * The profile-scoped reader/deleter pair behind the dust-conversion cancel.
 * Dust rows carry `symbol = null`, so `record()` never supersedes a sibling and
 * a profile can hold several pending rows; the delete is therefore a set
 * operation, not a single-row one, and it must refuse to touch a row the worker
 * has already claimed.
 */
const repoAst = createRepoAstReader();

afterAll(() => {
  repoAst.close();
});

/**
 * The surface under test, narrowed for readability only. Nothing here pins a
 * signature: `__tests__/**\/*.test.ts` is excluded from both tsconfigs, so this
 * file is never compiled and an assertion written against its shape would guard
 * nothing while looking like it did. The compile-time pin is a `.test-d.ts`,
 * which `bun run typecheck` does read.
 */
interface DustCancelFns {
  findActiveDustTransfer(): Promise<{ id: string; processingAt: Date | null } | null>;
  deletePendingDustTransfer(staleBefore: Date): Promise<readonly string[]>;
}
const dust = (p: ProfileRepo): DustCancelFns => p.overrideActions;

const profileStub = {
  db: { __stub: 'db' } as unknown as Database,
  operatorId: asUserId('00000000-0000-0000-0000-0000000a0001'),
  accountId: asAccountId('00000000-0000-0000-0000-0000000ac001'),
  profileId: asProfileId('00000000-0000-0000-0000-0000000a1001'),
} as unknown as ProfileScope;

describe('dust-transfer cancel repo surface', () => {
  it('declares both dust cancel functions scope-first', () => {
    // Scope-first is what proves the ownership chain in one query. A db-first
    // export would typecheck and silently reach across accounts.
    const scopeFirst = repoAst.scopeFirstExportNames('override-actions.ts', 'ProfileScope');
    expect(scopeFirst).toContain('findActiveDustTransfer');
    expect(scopeFirst).toContain('deletePendingDustTransfer');
  });

  it('reaches app code only through the bound profile surface', () => {
    // A scope-first export missing from the bind allow-list is `undefined` at
    // call time while still typechecking, which is how a repo function ships
    // dead.
    const bound = Object.keys(
      (profileRepoFromScope(profileStub) as unknown as Record<string, object>)['overrideActions'] ??
        {},
    );
    expect(bound).toContain('findActiveDustTransfer');
    expect(bound).toContain('deletePendingDustTransfer');
  });
});

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('dust-transfer cancel repo behaviour', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // Both tests share one profile and the first deliberately leaves a live claim
  // resting, which the horizon test would then delete alongside its own row.
  // Reset outside the function under test: seeding by calling the deleter would
  // make the exact-id assertion below partly a restatement of its own setup.
  beforeEach(async () => {
    await fx.db.delete(overrideActions).where(eq(overrideActions.profileId, fx.alice.profileId));
  });

  const arm = async (assets: string[]): Promise<string> => {
    const row = await ap.overrideActions.record({
      symbol: null,
      action: 'dust-transfer',
      actionAt: new Date(),
      payload: { assets },
      triggeredBy: 'user',
    });
    return row.id;
  };

  // Any instant before every claim in the test, so only genuinely unclaimed rows
  // qualify. Named rather than inlined because the horizon is the whole contract.
  const NOTHING_IS_STALE = new Date(0);

  it('deletes every unclaimed dust row and leaves a live claim behind', async () => {
    const claimedId = await arm(['TRX']);
    expect(await ap.overrideActions.claimAction(claimedId, new Date())).toBe(true);
    const queued = [await arm(['DOGE']), await arm(['SHIB'])];

    // The ids, not a count. They are the caller's only surviving record of a hard
    // delete, and a count that is right while the wrong rows went reads as a pass.
    const removed = await dust(ap).deletePendingDustTransfer(NOTHING_IS_STALE);
    expect([...removed].sort()).toEqual([...queued].sort());
    const survivor = await dust(ap).findActiveDustTransfer();
    expect(survivor?.id).toBe(claimedId);
    expect(survivor?.processingAt).not.toBeNull();
  });

  it('deletes a claim older than the horizon, because the reaper would re-run it', async () => {
    // `reapStaleProcessing` resets exactly these rows to pending and the dust cron
    // converts them on the same pass. Refusing to delete one here is what lets a
    // cancel answer 204 and spend the balance minutes later.
    const strandedId = await arm(['TRX']);
    expect(await ap.overrideActions.claimAction(strandedId, new Date())).toBe(true);

    const staleBefore = new Date(Date.now() + 60_000);
    expect(await dust(ap).deletePendingDustTransfer(staleBefore)).toEqual([strandedId]);
    expect(await dust(ap).findActiveDustTransfer()).toBeNull();
  });
});
