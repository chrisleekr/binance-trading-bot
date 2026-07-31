import { describe, expect, it, vi } from 'vitest';
import { persistSnapshotBestEffort } from '../../../src/crons/discovery/snapshot.js';

describe('persistSnapshotBestEffort (#436)', () => {
  const snapshot = {
    universe: [],
    shortlist: [],
    add: [],
    remove: [],
    desired: [],
    configDigest: {
      quoteAsset: 'USDT',
      maxAutoSymbols: 5,
      changeMinPercent: '5',
      rankTopPercent: 30,
      rankExcludeTopPercent: 5,
      marketBreadthMinPercent: '0',
    },
  } as never;

  it('writes and does not warn on success', async () => {
    const warn = vi.fn();
    const record = vi.fn(async () => undefined);
    await persistSnapshotBestEffort(record, { warn } as never, 'p1', snapshot);
    expect(record).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a write failure: warns once and the promise still resolves', async () => {
    const warn = vi.fn();
    const record = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      persistSnapshotBestEffort(record, { warn } as never, 'p1', snapshot),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
