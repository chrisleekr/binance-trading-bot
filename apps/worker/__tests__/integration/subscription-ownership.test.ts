// Real-Redis integration for HRW subscription ownership. Composes the member
// read-side (listReadyMembers) with HRW election over actual ioredis to prove:
// exactly one of ≥3 members owns each account, and removing a member re-homes
// only the accounts it owned.

import { listReadyMembers, MEMBER_KEY_PREFIX } from '@app/db';
import { rendezvousOwner } from '@app/core/hrw';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { withRedis } from '@app/testcontainers';

import { describeInfra } from './_infra-gate.js';

describeInfra('redis', 'subscription ownership — real Redis', () => {
  let redis: Redis;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const fx = await withRedis();
    redis = new Redis(fx.redisUrl, { maxRetriesPerRequest: null });
    stop = async () => {
      redis.disconnect();
      await fx.stop();
    };
  }, 180_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${MEMBER_KEY_PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  const join = async (id: string, ready = true): Promise<void> => {
    await redis.set(
      `${MEMBER_KEY_PREFIX}${id}`,
      JSON.stringify({ id, sha: 'abc', bootedAt: 'x', ready }),
      'EX',
      60,
    );
  };

  const accounts = Array.from({ length: 50 }, (_, i) => `account-${i}`);

  it('elects exactly one owner per account across three members', async () => {
    const members = ['pod-a:1', 'pod-b:2', 'pod-c:3'];
    for (const m of members) await join(m);

    // Each pod independently reads the shared member set (real round-trips, one
    // per simulated pod) and elects — no coordination between them.
    const perPodViews = await Promise.all(members.map(() => listReadyMembers(redis)));
    for (const view of perPodViews) expect(new Set(view)).toEqual(new Set(members));

    for (const acct of accounts) {
      const winners = perPodViews.map((view) => rendezvousOwner(acct, view));
      expect(new Set(winners).size).toBe(1); // all pods elect the same owner
      expect(members).toContain(winners[0]);
    }
  });

  it('skips a not-ready member from election (only ready members can own)', async () => {
    await join('pod-a:1', true);
    await join('pod-b:2', false); // still booting

    const ready = await listReadyMembers(redis);
    expect(ready).toEqual(['pod-a:1']);
    for (const acct of accounts) expect(rendezvousOwner(acct, ready)).toBe('pod-a:1');
  });

  it('re-homes only the departed member’s accounts when it leaves', async () => {
    const members = ['pod-a:1', 'pod-b:2', 'pod-c:3'];
    for (const m of members) await join(m);
    const before = new Map(accounts.map((a) => [a, rendezvousOwner(a, [...members])] as const));

    // pod-b crashes: its key is deleted (TTL expiry equivalent).
    await redis.del(`${MEMBER_KEY_PREFIX}pod-b:2`);
    const survivors = await listReadyMembers(redis);
    expect(new Set(survivors)).toEqual(new Set(['pod-a:1', 'pod-c:3']));

    for (const a of accounts) {
      const after = rendezvousOwner(a, survivors);
      if (before.get(a) === 'pod-b:2') {
        expect(['pod-a:1', 'pod-c:3']).toContain(after); // re-homed onto a survivor
      } else {
        expect(after).toBe(before.get(a)); // untouched
      }
    }
  });
});
