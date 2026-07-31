import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  PLACEMENT_DEDUP_WINDOW_MS,
  createPlacementDedup,
} from '../../src/executor/placement-dedup.js';

// A per-symbol Redis SET stub: `placement-dedup:<symbolKey>` → set of clientOrderIds,
// backed by an in-memory Map so a SECOND dedup instance (fresh in-process Map, same
// Redis) sees what the first mirrored. Models the vi.fn Redis stubs used by
// notifier-gap-throttle.test.ts and packages/db/__tests__/projections/_redis-stub.ts.
const makeSetRedisStub = () => {
  const store = new Map<string, Set<string>>();
  const sadd = vi.fn(async (key: string, member: string) => {
    const set = store.get(key) ?? new Set<string>();
    const had = set.has(member);
    set.add(member);
    store.set(key, set);
    return had ? 0 : 1;
  });
  const sismember = vi.fn(async (key: string, member: string) =>
    store.get(key)?.has(member) ? 1 : 0,
  );
  const del = vi.fn(async (key: string) => (store.delete(key) ? 1 : 0));
  const pexpire = vi.fn(async (_key: string, _ms: number) => 1);
  // `record` writes SADD+PEXPIRE in one MULTI/EXEC. The chain defers to the same
  // underlying sadd/pexpire vi.fns on exec(), so their call assertions still hold
  // and a mockRejectedValue on either surfaces as an exec() rejection.
  const multi = vi.fn(() => {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      sadd: vi.fn((key: string, member: string) => {
        ops.push(() => sadd(key, member));
        return chain;
      }),
      pexpire: vi.fn((key: string, ms: number) => {
        ops.push(() => pexpire(key, ms));
        return chain;
      }),
      exec: vi.fn(async () => Promise.all(ops.map((op) => op()))),
    };
    return chain;
  });
  const redis = { sadd, sismember, del, pexpire, multi } as unknown as Redis;
  return { store, sadd, sismember, del, pexpire, multi, redis };
};

