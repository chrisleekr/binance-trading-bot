// Contract for the account-snapshot-safety storage helpers. The exact
// `account-info` shape matters: the tick's `parseAccountSnapshot` reads
// `{ balances: { ASSET: { free, locked } } }`, so a drift here would
// silently feed the strategy an empty account.

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId } from '@app/contracts';

import { createAccountSnapshotStore } from '../../src/crons/account-snapshot.js';
import { parseAccountSnapshot } from '../../src/tick/snapshot-loader.js';
import { Decimal } from '@app/money';

const a = asAccountId('u1');
const p = asProfileId('p1');

describe('createAccountSnapshotStore — persistAccount', () => {
  it('writes account-info in the shape the tick snapshot-loader parses back', async () => {
    let written: string | null = null;
    const redis = {
      set: vi.fn(async (_key: string, value: string) => {
        written = value;
        return 'OK';
      }),
      get: vi.fn(async () => null),
    } as unknown as Redis;

    await createAccountSnapshotStore(redis).persistAccount(a, p, [
      { asset: 'BTC', free: '0.5', locked: '0.1' },
      { asset: 'USDT', free: '100', locked: '0' },
    ]);

    // Round-trips through the same parser the tick uses.
    expect(parseAccountSnapshot(written)).toEqual({
      balances: {
        BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal('0.1') },
        USDT: { asset: 'USDT', free: new Decimal('100'), locked: new Decimal('0') },
      },
      readable: true,
    });
  });

  it('parseAccountSnapshot degrades to an empty snapshot on missing or malformed input', () => {
    // The tick cold-loads from Binance when the snapshot is empty, so a
    // null / non-JSON / schema-invalid key must degrade rather than throw.
    expect(parseAccountSnapshot(null)).toEqual({ balances: {}, readable: false });
    expect(parseAccountSnapshot('not-json')).toEqual({ balances: {}, readable: false });
    expect(parseAccountSnapshot('{"balances":{"BTC":{"free":1,"locked":0}}}')).toEqual({
      balances: {},
      readable: false,
    });
  });

  it('writes the account-info key with a bounded TTL', async () => {
    const set = vi.fn(
      async (_key: string, _value: string, _mode: 'EX', _ttl: number) => 'OK' as const,
    );
    const redis = { set, get: vi.fn(async () => null) } as unknown as Redis;

    await createAccountSnapshotStore(redis).persistAccount(a, p, []);

    const call = set.mock.calls[0] ?? [];
    expect(call[0]).toBe('tenant:u1:profile:p1:account-info');
    expect(call[2]).toBe('EX');
    expect(call[3]).toBe(35);
  });
});

describe('createAccountSnapshotStore — mergeAccount', () => {
  it('merges the delta into the existing snapshot, leaving unchanged assets intact', async () => {
    // Regression: outboundAccountPosition carries only the changed asset(s).
    // Overwriting would blank BTC (still held) and read its free balance as 0,
    // cancelling its protective stop. Merge must keep BTC and patch USDT.
    let written: string | null = null;
    const redis = {
      get: vi.fn(async () =>
        JSON.stringify({
          balances: { BTC: { free: '0.5', locked: '0.1' }, USDT: { free: '100', locked: '0' } },
        }),
      ),
      set: vi.fn(async (_key: string, value: string) => {
        written = value;
        return 'OK';
      }),
    } as unknown as Redis;

    await createAccountSnapshotStore(redis).mergeAccount(a, p, [
      { asset: 'USDT', free: '42', locked: '5' },
    ]);

    expect(parseAccountSnapshot(written)).toEqual({
      balances: {
        BTC: { asset: 'BTC', free: new Decimal('0.5'), locked: new Decimal('0.1') },
        USDT: { asset: 'USDT', free: new Decimal('42'), locked: new Decimal('5') },
      },
      readable: true,
    });
  });

  it('zeroes a sold-out asset rather than keeping its stale balance', async () => {
    // A fully-sold position arrives as f=0,l=0 in the delta (it is in the
    // changed set, not absent). Merge must overwrite the prior non-zero
    // balance with zero, else the bot would think it still holds the position.
    let written: string | null = null;
    const redis = {
      get: vi.fn(async () =>
        JSON.stringify({ balances: { TAO: { free: '0.0545', locked: '0' } } }),
      ),
      set: vi.fn(async (_key: string, value: string) => {
        written = value;
        return 'OK';
      }),
    } as unknown as Redis;

    await createAccountSnapshotStore(redis).mergeAccount(a, p, [
      { asset: 'TAO', free: '0', locked: '0' },
    ]);

    expect(parseAccountSnapshot(written)).toEqual({
      balances: { TAO: { asset: 'TAO', free: new Decimal('0'), locked: new Decimal('0') } },
      readable: true,
    });
  });

  it('writes the merged key with the same bounded TTL', async () => {
    const set = vi.fn(
      async (_key: string, _value: string, _mode: 'EX', _ttl: number) => 'OK' as const,
    );
    const redis = {
      get: vi.fn(async () => JSON.stringify({ balances: { BTC: { free: '1', locked: '0' } } })),
      set,
    } as unknown as Redis;

    await createAccountSnapshotStore(redis).mergeAccount(a, p, []);

    const call = set.mock.calls[0] ?? [];
    expect(call[0]).toBe('tenant:u1:profile:p1:account-info');
    expect(call[2]).toBe('EX');
    expect(call[3]).toBe(35);
  });
});

