import { createMetricsRegistry } from '@app/observability';
import { rendezvousOwner } from '@app/core/hrw';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSubscriptionOwnership,
  type OwnedProfile,
  type OwnershipPool,
} from '../../src/user-stream/subscription-ownership.js';

const logger = pino({ level: 'silent' });

/** Redis seeded with ready member records, covering the scan/mget listReadyMembers uses. */
const memberRedis = (ids: readonly string[]): Redis => {
  const store = new Map<string, string>();
  for (const id of ids) {
    store.set(`worker:members:${id}`, JSON.stringify({ id, sha: 'x', bootedAt: 't', ready: true }));
  }
  return {
    scan: (_cursor: string) => Promise.resolve(['0', [...store.keys()]]),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
  } as unknown as Redis;
};

/** Redis whose SCAN rejects — the "can't read the member set" failure. */
const brokenRedis = (): Redis =>
  ({ scan: () => Promise.reject(new Error('redis down')) }) as unknown as Redis;

interface FakePool extends OwnershipPool {
  readonly opened: ProfileId[];
  readonly closed: ProfileId[];
}

const fakePool = (initiallyOpen: readonly string[] = []): FakePool => {
  const open = new Set<string>(initiallyOpen);
  const opened: ProfileId[] = [];
  const closed: ProfileId[] = [];
  return {
    open: (_operatorId, _accountId, pid) => {
      open.add(pid);
      opened.push(pid);
      return Promise.resolve();
    },
    close: (_operatorId, _accountId, pid) => {
      open.delete(pid);
      closed.push(pid);
      return Promise.resolve();
    },
    isOpen: (pid) => open.has(pid),
    opened,
    closed,
  };
};

const profile = (n: number): OwnedProfile => ({
  profileId: `p${n}` as ProfileId,
  operatorId: `u${n}` as UserId,
  accountId: `a${n}` as AccountId,
});

const metrics = (): ReturnType<typeof createMetricsRegistry> =>
  createMetricsRegistry({ service: 'test' });

/** Find an account label whose HRW owner over `members` equals / differs from `self`. */
const accountOwnedBy = (self: string, members: readonly string[], owned: boolean): string => {
  for (let i = 0; i < 500; i += 1) {
    const acct = `a${i}`;
    if ((rendezvousOwner(acct, members) === self) === owned) return acct;
  }
  throw new Error('no matching account found');
};

