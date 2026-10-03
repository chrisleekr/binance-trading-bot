import { DiscoveryConfigSchema } from '@app/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

// The discovery PATCH merges the caller's keys over the stored config. Two PATCHes that both merged from one snapshot would let the later write drop the earlier one's change, so the merge runs under a row lock.
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('discovery config merge under a row lock', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await ap.profile.setDiscoveryConfig(DiscoveryConfigSchema.parse({}));
  });
  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('makes a concurrent merge wait for the first and build on its result, so neither change is lost', async () => {
    // The first merge holds its transaction open; the second starts while it does. Without the lock the second reads the same snapshot, writes first, and the first then overwrites it.
    const first = ap.profile.mergeDiscoveryConfig(async (stored) => {
      const current = DiscoveryConfigSchema.parse(stored ?? {});
      await sleep(200);
      return { ...current, enabled: false };
    });
    await sleep(50);
    const second = ap.profile.mergeDiscoveryConfig((stored) => {
      const current = DiscoveryConfigSchema.parse(stored ?? {});
      return { ...current, blacklist: ['XUSDT'] };
    });
    await Promise.all([first, second]);
    const row = await ap.profile.findById();
    const saved = DiscoveryConfigSchema.parse(row?.discoveryConfig ?? {});
    expect(saved.enabled).toBe(false);
    expect(saved.blacklist).toEqual(['XUSDT']);
  });

  it('rolls back when the merge refuses, leaving the stored config as it was', async () => {
    const before = (await ap.profile.findById())?.discoveryConfig;
    await expect(
      ap.profile.mergeDiscoveryConfig(() => {
        throw new Error('entry mode not allowed');
      }),
    ).rejects.toThrow(/entry mode not allowed/);
    expect((await ap.profile.findById())?.discoveryConfig).toEqual(before);
  });
});
