import { describe, it, expect } from 'vitest';
import { createChainByKey } from '../../src/lib/chain-by-key.js';

describe('chainByKey', () => {
  it('serialises calls for the same key', async () => {
    const chain = createChainByKey();
    const events: string[] = [];
    const work = (label: string, ms: number) => async () => {
      events.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`end:${label}`);
      return label;
    };
    const r1 = chain.run('k', work('a', 10));
    const r2 = chain.run('k', work('b', 5));
    const r3 = chain.run('k', work('c', 1));
    await Promise.all([r1, r2, r3]);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('runs different keys concurrently', async () => {
    const chain = createChainByKey();
    const events: string[] = [];
    const work = (label: string, ms: number) => async () => {
      events.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`end:${label}`);
    };
    // The gap between the two sleeps has to survive a loaded CI box: with 10ms vs
    // 1ms, a stalled event loop can let the long one finish first and the interleave
    // assertion below flips. The property under test (different keys do not
    // serialise) needs only that one clearly outlasts the other.
    await Promise.all([chain.run('a', work('a', 100)), chain.run('b', work('b', 1))]);
    expect(events[0]).toBe('start:a');
    expect(events[1]).toBe('start:b');
    expect(events[2]).toBe('end:b');
    expect(events[3]).toBe('end:a');
  });

  it('continues the chain past a rejection', async () => {
    const chain = createChainByKey();
    const order: string[] = [];
    const r1 = chain.run('k', async () => {
      order.push('a');
      throw new Error('boom');
    });
    const r2 = chain.run('k', async () => {
      order.push('b');
      return 'b';
    });
    await expect(r1).rejects.toThrow('boom');
    await expect(r2).resolves.toBe('b');
    expect(order).toEqual(['a', 'b']);
  });

  it('drops keys from its map when the tail settles', async () => {
    const chain = createChainByKey();
    await chain.run('k', async () => 1);
    expect(chain.size()).toBe(0);
  });

  it('DEADLOCKS on a nested same-key run: the chain is strictly non-reentrant', async () => {
    // Load-bearing, not a curiosity. The tick body runs inside
    // chain.run(`${profileId}:${symbol}`) and the fill-adopter takes the SAME
    // key, so any code reached from a tick that awaits an adopt() self-awaits
    // and the tick never returns. That is why a decision handler may only
    // ENQUEUE a reconcile, never adopt inline.
    //
    // A regression here surfaces as a HANG (a timed-out tick), not as a failing
    // assertion, so pin the deadlock explicitly: the nested call must still be
    // pending after the outer one has had every chance to progress.
    const chain = createChainByKey();
    let nestedRan = false;
    const outer = chain.run('k', async () => {
      // The nested call is appended to the tail this very body IS, so awaiting
      // it awaits ourselves. Neither promise can ever settle.
      await chain.run('k', async () => {
        nestedRan = true;
      });
      return 'outer-finished';
    });
    const verdict = await Promise.race([
      outer,
      new Promise((r) => setTimeout(() => r('still-pending'), 50)),
    ]);
    expect(verdict).toBe('still-pending');
    expect(nestedRan).toBe(false);
    // The outer promise stays forever pending; swallow it so the deadlocked
    // chain does not surface as an unhandled rejection at teardown.
    void outer.catch(() => undefined);
  });
});
