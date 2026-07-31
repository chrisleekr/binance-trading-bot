import { describe, expect, it } from 'vitest';

import { buildChain } from '../../../src/boot/builders/chain.js';
import { buildReconcile } from '../../../src/boot/builders/reconcile.js';
import { fakeDb, fakeRedis, silentLogger } from './fakes.js';

describe('buildReconcile', () => {
  it('threads the SHARED chain and persisters into the reconcile dep bags', () => {
    const chain = buildChain();
    const persistSymbolState = async (): Promise<boolean> => true;
    const persistProfileState = async (): Promise<void> => undefined;

    const { symbolStateDeps, reconcileDeps } = buildReconcile({
      db: fakeDb(),
      redis: fakeRedis(),
      logger: silentLogger(),
      chain,
      profileManager: { listActive: () => [] } as never,
      resolveBinanceClient: async () => null,
      persistSymbolState,
      persistProfileState,
    });

    // The single-chain invariant: reconcileDeps must carry the passed instance,
    // not a fresh one, or the reconcile stops serialising against the tick.
    expect(reconcileDeps.chain).toBe(chain);
    expect(reconcileDeps.persistMigratedState).toBe(persistProfileState);
    expect(symbolStateDeps.persistSymbolState).toBe(persistSymbolState);
    // The shared symbolStateDeps is the same object handed to the reconcile bag.
    expect(reconcileDeps.symbolStateDeps).toBe(symbolStateDeps);
  });
});
