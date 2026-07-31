import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import {
  countWorkerMembers,
  listReadyMembers,
  MEMBER_KEY_PREFIX,
  parseFleetCount,
} from '../src/worker-members.js';

/**
 * Fake Redis covering the two commands `countWorkerMembers` uses. `scan` pages
 * `pageSize` keys at a time so the cursor loop is exercised for real; `mget`
 * returns the stored value or null (an expired key).
 */
const fakeRedis = (store: Record<string, string | null>, pageSize = 100): Redis => {
  const allKeys = Object.keys(store).filter((k) => k.startsWith(MEMBER_KEY_PREFIX));
  return {
    scan: (cursor: string) => {
      const start = Number(cursor);
      const page = allKeys.slice(start, start + pageSize);
      const next = start + pageSize >= allKeys.length ? '0' : String(start + pageSize);
      return Promise.resolve([next, page]);
    },
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store[k] ?? null)),
  } as unknown as Redis;
};

/** Fake whose SCAN returns `pages` verbatim — used to inject duplicate keys. */
const scriptedRedis = (pages: string[][], store: Record<string, string>): Redis => {
  let i = 0;
  return {
    scan: () => {
      const page = pages[i] ?? [];
      i += 1;
      const next = i >= pages.length ? '0' : String(i);
      return Promise.resolve([next, page]);
    },
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store[k] ?? null)),
  } as unknown as Redis;
};

const member = (id: string, ready: boolean): string =>
  JSON.stringify({ id, sha: 'abc', bootedAt: '2026-07-08T00:00:00.000Z', ready });

describe('countWorkerMembers', () => {
  it('returns 0/0 when no members are registered', async () => {
    expect(await countWorkerMembers(fakeRedis({}))).toEqual({ total: 0, ready: 0 });
  });

  it('counts total members and the ready subset', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}b`]: member('b', false),
      [`${MEMBER_KEY_PREFIX}c`]: member('c', true),
    };
    expect(await countWorkerMembers(fakeRedis(store))).toEqual({ total: 3, ready: 2 });
  });

  it('pages through the cursor for large fleets', async () => {
    const store: Record<string, string> = {};
    for (let i = 0; i < 250; i += 1) store[`${MEMBER_KEY_PREFIX}${i}`] = member(String(i), i < 100);
    // pageSize 100 → 3 SCAN pages.
    expect(await countWorkerMembers(fakeRedis(store, 100))).toEqual({ total: 250, ready: 100 });
  });

  it('de-duplicates keys SCAN returns more than once (rehash)', async () => {
    // SCAN is allowed to return the same key across pages; the count must not
    // double it. `a` appears on both pages.
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}b`]: member('b', false),
    };
    const redis = scriptedRedis(
      [[`${MEMBER_KEY_PREFIX}a`, `${MEMBER_KEY_PREFIX}b`], [`${MEMBER_KEY_PREFIX}a`]],
      store,
    );
    expect(await countWorkerMembers(redis)).toEqual({ total: 2, ready: 1 });
  });

  it('ignores a key that expired between SCAN and MGET', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}gone`]: null, // present at SCAN, gone at MGET
    };
    expect(await countWorkerMembers(fakeRedis(store))).toEqual({ total: 1, ready: 1 });
  });

  it('counts a malformed record as live but not ready', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}bad`]: 'not json',
    };
    expect(await countWorkerMembers(fakeRedis(store))).toEqual({ total: 2, ready: 1 });
  });
});

describe('listReadyMembers', () => {
  it('returns [] when no members are registered', async () => {
    expect(await listReadyMembers(fakeRedis({}))).toEqual([]);
  });

  it('returns only the ids of ready members', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}b`]: member('b', false),
      [`${MEMBER_KEY_PREFIX}c`]: member('c', true),
    };
    expect((await listReadyMembers(fakeRedis(store))).slice().sort()).toEqual(['a', 'c']);
  });

  it('de-duplicates a key SCAN returns twice (rehash)', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}b`]: member('b', true),
    };
    const redis = scriptedRedis(
      [[`${MEMBER_KEY_PREFIX}a`, `${MEMBER_KEY_PREFIX}b`], [`${MEMBER_KEY_PREFIX}a`]],
      store,
    );
    expect((await listReadyMembers(redis)).slice().sort()).toEqual(['a', 'b']);
  });

  it('skips an expired, malformed, or id-less record', async () => {
    const store = {
      [`${MEMBER_KEY_PREFIX}a`]: member('a', true),
      [`${MEMBER_KEY_PREFIX}gone`]: null, // expired between SCAN and MGET
      [`${MEMBER_KEY_PREFIX}bad`]: 'not json', // malformed → not eligible
      [`${MEMBER_KEY_PREFIX}noid`]: JSON.stringify({ ready: true }), // ready but no id
    };
    expect(await listReadyMembers(fakeRedis(store))).toEqual(['a']);
  });
});

describe('parseFleetCount', () => {
  it('parses a published count', () => {
    expect(parseFleetCount(JSON.stringify({ total: 3, ready: 2 }))).toEqual({ total: 3, ready: 2 });
  });

  it('degrades absent to zero', () => {
    expect(parseFleetCount(null)).toEqual({ total: 0, ready: 0 });
  });

  it('degrades malformed to zero', () => {
    expect(parseFleetCount('not json')).toEqual({ total: 0, ready: 0 });
  });

  it('defaults missing fields to zero', () => {
    expect(parseFleetCount(JSON.stringify({ total: 5 }))).toEqual({ total: 5, ready: 0 });
  });
});
