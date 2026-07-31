// Re-entrancy probe for chainByKey under high contention. The integration
// test (concurrency 25, 100 ticks per key, full BullMQ stack) covers the
// end-to-end story; this unit test locks the in-process invariant:
// (1) no two same-key invocations overlap, and (2) distinct keys are NOT
// globally serialised — i.e. the concurrency cap is per-key, not process-
// wide.

import { describe, expect, it } from 'vitest';

import { createChainByKey } from '../../src/lib/chain-by-key.js';

interface Probe {
  key: string;
  concurrent: number;
  maxConcurrent: number;
}

interface GlobalProbe {
  concurrent: number;
  maxConcurrent: number;
}

const newProbe = (key: string): Probe => ({ key, concurrent: 0, maxConcurrent: 0 });

const wrap = (probe: Probe) => async (): Promise<void> => {
  probe.concurrent += 1;
  if (probe.concurrent > probe.maxConcurrent) probe.maxConcurrent = probe.concurrent;
  // A single microtask + a small async delay is enough to force interleaving
  // when 100 same-key calls fire from the same loop turn.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  probe.concurrent -= 1;
};

const wrapWithGlobal = (probe: Probe, global: GlobalProbe) => async (): Promise<void> => {
  probe.concurrent += 1;
  global.concurrent += 1;
  if (probe.concurrent > probe.maxConcurrent) probe.maxConcurrent = probe.concurrent;
  if (global.concurrent > global.maxConcurrent) global.maxConcurrent = global.concurrent;
  await new Promise((r) => setTimeout(r, 0));
  probe.concurrent -= 1;
  global.concurrent -= 1;
};

describe('chainByKey under stress', () => {
  it('serialises 100 same-key invocations without overlap and lets distinct keys overlap', async () => {
    const chain = createChainByKey();

    const probes = new Map<string, Probe>([
      ['k1', newProbe('k1')],
      ['k2', newProbe('k2')],
    ]);

    // Fire 100 per key in alternating order to force the worst-case interleaving.
    const k1 = probes.get('k1');
    const k2 = probes.get('k2');
    if (!k1 || !k2) throw new Error('probes missing');
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i += 1) {
      tasks.push(chain.run('k1', wrap(k1)));
      tasks.push(chain.run('k2', wrap(k2)));
    }
    await Promise.all(tasks);

    expect(k1.maxConcurrent).toBe(1);
    expect(k2.maxConcurrent).toBe(1);
  });

  it('lets distinct keys overlap (concurrency cap is per-key, not global)', async () => {
    const chain = createChainByKey();
    const k1 = newProbe('k1');
    const k2 = newProbe('k2');
    const global: GlobalProbe = { concurrent: 0, maxConcurrent: 0 };
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i += 1) {
      tasks.push(chain.run('k1', wrapWithGlobal(k1, global)));
      tasks.push(chain.run('k2', wrapWithGlobal(k2, global)));
    }
    await Promise.all(tasks);
    // Per-key serialisation still holds.
    expect(k1.maxConcurrent).toBe(1);
    expect(k2.maxConcurrent).toBe(1);
    // But across keys the chain must allow at least 2 concurrent. Without
    // this assertion a globally-serialised implementation would still pass
    // the suite, masking a real regression.
    expect(global.maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
