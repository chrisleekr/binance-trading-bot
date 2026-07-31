// #579 integration: subscription-ownership is the SOLE user-data stream driver.
//
// profileManager no longer opens/closes the account stream on enable/disable —
// it only registers membership + market subs. This wires the REAL profileManager
// and REAL subscription-ownership together (single-member fleet = self owns every
// account) and proves the stream lifecycle still works end-to-end: enable never
// opens a stream, ownership opens every owned stream on its first election, and a
// runtime reconcile (subscribe/unsubscribe) converges streams on re-election.

import { createMetricsRegistry } from '@app/observability';
import { rendezvousOwner } from '@app/core/hrw';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  createProfileManager,
  type MarketSubscriberHooks,
  type ProfileLoadRow,
} from '../../src/profile-manager/profile-manager.js';
import {
  createSubscriptionOwnership,
  type OwnershipPool,
} from '../../src/user-stream/subscription-ownership.js';

const logger = pino({ level: 'silent' });
const SELF = 'pod-a';

/** Redis seeded with a single ready member so self owns every account (HRW over one member). */
const singleMemberRedis = (): Redis => {
  const store = new Map<string, string>([
    [`worker:members:${SELF}`, JSON.stringify({ id: SELF, sha: 'x', bootedAt: 't', ready: true })],
  ]);
  return {
    scan: () => Promise.resolve(['0', [...store.keys()]]),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
  } as unknown as Redis;
};

const fakePool = (): OwnershipPool & { opened: string[]; closed: string[] } => {
  const open = new Set<string>();
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    open: (_operatorId: UserId, _accountId: AccountId, pid: ProfileId) => {
      open.add(pid);
      opened.push(pid);
      return Promise.resolve();
    },
    close: (_operatorId: UserId, _accountId: AccountId, pid: ProfileId) => {
      open.delete(pid);
      closed.push(pid);
      return Promise.resolve();
    },
    isOpen: (pid: ProfileId) => open.has(pid),
    opened,
    closed,
  };
};

const noopMarket: MarketSubscriberHooks = {
  addSymbols: () => Promise.resolve(),
  removeSymbols: () => Promise.resolve(),
};

const row = (id: string): ProfileLoadRow => ({
  userId: `u-${id}` as UserId,
  operatorId: `u-${id}` as UserId,
  accountId: `a-${id}` as AccountId,
  profileId: id as ProfileId,
  symbols: ['BTCUSDT'],
  candleInterval: '1h',
  technicalsIntervals: [],
});

describe('#579 ownership is the sole user-data stream driver', () => {
  const wire = (seed: ProfileLoadRow[]) => {
    const pm = createProfileManager({ loadEnabledProfiles: async () => seed });
    pm.setMarket(noopMarket);
    const pool = fakePool();
    const ownership = createSubscriptionOwnership({
      redis: singleMemberRedis(),
      logger,
      selfId: SELF,
      pool,
      listActive: () => pm.listActive(),
      metrics: createMetricsRegistry({ service: 'test' }),
    });
    return { pm, pool, ownership };
  };

  it('enable opens NO stream; ownership opens every owned stream on its first election', async () => {
    const { pm, pool, ownership } = wire([row('p1'), row('p2')]);

    await pm.start();
    // The refactor's core claim: membership is populated but enable opened nothing.
    expect(pool.opened).toEqual([]);
    expect(
      pm
        .listActive()
        .map((a) => a.profileId as unknown as string)
        .sort(),
    ).toEqual(['p1', 'p2']);

    await ownership.reconcile();
    expect(pool.opened.sort()).toEqual(['p1', 'p2']);
    expect(pool.isOpen('p1' as ProfileId)).toBe(true);
    expect(pool.isOpen('p2' as ProfileId)).toBe(true);
  });

  it('a runtime reconcile that adds a profile opens its stream on the next election', async () => {
    const { pm, pool, ownership } = wire([row('p1')]);
    await pm.start();
    await ownership.reconcile();
    expect(pool.opened).toEqual(['p1']);

    // Simulates a runtime subscribe propagated by the enabled-set reconciler.
    await pm.reconcile([row('p1'), row('p2')]);
    await ownership.reconcile();

    expect(pool.opened.sort()).toEqual(['p1', 'p2']);
  });

  it('a runtime reconcile that drops a profile closes its stream on the next election', async () => {
    const { pm, pool, ownership } = wire([row('p1'), row('p2')]);
    await pm.start();
    await ownership.reconcile();

    await pm.reconcile([row('p1')]); // p2 unsubscribed
    await ownership.reconcile();

    expect(pool.closed).toContain('p2');
    expect(pool.isOpen('p2' as ProfileId)).toBe(false);
    expect(pool.isOpen('p1' as ProfileId)).toBe(true);
  });

  it('cedes a still-active profile to another pod when a second replica joins (cross-pod re-home)', async () => {
    // The unowned-transition branch: a profile that stays in listActive but,
    // after a second pod joins, HRW-elects to that pod. This pod must close +
    // untrack its stream. Only reachable at replicas>1 — the multi-replica seam.
    const twoMembers = [SELF, 'pod-b'];
    // Find an account HRW assigns to pod-b (so self cedes it once pod-b joins).
    let ceded = '';
    for (let i = 0; i < 500; i += 1) {
      if (rendezvousOwner(`u-${i}`, twoMembers) === 'pod-b') {
        ceded = `u-${i}`;
        break;
      }
    }
    expect(ceded).not.toBe('');

    const profileId = 'p-rehome' as ProfileId;
    const pm = createProfileManager({
      loadEnabledProfiles: async () => [
        {
          userId: 'u-rehome' as UserId,
          operatorId: 'u-rehome' as UserId,
          accountId: ceded as AccountId,
          profileId,
          symbols: ['BTCUSDT'],
          candleInterval: '1h',
          technicalsIntervals: [],
        },
      ],
    });
    pm.setMarket(noopMarket);
    const pool = fakePool();
    // Mutable member set: starts single (self owns everything), then pod-b joins.
    let memberSet = [SELF];
    const redis = {
      scan: () => Promise.resolve(['0', memberSet.map((id) => `worker:members:${id}`)]),
      mget: (...keys: string[]) =>
        Promise.resolve(
          keys.map((k) => {
            const id = k.split(':').pop() ?? '';
            return memberSet.includes(id)
              ? JSON.stringify({ id, sha: 'x', bootedAt: 't', ready: true })
              : null;
          }),
        ),
    } as unknown as Redis;
    const ownership = createSubscriptionOwnership({
      redis,
      logger,
      selfId: SELF,
      pool,
      listActive: () => pm.listActive(),
      metrics: createMetricsRegistry({ service: 'test' }),
    });

    await pm.start();
    await ownership.reconcile(); // sole member: self owns + opens it
    expect(pool.opened).toEqual([profileId]);

    memberSet = [SELF, 'pod-b']; // pod-b joins; HRW re-homes `ceded` to pod-b
    await ownership.reconcile();

    // Self cedes: closes the stream and untracks it (the profile is still active).
    expect(pool.closed).toContain(profileId);
    expect(pool.isOpen(profileId)).toBe(false);
  });
});