describe('createPlacementDedup', () => {
  const COID = 'tt-77a7ac7a-b';
  const SYM = 'acc-1:ETHBTC';

  it('reports a clientOrderId as unseen until it is recorded', async () => {
    const dedup = createPlacementDedup();
    expect(await dedup.seenRecently(COID, SYM, 1_000)).toBe(false);
  });

  it('suppresses a repeat of the same clientOrderId inside the window', async () => {
    const dedup = createPlacementDedup();
    await dedup.record(COID, SYM, 1_000);
    expect(await dedup.seenRecently(COID, SYM, 1_500)).toBe(true);
    expect(await dedup.seenRecently(COID, SYM, 1_000 + PLACEMENT_DEDUP_WINDOW_MS - 1)).toBe(true);
  });

  it('allows the clientOrderId again once the window has elapsed', async () => {
    const dedup = createPlacementDedup();
    await dedup.record(COID, SYM, 1_000);
    expect(await dedup.seenRecently(COID, SYM, 1_000 + PLACEMENT_DEDUP_WINDOW_MS)).toBe(false);
  });

  it('keys independently per clientOrderId (a different level/symbol is not deduped)', async () => {
    const dedup = createPlacementDedup();
    await dedup.record(COID, SYM, 1_000);
    expect(await dedup.seenRecently('tt-other-b', SYM, 1_500)).toBe(false);
  });

  it('prunes expired keys on record so the map stays bounded', async () => {
    const dedup = createPlacementDedup(1_000);
    await dedup.record('old', SYM, 0);
    // A within-window record keeps the prior key (prune sees it, does not delete).
    await dedup.record('mid', SYM, 500);
    expect(await dedup.seenRecently('old', SYM, 500)).toBe(true);
    // A record past 'old's window prunes it (delete branch) but keeps 'mid'
    // (recorded at 500, still inside its 1000ms window at 1400).
    await dedup.record('new', SYM, 1_400);
    expect(await dedup.seenRecently('old', SYM, 1_400)).toBe(false);
    expect(await dedup.seenRecently('mid', SYM, 1_400)).toBe(true);
    expect(await dedup.seenRecently('new', SYM, 1_400)).toBe(true);
  });

  it('forgetSymbol drops that symbol group so a re-entry after a close is not suppressed', async () => {
    const dedup = createPlacementDedup();
    await dedup.record(COID, SYM, 1_000);
    expect(await dedup.seenRecently(COID, SYM, 1_100)).toBe(true);
    // A SELL for this symbol forgets its entry records — a legit re-entry places.
    await dedup.forgetSymbol(SYM, 1_200);
    expect(await dedup.seenRecently(COID, SYM, 1_300)).toBe(false);
  });

  it('forgetSymbol only drops the named symbol group, leaving other symbols intact', async () => {
    const dedup = createPlacementDedup();
    await dedup.record('a-b', 'acc-1:ETHBTC', 1_000);
    await dedup.record('c-b', 'acc-1:XRPUSDT', 1_000);
    await dedup.forgetSymbol('acc-1:ETHBTC', 1_100);
    expect(await dedup.seenRecently('a-b', 'acc-1:ETHBTC', 1_200)).toBe(false); // forgotten
    expect(await dedup.seenRecently('c-b', 'acc-1:XRPUSDT', 1_200)).toBe(true); // untouched
  });

  it('consults Redis on a Map miss so a fresh process sees a prior placement (cross-process dedup)', async () => {
    const stub = makeSetRedisStub();
    const a = createPlacementDedup(undefined, { redis: stub.redis });
    await a.record(COID, SYM, 1_000);
    // A fresh process: new in-process Map, same durable Redis mirror.
    const b = createPlacementDedup(undefined, { redis: stub.redis });
    expect(await b.seenRecently(COID, SYM, 1_100)).toBe(true);
  });

  it('record mirrors the clientOrderId into the per-symbol Redis set via one atomic MULTI/EXEC', async () => {
    const stub = makeSetRedisStub();
    const dedup = createPlacementDedup(undefined, { redis: stub.redis });
    await dedup.record(COID, SYM, 1_000);
    // The write is a single MULTI/EXEC round-trip so the SET always carries a TTL.
    expect(stub.multi).toHaveBeenCalledOnce();
    expect(stub.sadd).toHaveBeenCalledWith(`placement-dedup:${SYM}`, COID);
    expect(stub.pexpire).toHaveBeenCalledWith(`placement-dedup:${SYM}`, PLACEMENT_DEDUP_WINDOW_MS);
    // Non-vacuous: the store actually gained the member (a TTL is set alongside it).
    expect(stub.store.get(`placement-dedup:${SYM}`)?.has(COID)).toBe(true);
  });

  it('forgetSymbol deletes the per-symbol Redis set so a re-entry is not suppressed', async () => {
    const stub = makeSetRedisStub();
    const a = createPlacementDedup(undefined, { redis: stub.redis });
    await a.record(COID, SYM, 1_000);
    await a.forgetSymbol(SYM, 1_200);
    expect(stub.del).toHaveBeenCalledWith(`placement-dedup:${SYM}`);
    // A fresh process re-entering after the close must not be suppressed.
    const b = createPlacementDedup(undefined, { redis: stub.redis });
    expect(await b.seenRecently(COID, SYM, 1_300)).toBe(false);
  });

  it('seenRecently fails OPEN when SISMEMBER rejects', async () => {
    const stub = makeSetRedisStub();
    stub.sismember.mockRejectedValue(new Error('ECONNREFUSED'));
    // Fresh Map so the lookup must reach Redis; a reject must not halt placement.
    const dedup = createPlacementDedup(undefined, { redis: stub.redis });
    expect(await dedup.seenRecently(COID, SYM, 1_000)).toBe(false);
  });

  it('seenRecently fails OPEN when SISMEMBER stalls past the timeout', async () => {
    const stub = makeSetRedisStub();
    stub.sismember.mockReturnValue(new Promise(() => {}) as never);
    const dedup = createPlacementDedup(undefined, { redis: stub.redis, setTimeoutMs: 10 });
    expect(await dedup.seenRecently(COID, SYM, 1_000)).toBe(false);
  });

  it('record never throws when SADD rejects (Map still records for same-instance dedup)', async () => {
    const stub = makeSetRedisStub();
    stub.sadd.mockRejectedValue(new Error('OOM'));
    const dedup = createPlacementDedup(undefined, { redis: stub.redis });
    await expect(dedup.record(COID, SYM, 1_000)).resolves.toBeUndefined();
    // Same-instance dedup still holds via the in-process Map (Map hit, no Redis).
    expect(await dedup.seenRecently(COID, SYM, 1_100)).toBe(true);
  });

  it('forgetSymbol never throws when DEL rejects', async () => {
    const stub = makeSetRedisStub();
    stub.del.mockRejectedValue(new Error('down'));
    const dedup = createPlacementDedup(undefined, { redis: stub.redis });
    await expect(dedup.forgetSymbol(SYM, 1_000)).resolves.toBeUndefined();
    expect(stub.del).toHaveBeenCalledWith(`placement-dedup:${SYM}`);
  });

  it('record never throws when the mirror command builder throws SYNCHRONOUSLY', async () => {
    // The other mirror-failure tests use a rejection or a stall, both of which the old
    // bare-promise call already handled. A client that throws before it can return a
    // promise — a destroyed connection, an argument the command builder refuses — is the
    // shape that used to escape the deadline guard entirely and fail the placement. NOT
    // async: an async wrapper would convert the throw into the rejection already covered.
    const stub = makeSetRedisStub();
    stub.multi.mockImplementation((): never => {
      throw new Error('Connection is closed');
    });
    const dedup = createPlacementDedup(undefined, { redis: stub.redis });
    await expect(dedup.record(COID, SYM, 1_000)).resolves.toBeUndefined();
    // The durable mirror is lost, but same-instance dedup still holds via the Map, which
    // is the whole reason a broken mirror is allowed to be best-effort.
    expect(await dedup.seenRecently(COID, SYM, 1_100)).toBe(true);
  });

  it('record never throws when the mirror EXEC stalls past the timeout', async () => {
    const stub = makeSetRedisStub();
    // The MULTI/EXEC never settles: raceDeadline must abandon it, not hang the tick.
    stub.multi.mockReturnValue({
      sadd: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: () => new Promise(() => {}),
    } as never);
    const dedup = createPlacementDedup(undefined, { redis: stub.redis, setTimeoutMs: 10 });
    await expect(dedup.record(COID, SYM, 1_000)).resolves.toBeUndefined();
    // Same-instance dedup still holds via the in-process Map even though the mirror stalled.
    expect(await dedup.seenRecently(COID, SYM, 1_100)).toBe(true);
  });
});
