import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@app/strategy-core';
import { setKvHandler } from '../../../src/executor/decisions/set-kv.js';
import { deleteKvHandler } from '../../../src/executor/decisions/delete-kv.js';
import type { DecisionDeps } from '../../../src/executor/decisions/_types.js';

const CTX = {
  userId: '11111111-1111-1111-1111-111111111111',
  profileId: '22222222-2222-2222-2222-222222222222',
  clock: { nowMs: () => 1_700_000_000_000 },
  strategyName: 'stub',
} as unknown as ExecutorContext;

const fakeDeps = (persistence: {
  setKv?: unknown;
  deleteKv?: unknown;
}): { deps: DecisionDeps; logErr: ReturnType<typeof vi.fn> } => {
  const logErr = vi.fn();
  const deps = {
    logger: { error: logErr, warn: vi.fn(), info: vi.fn() },
    resolveProfile: vi.fn(async () => ({ persistence })),
  } as unknown as DecisionDeps;
  return { deps, logErr };
};

describe('setKvHandler', () => {
  it('persists the key/value through the bound persistence', async () => {
    const setKv = vi.fn(async () => undefined);
    const { deps } = fakeDeps({ setKv });
    const result = await setKvHandler(deps, CTX, {
      type: 'set-kv',
      key: 'rebalance:value:BTCUSDT',
      value: { quote: '1234.5' },
    });
    expect(result).toEqual({ ok: true });
    expect(setKv).toHaveBeenCalledWith('rebalance:value:BTCUSDT', { quote: '1234.5' });
  });

  it('fails non-retryable and logs when the persist throws', async () => {
    const setKv = vi.fn(async () => {
      throw new Error('db down');
    });
    const { deps, logErr } = fakeDeps({ setKv });
    const result = await setKvHandler(deps, CTX, { type: 'set-kv', key: 'k', value: 1 });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect((result as { reason: string }).reason).toMatch(/set-kv "k": db down/);
    expect(logErr).toHaveBeenCalledTimes(1);
  });
});

describe('deleteKvHandler', () => {
  it('removes the key through the bound persistence (idempotent success)', async () => {
    const deleteKv = vi.fn(async () => undefined);
    const { deps } = fakeDeps({ deleteKv });
    const result = await deleteKvHandler(deps, CTX, { type: 'delete-kv', key: 'k' });
    expect(result).toEqual({ ok: true });
    expect(deleteKv).toHaveBeenCalledWith('k');
  });

  it('fails non-retryable and logs when the delete throws', async () => {
    const deleteKv = vi.fn(async () => {
      throw new Error('db down');
    });
    const { deps, logErr } = fakeDeps({ deleteKv });
    const result = await deleteKvHandler(deps, CTX, { type: 'delete-kv', key: 'k' });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(logErr).toHaveBeenCalledTimes(1);
  });
});
