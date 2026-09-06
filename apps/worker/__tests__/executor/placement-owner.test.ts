import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId } from '@app/contracts';

import { createPlacementOwner } from '../../src/executor/placement-owner.js';
import { buildPlacementOwnerKey } from '../../src/executor/redis-namespace.js';

const logger = pino({ level: 'silent' });
const ACCOUNT = asAccountId('a1');
const PROFILE = asProfileId('p1');
const CLIENT_ORDER_ID = 'tt-buy-1';
const KEY = buildPlacementOwnerKey(ACCOUNT, CLIENT_ORDER_ID);

// A promise that never settles, standing in for a reachable-but-stalled Redis — the shape that
// has no timeout of its own (`maxRetriesPerRequest: null`, no command timeout) and would
// otherwise hang the caller.
const stalls = () => new Promise<never>(() => undefined);

describe('placement-owner marker', () => {
  it('writes the placing profile under the catalogued key with a TTL in the same command', async () => {
    const set = vi.fn(() => Promise.resolve('OK'));
    await createPlacementOwner({ redis: { set } as unknown as Redis, logger }).register(
      ACCOUNT,
      PROFILE,
      CLIENT_ORDER_ID,
    );
    // PX in the same SET: a marker that could exist without an expiry would permanently
    // attribute a clientOrderId the strategy legitimately reuses later.
    expect(set).toHaveBeenCalledWith(KEY, 'p1', 'PX', 300_000);
  });

  it('reads the catalogued key and returns the stored profile id', async () => {
    const redis = { get: vi.fn(() => Promise.resolve('p1')) } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).ownerOf(ACCOUNT, CLIENT_ORDER_ID),
    ).resolves.toBe('p1');
    expect(redis.get).toHaveBeenCalledWith(KEY);
  });

  it('answers null when no marker exists', async () => {
    const redis = { get: () => Promise.resolve(null) } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).ownerOf(ACCOUNT, CLIENT_ORDER_ID),
    ).resolves.toBeNull();
  });

  // Fail-open read: the gate keeps every other piece of evidence, so a Redis fault costs the
  // placement window this module closes and nothing more.
  it('answers null when the read rejects', async () => {
    const redis = { get: () => Promise.reject(new Error('CONNRESET')) } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).ownerOf(ACCOUNT, CLIENT_ORDER_ID),
    ).resolves.toBeNull();
  });

  // `register` already pins the synchronous-throw case; `ownerOf` needs its own because the two use different machinery — `raceDeadline` guards the write by construction, while this read's `get` is only guarded by sitting inside the `try`. Hoisting it out would flip fail-open to fail-closed and reject the gate's whole lookup into its drop arm.
  it('answers null when the client throws synchronously on the read', async () => {
    const redis = {
      get: () => {
        throw new Error('connection is closed');
      },
    } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).ownerOf(ACCOUNT, CLIENT_ORDER_ID),
    ).resolves.toBeNull();
  });

  // The keyspace is keyed by clientOrderId, so a value that is CONSTANT across distinct orders — or one Binance would never have issued — puts every order of that shape under one key and lets the marker name a single profile as the owner of all of them, which is the exact defect this module exists to fix. Refused without a lookup, so the gate falls back to its pre-marker verdict.
  //
  // The other half lives in `parseUserStreamFrame`, which now reads `c` as a string or not at all, so a non-string scalar can no longer arrive here already coerced into a legal-looking id. This predicate covers what a frame can still legitimately carry: an omitted `c` (`''`), an over-length id, characters the grammar forbids — and it keeps holding whatever a future producer does.
  it.each([[''], ['[object Object]'], ['a'.repeat(37)], ['bad id'], ['x\ny']])(
    'refuses %j as a marker key without touching redis',
    async (clientOrderId) => {
      const get = vi.fn(() => Promise.resolve('p1'));
      await expect(
        createPlacementOwner({ redis: { get } as unknown as Redis, logger }).ownerOf(
          ACCOUNT,
          clientOrderId,
        ),
      ).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
    },
  );

  // The accept direction, previously unpinned: only the refusals were tested, so a narrowing of the class would have gone unnoticed. `_` is the one that matters most — it is in the class Binance publishes for FIX, and Binance's own web-UI ids use it, so dropping it would silently lose the marker for every hand-placed order.
  it.each([['tt-1a2b3c4d-b'], ['web_4f3a'], ['x.y:z/w'], ['a'.repeat(36)]])(
    'accepts %j as a marker key',
    async (clientOrderId) => {
      const get = vi.fn(() => Promise.resolve('p1'));
      await expect(
        createPlacementOwner({ redis: { get } as unknown as Redis, logger }).ownerOf(
          ACCOUNT,
          clientOrderId,
        ),
      ).resolves.toBe('p1');
      expect(get).toHaveBeenCalledWith(buildPlacementOwnerKey(ACCOUNT, clientOrderId));
    },
  );

  // A marker the READER would refuse is worse than no marker: the key exists, nothing can answer from it, and the gate reads as armed while it is not. Unreachable today (every builder conforms) but `assertClientOrderId` checks length only, never the character class.
  it('refuses to write a marker the read side could never use, and says so', async () => {
    const set = vi.fn(() => Promise.resolve('OK'));
    const warn = vi.fn();
    await createPlacementOwner({
      redis: { set } as unknown as Redis,
      logger: { ...logger, warn } as unknown as typeof logger,
    }).register(ACCOUNT, PROFILE, 'bad id');

    expect(set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('answers null instead of hanging when the read stalls', async () => {
    const redis = { get: stalls } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger, redisTimeoutMs: 5 }).ownerOf(ACCOUNT, CLIENT_ORDER_ID),
    ).resolves.toBeNull();
  });

  // Never-throw write: `register` is awaited on the placement path, so a rejection or a stall
  // here would strand an order the operator's strategy asked for.
  it('resolves when the write rejects, so the placement still goes out', async () => {
    const redis = { set: () => Promise.reject(new Error('READONLY')) } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).register(ACCOUNT, PROFILE, CLIENT_ORDER_ID),
    ).resolves.toBeUndefined();
  });

  it('resolves when the write stalls, so the placement is not held behind Redis', async () => {
    const redis = { set: stalls } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger, redisTimeoutMs: 5 }).register(
        ACCOUNT,
        PROFILE,
        CLIENT_ORDER_ID,
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves when the client throws synchronously', async () => {
    const redis = {
      set: () => {
        throw new Error('connection is closed');
      },
    } as unknown as Redis;
    await expect(
      createPlacementOwner({ redis, logger }).register(ACCOUNT, PROFILE, CLIENT_ORDER_ID),
    ).resolves.toBeUndefined();
  });
});