describe('subscription ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('opens the streams it owns and leaves the rest closed', async () => {
    const members = ['pod-a', 'pod-b', 'pod-c'];
    const self = 'pod-a';
    const profiles = Array.from({ length: 6 }, (_, i) => profile(i + 1));
    const pool = fakePool();
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool,
      listActive: () => profiles,
      metrics: metrics(),
    });

    await own.reconcile();

    for (const p of profiles) {
      const owns = rendezvousOwner(`${p.accountId}`, members) === self;
      expect(pool.isOpen(p.profileId)).toBe(owns);
    }
    // At least one owned and one not-owned, so both branches were exercised.
    expect(pool.opened.length).toBeGreaterThan(0);
    expect(pool.opened.length).toBeLessThan(profiles.length);
  });

  it('closes a stream once ownership moves to another member', async () => {
    const members = ['pod-a', 'pod-b', 'pod-c'];
    const self = 'pod-a';
    const acct = accountOwnedBy(self, members, false); // self does NOT own it
    const p: OwnedProfile = {
      profileId: 'p1' as ProfileId,
      operatorId: 'u1' as UserId,
      accountId: acct as AccountId,
    };
    const pool = fakePool(['p1']); // stream currently open on this pod
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool,
      listActive: () => [p],
      metrics: metrics(),
    });

    await own.reconcile();

    expect(pool.isOpen('p1' as ProfileId)).toBe(false);
    expect(pool.closed).toEqual(['p1']);
  });

  it('does not re-open a stream it already owns (no redundant backfill)', async () => {
    const members = ['pod-a', 'pod-b'];
    const self = 'pod-a';
    const acct = accountOwnedBy(self, members, true); // self owns it
    const p: OwnedProfile = {
      profileId: 'p1' as ProfileId,
      operatorId: 'u1' as UserId,
      accountId: acct as AccountId,
    };
    const pool = fakePool(['p1']); // already open
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool,
      listActive: () => [p],
      metrics: metrics(),
    });

    await own.reconcile();

    expect(pool.opened).toEqual([]); // open() never called again
    expect(pool.closed).toEqual([]);
    expect(pool.isOpen('p1' as ProfileId)).toBe(true);
  });

  it('fails open: keeps streams when this pod is absent from the ready set', async () => {
    const pool = fakePool(['p1']);
    const own = createSubscriptionOwnership({
      redis: memberRedis(['pod-x', 'pod-y']), // self 'pod-a' not present
      logger,
      selfId: 'pod-a',
      pool,
      listActive: () => [profile(1)],
      metrics: metrics(),
    });

    await own.reconcile();

    expect(pool.closed).toEqual([]); // never tears down on an indeterminate set
    expect(pool.isOpen('p1' as ProfileId)).toBe(true);
  });

  it('fails open: keeps streams when the member read errors', async () => {
    const pool = fakePool(['p1']);
    const own = createSubscriptionOwnership({
      redis: brokenRedis(),
      logger,
      selfId: 'pod-a',
      pool,
      listActive: () => [profile(1)],
      metrics: metrics(),
    });

    await own.reconcile();

    expect(pool.closed).toEqual([]);
    expect(pool.isOpen('p1' as ProfileId)).toBe(true);
  });

  it('drops an overlapping reconcile while one is in flight', async () => {
    const members = ['pod-a'];
    const self = 'pod-a';
    const acct = accountOwnedBy(self, members, true);
    const p: OwnedProfile = {
      profileId: 'p1' as ProfileId,
      operatorId: 'u1' as UserId,
      accountId: acct as AccountId,
    };
    const base = fakePool();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstOpen = true;
    const gatedPool: FakePool = {
      ...base,
      open: async (operatorId, accountId, pid) => {
        if (firstOpen) {
          firstOpen = false;
          await gate; // first open blocks until released
        }
        return base.open(operatorId, accountId, pid);
      },
    };
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool: gatedPool,
      listActive: () => [p],
      metrics: metrics(),
    });

    const first = own.reconcile(); // enters, blocks inside open()
    await own.reconcile(); // must early-return via the inFlight guard
    release();
    await first;

    expect(base.opened).toEqual(['p1']); // driven exactly once, not twice
  });

  it('keeps reconciling other profiles when one open/close rejects', async () => {
    const members = ['pod-a', 'pod-b'];
    const self = 'pod-a';
    const owned = accountOwnedBy(self, members, true);
    const notOwned = accountOwnedBy(self, members, false);
    const pOpen: OwnedProfile = {
      profileId: 'p-open' as ProfileId,
      operatorId: 'u1' as UserId,
      accountId: owned as AccountId,
    };
    const pClose: OwnedProfile = {
      profileId: 'p-close' as ProfileId,
      operatorId: 'u2' as UserId,
      accountId: notOwned as AccountId,
    };
    const base = fakePool(['p-close']); // p-close is open but not owned → will close
    const rejectingPool: FakePool = {
      ...base,
      open: () => Promise.reject(new Error('open boom')),
      close: () => Promise.reject(new Error('close boom')),
    };
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool: rejectingPool,
      listActive: () => [pOpen, pClose],
      metrics: metrics(),
    });

    // Both pool ops reject; reconcile must swallow them and resolve, not throw.
    await expect(own.reconcile()).resolves.toBeUndefined();
  });

  it('reports the owned-account count on the gauge', async () => {
    const members = ['pod-a', 'pod-b', 'pod-c'];
    const self = 'pod-a';
    const profiles = Array.from({ length: 6 }, (_, i) => profile(i + 1));
    const reg = metrics();
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: self,
      pool: fakePool(),
      listActive: () => profiles,
      metrics: reg,
    });

    await own.reconcile();

    const expected = profiles.filter(
      (p) => rendezvousOwner(`${p.accountId}`, members) === self,
    ).length;
    const json = await reg.registry.getMetricsAsJSON();
    const gauge = json.find((m) => m.name === 'worker_owned_accounts');
    expect(gauge?.values[0]?.value).toBe(expected);
  });

  it('start() reconciles immediately then on the interval; stop() halts it', async () => {
    vi.useFakeTimers();
    const members = ['pod-a'];
    const profiles = [profile(1)];
    const pool = fakePool();
    let calls = 0;
    const own = createSubscriptionOwnership({
      redis: memberRedis(members),
      logger,
      selfId: 'pod-a',
      pool,
      // Count reconcile passes via the listActive read each one makes.
      listActive: () => {
        calls += 1;
        return profiles;
      },
      metrics: metrics(),
      reconcileIntervalMs: 1_000,
    });

    await own.start();
    expect(calls).toBe(1); // immediate reconcile

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2); // one interval tick

    own.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2); // no further ticks after stop
  });
});
