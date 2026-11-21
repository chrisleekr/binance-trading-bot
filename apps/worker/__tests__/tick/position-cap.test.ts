// The split is pure, so each branch is pinned directly. The lease is pinned by behaviour: a second holder waits until the first releases, and releasing twice is harmless.

import { describe, expect, it } from 'vitest';
import type { Decision } from '@app/strategy-core';

import { createChainByKey } from '../../src/lib/chain-by-key.js';
import { acquireLease, applyPositionCap, positionCapKey } from '../../src/tick/position-cap.js';

const intent = (side: 'BUY' | 'SELL') => ({
  symbol: 'ETHUSDT',
  side,
  reason: side === 'BUY' ? 'entry' : 'exit',
  clientOrderId: `c-${side}`,
});
const place = (side: 'BUY' | 'SELL'): Decision =>
  ({
    type: 'place-order',
    intent: intent(side),
    params: { type: 'MARKET', quantity: '1' },
  }) as Decision;
const replace = (side: 'BUY' | 'SELL'): Decision =>
  ({ type: 'replace-order', intent: intent(side) }) as unknown as Decision;
const cancel = { type: 'cancel-order' } as unknown as Decision;
const emit = { type: 'emit-event' } as unknown as Decision;
const setKv = { type: 'set-kv' } as unknown as Decision;

describe('applyPositionCap', () => {
  const all = [place('BUY'), replace('BUY'), place('SELL'), cancel, emit, setKv];

  it('keeps every decision while fewer than the cap are held', () => {
    const r = applyPositionCap(all, 'ETHUSDT', new Set(['A']), 2);
    expect(r.kept).toEqual(all);
    expect(r.dropped).toEqual([]);
    expect(r.held).toBe(1);
  });

  it('drops BUY place and BUY replace at the cap but keeps SELL, cancel, event and KV', () => {
    const r = applyPositionCap(all, 'ETHUSDT', new Set(['A', 'B']), 2);
    expect(r.dropped).toEqual([all[0], all[1]]);
    expect(r.kept).toEqual([all[2], all[3], all[4], all[5]]);
    expect(r.held).toBe(2);
  });

  it('keeps the BUY of a coin already held even at the cap', () => {
    const r = applyPositionCap(all, 'ETHUSDT', new Set(['ETHUSDT', 'B']), 2);
    expect(r.kept).toEqual(all);
    expect(r.dropped).toEqual([]);
  });

  it('also binds above the cap, not only at it', () => {
    const r = applyPositionCap([place('BUY')], 'ETHUSDT', new Set(['A', 'B', 'C']), 2);
    expect(r.dropped).toHaveLength(1);
  });
});

describe('acquireLease', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 5));

  it('makes a second holder of the same key wait for the release', async () => {
    const chain = createChainByKey();
    const order: string[] = [];
    const releaseFirst = await acquireLease(chain, positionCapKey('p'));
    const second = acquireLease(chain, positionCapKey('p')).then(() => order.push('second'));
    await tick();
    expect(order).toEqual([]);
    releaseFirst();
    await second;
    expect(order).toEqual(['second']);
  });

  it('does not block a different key', async () => {
    const chain = createChainByKey();
    await acquireLease(chain, positionCapKey('p'));
    await expect(acquireLease(chain, positionCapKey('q'))).resolves.toBeTypeOf('function');
  });

  it('release is idempotent', async () => {
    const chain = createChainByKey();
    const release = await acquireLease(chain, positionCapKey('p'));
    release();
    release();
    const next = await acquireLease(chain, positionCapKey('p'));
    next();
    expect(chain.size()).toBeLessThanOrEqual(1);
  });
});
