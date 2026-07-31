// listEnabledForAccount: the account-scoped notifier resolve behind account-level
// ops alerts. An event about one account's order book must reach that account's
// channels and no others — including a SIBLING account on the same Binance
// environment, which a mode-scoped resolve would wrongly include. The join runs
// profile_notifiers -> profiles -> accounts, which only a real Postgres exercises.

import { randomUUID } from 'node:crypto';
import { asAccountId } from '@app/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as profileNotifiersRepo from '../../src/repo/profile-notifiers.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('profileNotifiers.listEnabledForAccount', () => {
  let fx: IsolationFixture;
  // Two more accounts under the SAME operator: one on the live env, and one MORE
  // on the live env. The same-mode pair is the case an env-keyed resolve gets
  // wrong (it would hand one account's alert to the other's channels).
  const liveAccountId = asAccountId(randomUUID());
  const liveSiblingAccountId = asAccountId(randomUUID());
  const liveProfileId = randomUUID();
  const liveSiblingProfileId = randomUUID();

  const seedAccount = async (accountId: string, profileId: string): Promise<void> => {
    await fx.db.insert(schema.accounts).values({
      id: accountId,
      ownerId: fx.alice.userId,
      name: `live-${accountId}`,
      binanceMode: 'live',
    });
    await fx.db.insert(schema.profiles).values({
      id: profileId,
      accountId,
      name: 'live-demo',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });
  };

  beforeAll(async () => {
    fx = await setupFixture();
    await seedAccount(liveAccountId, liveProfileId);
    await seedAccount(liveSiblingAccountId, liveSiblingProfileId);
    await fx.db.insert(schema.profileNotifiers).values([
      // Alice's default profile lives on a test-mode account.
      {
        profileId: fx.alice.profileId,
        provider: 'slack',
        config: { channel: '#testnet' },
        secrets: { url: 'https://hooks/test' },
        enabled: true,
      },
      {
        profileId: liveProfileId,
        provider: 'slack',
        config: { channel: '#live' },
        secrets: { url: 'https://hooks/live' },
        enabled: true,
      },
      {
        profileId: liveSiblingProfileId,
        provider: 'slack',
        config: { channel: '#live-sibling' },
        secrets: { url: 'https://hooks/live-2' },
        enabled: true,
      },
      // Same account, but switched off: a disabled row is not a channel.
      {
        profileId: liveProfileId,
        provider: 'telegram',
        config: { chatId: '1' },
        secrets: { token: 't' },
        enabled: false,
      },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("returns only that account's enabled notifiers", async () => {
    const rows = await profileNotifiersRepo.listEnabledForAccount(fx.db, liveAccountId);
    expect(rows.map((r) => (r.config as { channel?: string }).channel)).toEqual(['#live']);
  });

  it('excludes a SIBLING account on the same Binance environment (no cross-account bleed)', async () => {
    const rows = await profileNotifiersRepo.listEnabledForAccount(fx.db, liveSiblingAccountId);
    const channels = rows.map((r) => (r.config as { channel?: string }).channel);
    expect(channels).toEqual(['#live-sibling']);
    // The other live account's channel must not appear — this is the case a
    // mode-scoped resolve returns, and it is the bleed the alert must not cause.
    expect(channels).not.toContain('#live');
  });

  it("excludes the other environment's notifiers", async () => {
    const rows = await profileNotifiersRepo.listEnabledForAccount(fx.db, fx.alice.accountId);
    const channels = rows.map((r) => (r.config as { channel?: string }).channel);
    expect(channels).toEqual(['#testnet']);
  });
});