// A delta-only write produces a POPULATED but TRUNCATED snapshot, and the tick
// reads an asset absent from a populated map as a hard zero. So writing the delta
// alone tells the strategy "you hold nothing but this one asset" — blanking every
// real position and suppressing its exits — and, worse, `accountInfoExists` then
// reports true, so the safety cron skips the REST refresh that would rebuild the
// truth. Writing nothing keeps the snapshot UNREADABLE (an honest "we do not
// know"), which the sizing paths fail open on and the cron repairs.
describe('createAccountSnapshotStore — mergeAccount refuses to write a truncated snapshot', () => {
  const storeOver = (existing: string | null) => {
    const set = vi.fn(
      async (_key: string, _value: string, _mode: 'EX', _ttl: number) => 'OK' as const,
    );
    const store = createAccountSnapshotStore({
      get: vi.fn(async () => existing),
      set,
    } as unknown as Redis);
    return { set, store };
  };

  it('does not write when no snapshot exists yet (cold cache)', async () => {
    const { set, store } = storeOver(null);
    await store.mergeAccount(a, p, [{ asset: 'BTC', free: '1', locked: '0' }]);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not write when the existing snapshot is malformed JSON', async () => {
    const { set, store } = storeOver('not-json');
    await store.mergeAccount(a, p, [{ asset: 'ETH', free: '2', locked: '0' }]);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not write when the existing snapshot has a non-object balances shape', async () => {
    const { set, store } = storeOver(JSON.stringify({ balances: [] }));
    await store.mergeAccount(a, p, [{ asset: 'ADA', free: '3', locked: '0' }]);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not write when the existing snapshot has no balances key at all', async () => {
    const { set, store } = storeOver(JSON.stringify({ somethingElse: 1 }));
    await store.mergeAccount(a, p, [{ asset: 'ADA', free: '3', locked: '0' }]);
    expect(set).not.toHaveBeenCalled();
  });

  it('merges normally into a usable existing snapshot', async () => {
    const { set, store } = storeOver(
      JSON.stringify({ balances: { BTC: { free: '1', locked: '0' } } }),
    );
    await store.mergeAccount(a, p, [{ asset: 'USDT', free: '9', locked: '0' }]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(parseAccountSnapshot(set.mock.calls[0]?.[1] as unknown as string)).toEqual({
      balances: {
        BTC: { asset: 'BTC', free: new Decimal('1'), locked: new Decimal('0') },
        USDT: { asset: 'USDT', free: new Decimal('9'), locked: new Decimal('0') },
      },
      readable: true,
    });
  });
});

describe('createAccountSnapshotStore — lastWsEventMs', () => {
  const storeWith = (raw: string | null): ReturnType<typeof createAccountSnapshotStore> =>
    createAccountSnapshotStore({
      set: vi.fn(async () => 'OK'),
      get: vi.fn(async () => raw),
    } as unknown as Redis);

  it('returns the stamped epoch-ms when the marker is present', async () => {
    expect(await storeWith('1700000000000').lastWsEventMs(a, p)).toBe(1_700_000_000_000);
  });

  it('returns null when the marker is absent', async () => {
    expect(await storeWith(null).lastWsEventMs(a, p)).toBeNull();
  });

  it('returns null when the marker is non-numeric (corrupt key)', async () => {
    expect(await storeWith('not-a-number').lastWsEventMs(a, p)).toBeNull();
  });
});

describe('createAccountSnapshotStore — accountInfoExists', () => {
  const storeWithExists = (n: number): ReturnType<typeof createAccountSnapshotStore> =>
    createAccountSnapshotStore({
      set: vi.fn(async () => 'OK'),
      get: vi.fn(async () => null),
      exists: vi.fn(async () => n),
    } as unknown as Redis);

  it('checks presence of the account-info key', async () => {
    const exists = vi.fn(async (_key: string) => 1);
    await createAccountSnapshotStore({ exists } as unknown as Redis).accountInfoExists(a, p);
    expect(exists).toHaveBeenCalledWith('tenant:u1:profile:p1:account-info');
  });

  it('returns true when the key exists', async () => {
    expect(await storeWithExists(1).accountInfoExists(a, p)).toBe(true);
  });

  it('returns false when the key is absent (expired)', async () => {
    expect(await storeWithExists(0).accountInfoExists(a, p)).toBe(false);
  });
});
