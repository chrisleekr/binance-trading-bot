import { asAccountId, asProfileId, asUserId, type ManualOverridePayload } from '@app/contracts';
import { GLOBAL_KEYS, type ProfileRepo } from '@app/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DI } from '../../src/di.js';
import {
  balanceQuantityForSymbol,
  writeOverrideAndEnqueue,
  runOverrideOrRollbackDb,
  OverrideRollbackError,
} from '../../src/lib/manual-orders.js';
import { errorMessage } from '@app/core/error';

const U = asUserId('00000000-0000-0000-0000-000000000001');
const A = asAccountId('00000000-0000-0000-0000-0000000000a1');
const P = asProfileId('00000000-0000-0000-0000-000000000002');
const ACTION_ID = '00000000-0000-0000-0000-0000000000aa';

// The lib helpers now receive an already-resolved ProfileScope repo (they no
// longer re-call `profileRepo`), so the test passes a fake bound repo carrying
// the scope ids plus the two repo methods the helpers touch:
// `runOverrideOrRollbackDb` → overrideActions.settle; the ledger fallback
// in `balanceQuantityForSymbol` → avgEntryPrices.findBySymbol (defaults to "no
// ledger row"; individual tests set its return for the fallback path).
const settleMock = vi.fn();
const findBySymbolMock = vi.fn(async () => null as { quantity: string } | null);
const fakeP = {
  scope: { operatorId: U, accountId: A, profileId: P },
  overrideActions: { settle: settleMock },
  avgEntryPrices: { findBySymbol: findBySymbolMock },
} as unknown as ProfileRepo;

const ACC_KEY = `tenant:${A}:profile:${P}:account-info`;
// `symbol-info` is exchange-wide: the worker writes the global
// `binance:symbol-info:<S>` key, with no tenant prefix. Derived from the
// catalogue so the stub cannot drift from the key the code actually reads.
const SYM_KEY = GLOBAL_KEYS.symbolInfo('BTCUSDT');

/** Stubs Redis with an in-memory map so balance-read tests stay deterministic
 * and never touch a real Redis. */
const makeReadDi = (store: Record<string, string>): DI =>
  ({
    redis: { raw: () => ({ get: async (key: string) => store[key] ?? null }) },
  }) as unknown as DI;

const accountInfo = (free: string, locked: string): string =>
  JSON.stringify({ balances: { BTC: { free, locked } } });
const symbolInfo = JSON.stringify({ baseAsset: 'BTC' });

describe('balanceQuantityForSymbol', () => {
  beforeEach(() => {
    findBySymbolMock.mockReset();
    findBySymbolMock.mockResolvedValue(null);
  });

  it('returns free + locked as a decimal quantity, not a 1e18-scaled integer', async () => {
    const di = makeReadDi({ [ACC_KEY]: accountInfo('1.5', '0.5'), [SYM_KEY]: symbolInfo });
    expect(await balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).toBe('2');
  });

  it('sums with decimal.js precision (no IEEE-754 drift)', async () => {
    const di = makeReadDi({ [ACC_KEY]: accountInfo('0.1', '0.2'), [SYM_KEY]: symbolInfo });
    expect(await balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).toBe('0.3');
  });

  it('falls back to the avg_entry_prices ledger quantity when account-info is absent', async () => {
    // Disabled / just-adopted profile: the worker never wrote the
    // profile-scoped account-info snapshot, but a ledger row exists (adopt
    // reconstructed it). The operator is correcting the PRICE, so the
    // ledger quantity is a safe, plugin-agnostic size source.
    findBySymbolMock.mockResolvedValue({ quantity: '12.5' });
    const di = makeReadDi({}); // no account-info, no symbol-info needed on this path
    expect(await balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).toBe('12.5');
  });

  it('throws UPSTREAM_FAILED when account-info is absent and no ledger row exists', async () => {
    findBySymbolMock.mockResolvedValue(null);
    const di = makeReadDi({ [SYM_KEY]: symbolInfo });
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
      message: expect.stringContaining('enable'),
    });
  });

  it('throws UPSTREAM_FAILED when account-info is absent and the ledger row quantity is 0', async () => {
    // A zero-quantity ledger row is a documented "price marker" treated as
    // flat everywhere (`quantity > 0`). Reusing it would size the operator's
    // avg-entry-price write to 0 and make it a silent no-op, so it must be
    // treated as no row and 502 with the "enable" guidance instead.
    findBySymbolMock.mockResolvedValue({ quantity: '0' });
    const di = makeReadDi({});
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
      message: expect.stringContaining('enable'),
    });
  });

  it('throws UPSTREAM_FAILED when account-info is present but symbol-info is absent', async () => {
    // account-info exists (enabled profile) so the ledger fallback is not
    // taken; the global symbol-info key has not been snapshot yet, so base-
    // asset resolution cannot proceed and the read 502s.
    const di = makeReadDi({ [ACC_KEY]: accountInfo('1', '0') });
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
      message: expect.stringContaining('symbol info'),
    });
  });

  it('throws UPSTREAM_FAILED on malformed snapshot JSON, forwarding the cause', async () => {
    const di = makeReadDi({ [ACC_KEY]: 'not-json', [SYM_KEY]: symbolInfo });
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
      details: expect.anything(),
    });
  });

  it('throws UPSTREAM_FAILED when the base asset has no balance entry', async () => {
    const di = makeReadDi({
      [ACC_KEY]: JSON.stringify({ balances: { ETH: { free: '1', locked: '0' } } }),
      [SYM_KEY]: symbolInfo,
    });
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
    });
  });

  it('throws UPSTREAM_FAILED when a balance amount is unparseable, forwarding the cause', async () => {
    const di = makeReadDi({ [ACC_KEY]: accountInfo('abc', '0'), [SYM_KEY]: symbolInfo });
    await expect(balanceQuantityForSymbol(di, fakeP, 'BTCUSDT')).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED',
      details: expect.anything(),
    });
  });
});

