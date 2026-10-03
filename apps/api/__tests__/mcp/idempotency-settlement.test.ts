// How a failed order-placing call settles its dedup key.
//
// The key is claimed before the call is dispatched, so a call that fails leaves a record behind describing an order that may or may not exist. Settling it wrongly is expensive in both directions: freeing a key whose order did reach the exchange invites a second real order, and holding a key whose call was refused before anything was armed locks the operator out of their own corrected retry for the rest of the window. This file pins the rule that decides between them, and the assumption that rule rests on.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { settlementForStatus } from '../../src/mcp/dispatch.js';
import {
  claimIdempotencyKey,
  idempotencyFingerprint,
  markIdempotencyAmbiguous,
  releaseIdempotencyKey,
  type IdempotencyRedis,
} from '../../src/mcp/idempotency.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** In-memory record with the `SET NX PX` and `DEL` semantics the settlement paths rely on. */
const fakeRedis = (seed: Record<string, string> = {}) => {
  const store = new Map<string, string>(Object.entries(seed));
  const redis = {
    store,
    set: vi.fn(async (key: string, value: string, _m: string, _t: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => keys.filter((key) => store.delete(key)).length),
    pexpire: vi.fn(async (key: string, _t: number) => (store.has(key) ? 1 : 0)),
  };
  return redis as typeof redis & IdempotencyRedis;
};

describe('settlement rule', () => {
  it('frees the key for every refusal a guard makes before anything is armed', () => {
    // The statuses the five order routes actually answer with when they decline: ownership and strategy-support 404, action-unsupported 422, entry-halt 409, argument validation 400.
    for (const status of [400, 404, 409, 422, 429, 499]) {
      expect(settlementForStatus(status)).toBe('release');
    }
  });

  it('holds the key for a failure that may already have armed an order', () => {
    // A 5xx from an order route is reached through an enqueue whose rollback did not take, which is exactly the case where the override may still be live.
    for (const status of [500, 502, 503, 504]) {
      expect(settlementForStatus(status)).toBe('ambiguous');
    }
  });

  it('splits at 500 and nowhere else', () => {
    // Pins the boundary itself. Without this the rule could be rewritten to release everything and the two sweeps above would still pass, since neither asserts where the change happens.
    expect(settlementForStatus(499)).toBe('release');
    expect(settlementForStatus(500)).toBe('ambiguous');
  });
});

describe('settlement effects on the record', () => {
  it('lets the corrected retry claim the key again after a release', async () => {
    // The operator-visible point of releasing. A first call is refused for a bad argument; the same key must then be usable, because the intent never reached the exchange and the agent has no other way to express "this same order, corrected".
    const redis = fakeRedis();
    const first = await claimIdempotencyKey(redis, 'k', 'fp-a');
    expect(first.status).toBe('claimed');
    await releaseIdempotencyKey(redis, 'k');
    const retry = await claimIdempotencyKey(redis, 'k', 'fp-a');
    expect(retry.status).toBe('claimed');
  });

  it('frees the fingerprint with the record, so a corrected retry with different arguments can claim the key', async () => {
    // The corrected retry is the likeliest caller after a release, and correcting an argument changes the fingerprint. A fingerprint left behind would refuse exactly that call as a mismatch.
    const redis = fakeRedis();
    await claimIdempotencyKey(redis, 'k', 'fp-refused');
    expect(redis.store.get('k:fp')).toBe('fp-refused');
    await releaseIdempotencyKey(redis, 'k');
    expect(redis.store.has('k')).toBe(false);
    expect(redis.store.has('k:fp')).toBe(false);
    expect((await claimIdempotencyKey(redis, 'k', 'fp-corrected')).status).toBe('claimed');
  });

  it('refuses the retry with a reconcile instruction after an ambiguous failure', async () => {
    // The opposite half. Marking must not free the key, or the ambiguity would be resolved by placing a second order.
    const redis = fakeRedis();
    await claimIdempotencyKey(redis, 'k', 'fp-a');
    await markIdempotencyAmbiguous(redis, 'k');
    const retry = await claimIdempotencyKey(redis, 'k', 'fp-a');
    expect(retry.status).toBe('ambiguous');
  });

  it('gives the claim back when the fingerprint cannot be written, so a retry of the same call is not told it is still running', async () => {
    // Nothing has been dispatched at this point. A claim left holding the in-flight sentinel would refuse every retry of this exact call for the whole window, about a call that never ran.
    const redis = fakeRedis();
    const plainSet = redis.set.getMockImplementation();
    redis.set.mockImplementation(async (key, value, mode, ttl, nx) => {
      if (key === 'k:fp') throw new Error('READONLY');
      return plainSet!(key, value, mode, ttl, nx);
    });
    await expect(claimIdempotencyKey(redis, 'k', 'fp-a')).rejects.toThrow('READONLY');
    expect(redis.store.has('k')).toBe(false);
  });

  it('keeps a recorded success replayable rather than releasable', async () => {
    // Guards the discriminating case: a settled success and a released refusal both leave a key that is not in flight, and only the recorded body tells them apart.
    const redis = fakeRedis({ k: '{"ok":true}' });
    const retry = await claimIdempotencyKey(redis, 'k', 'fp-a');
    expect(retry).toEqual({ status: 'replay', recorded: '{"ok":true}' });
  });
});

describe('request fingerprint', () => {
  it('is the same for the same arguments sent with their keys in a different order', () => {
    // A genuine retry is free to serialise its arguments in any order. A fingerprint that followed insertion order would refuse that retry as a different request, at every depth where an object appears.
    const a = idempotencyFingerprint({ a: 1, b: { x: '1', y: ['p', { m: 1, n: 2 }] } });
    const b = idempotencyFingerprint({ b: { y: ['p', { n: 2, m: 1 }], x: '1' }, a: 1 });
    expect(a).toBe(b);
  });

  it('differs when any argument value differs, and ignores the idempotency key itself', () => {
    // The discriminating half: a fingerprint that hashed nothing would satisfy the case above.
    const base = { symbol: 'BTCUSDT', side: 'BUY', quantity: '1' };
    expect(idempotencyFingerprint({ ...base, side: 'SELL' })).not.toBe(
      idempotencyFingerprint(base),
    );
    expect(idempotencyFingerprint({ ...base, idempotencyKey: 'k1' })).toBe(
      idempotencyFingerprint({ ...base, idempotencyKey: 'k2' }),
    );
  });
});

describe('the assumption the release half rests on', () => {
  it('has no order route answering 4xx after it has already taken effect', () => {
    // Releasing a key on any 4xx is only safe while no order route can refuse AFTER arming something. The repo already names that case: a handler sets `alreadyApplied` on its audit event to declare "this answered 4xx but it happened anyway", and two non-order routes use it. If an order route ever does, the release above becomes a double-order path, and the failure has to land here rather than in production.
    const source = readFileSync(join(SRC, 'routes', 'manual-orders.ts'), 'utf8');
    expect(source).not.toContain('alreadyApplied');
  });

  it('reads a file that really does define the order routes, so the check above is not vacuous', () => {
    // A guard that greps a file is worth exactly as much as its proof that the file is the right one. A moved or renamed route file would leave the assertion above passing over content that no longer decides anything.
    const source = readFileSync(join(SRC, 'routes', 'manual-orders.ts'), 'utf8');
    for (const route of [
      'manualOrderRoute',
      'manualOrderAllRoute',
      'triggerBuyRoute',
      'triggerSellRoute',
      'forceEjectRoute',
    ]) {
      expect(source).toContain(route);
    }
  });
});