const PAYLOAD: ManualOverridePayload = { kind: 'trigger-buy', overrideActionId: ACTION_ID };

/** Stubs the override path's Redis ops + tick queue so each failure-mode
 * branch can be driven without a real broker. */
const makeOverrideDi = (): {
  di: DI;
  ops: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  tickAdd: ReturnType<typeof vi.fn>;
  loggerError: ReturnType<typeof vi.fn>;
} => {
  const ops = {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  };
  const tickAdd = vi.fn().mockResolvedValue(undefined);
  const loggerError = vi.fn();
  const di = {
    redis: { forProfile: () => ops },
    tickQueue: { add: tickAdd },
    db: {},
    logger: { warn: vi.fn(), error: loggerError },
  } as unknown as DI;
  return { di, ops, tickAdd, loggerError };
};

describe('writeOverrideAndEnqueue', () => {
  it('writes the override then enqueues the tick; no rollback on success', async () => {
    const { di, ops, tickAdd } = makeOverrideDi();
    await writeOverrideAndEnqueue(di, fakeP, 'BTCUSDT', PAYLOAD);
    expect(ops.set).toHaveBeenCalledOnce();
    expect(tickAdd).toHaveBeenCalledOnce();
    expect(ops.del).not.toHaveBeenCalled();
  });

  it('rolls the override back and rethrows the original error when enqueue fails', async () => {
    const { di, ops, tickAdd } = makeOverrideDi();
    tickAdd.mockRejectedValueOnce(new Error('queue down'));
    ops.get.mockResolvedValueOnce(JSON.stringify({ overrideActionId: ACTION_ID }));
    await expect(writeOverrideAndEnqueue(di, fakeP, 'BTCUSDT', PAYLOAD)).rejects.toThrow(
      'queue down',
    );
    expect(ops.del).toHaveBeenCalledOnce();
  });

  it('leaves a newer override in place and rethrows the original error', async () => {
    const { di, ops, tickAdd } = makeOverrideDi();
    tickAdd.mockRejectedValueOnce(new Error('queue down'));
    ops.get.mockResolvedValueOnce(JSON.stringify({ overrideActionId: 'a-newer-action' }));
    await expect(writeOverrideAndEnqueue(di, fakeP, 'BTCUSDT', PAYLOAD)).rejects.toThrow(
      'queue down',
    );
    expect(ops.del).not.toHaveBeenCalled();
  });

  it('throws OverrideRollbackError carrying the rollback failure as cause', async () => {
    const { di, ops, tickAdd } = makeOverrideDi();
    tickAdd.mockRejectedValueOnce(new Error('queue down'));
    ops.get.mockResolvedValueOnce(JSON.stringify({ overrideActionId: ACTION_ID }));
    ops.del.mockRejectedValueOnce(new Error('redis down'));
    const err = await writeOverrideAndEnqueue(di, fakeP, 'BTCUSDT', PAYLOAD).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OverrideRollbackError);
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({ message: 'redis down' });
    // Root-cause enqueue failure is preserved in the message.
    expect(errorMessage(err)).toContain('queue down');
  });
});

describe('runOverrideOrRollbackDb', () => {
  beforeEach(() => {
    settleMock.mockReset();
  });

  it('runs the body and never settles the row on success', async () => {
    const { di } = makeOverrideDi();
    await runOverrideOrRollbackDb(di, fakeP, ACTION_ID, async () => undefined);
    expect(settleMock).not.toHaveBeenCalled();
  });

  it('settles the row REJECTED (not merely consumed) and rethrows when the body fails', async () => {
    // A row closed out with no outcome reads on the symbol page exactly like one
    // that succeeded. The operator's action never started, so the row must say so.
    const { di } = makeOverrideDi();
    await expect(
      runOverrideOrRollbackDb(di, fakeP, ACTION_ID, async () => {
        throw new Error('enqueue failed');
      }),
    ).rejects.toThrow('enqueue failed');
    expect(settleMock).toHaveBeenCalledOnce();
    expect(settleMock).toHaveBeenCalledWith(ACTION_ID, {
      status: 'rejected',
      reason: expect.any(String) as unknown as string,
    });
  });

  it('leaves the row pending (no settle) and logs when rollback failed', async () => {
    const { di, loggerError } = makeOverrideDi();
    await expect(
      runOverrideOrRollbackDb(di, fakeP, ACTION_ID, async () => {
        throw new OverrideRollbackError('rollback failed');
      }),
    ).rejects.toBeInstanceOf(OverrideRollbackError);
    expect(settleMock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledOnce();
  });
});
