// WeightGovernor unit tests.
//
// All tests inject a deterministic clock + sleep so the rolling-window
// math is exercised without real timers.

import { describe, expect, it, vi } from 'vitest';

import { createWeightGovernor } from '../../src/rate-limit/weight-governor.js';

const fakeClock = (start = 1_000_000_000_000): { nowMs(): number; advance(ms: number): void } => {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('createWeightGovernor', () => {
  describe('input validation', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects budget %p', (budget) => {
      expect(() => createWeightGovernor({ budget })).toThrow(/budget/i);
    });

    it.each([0, -0.1, 1.1, Number.NaN])('rejects targetUtilisation %p', (targetUtilisation) => {
      expect(() => createWeightGovernor({ targetUtilisation })).toThrow(/targetUtilisation/i);
    });
  });

  describe('ceiling', () => {
    it('reports the floored budget * targetUtilisation', () => {
      const g = createWeightGovernor({ budget: 1000, targetUtilisation: 0.8 });
      expect(g.ceiling()).toBe(800);
    });

    it('defaults to floor(1200 * 0.8) = 960 with no options', () => {
      expect(createWeightGovernor().ceiling()).toBe(960);
    });
  });

  describe('order-priority reserved headroom', () => {
    it.each([50, 60, -1, Number.NaN])(
      'rejects orderReserve %p outside [0, ceiling)',
      (orderReserve) => {
        // budget 100 * 0.5 = ceiling 50; orderReserve must be in [0, 50).
        expect(() =>
          createWeightGovernor({ budget: 100, targetUtilisation: 0.5, orderReserve }),
        ).toThrow(/orderReserve/i);
      },
    );

    it('keeps the top orderReserve band free for priority (order) reservations', async () => {
      const clock = fakeClock();
      // ceiling 100; bulk limit = 100 - 8 = 92.
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 1, orderReserve: 8, clock });
      await g.reserve(92); // bulk fills exactly to its limit
      expect(g.used()).toBe(92);
      // A priority (order) reserve admits against the FULL ceiling (92+1 ≤ 100)
      // even though the bulk band is full — it never waits.
      await g.reserve(1, { priority: true });
      expect(g.used()).toBe(93);
    });

    it('makes a bulk reserve wait when only the order band is free', async () => {
      const clock = fakeClock();
      const sleeps: number[] = [];
      const sleep = async (ms: number): Promise<void> => {
        sleeps.push(ms);
        clock.advance(ms); // window rolls so the prior record ages out
      };
      const g = createWeightGovernor({
        budget: 100,
        targetUtilisation: 1,
        orderReserve: 8,
        clock,
        sleep,
      });
      await g.reserve(92); // fills the bulk band
      await g.reserve(1); // bulk: must wait for the 92 record to age out, then admit
      expect(sleeps.length).toBeGreaterThan(0);
      expect(g.used()).toBe(1);
    });

    it('admits a single bulk cost larger than the reserved band against the full ceiling', async () => {
      const clock = fakeClock();
      // bulk limit 92, but a 95-weight bulk call (≤ ceiling 100) must still admit
      // rather than deadlock against the lower band.
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 1, orderReserve: 8, clock });
      await g.reserve(95);
      expect(g.used()).toBe(95);
    });
  });

  describe('synchronous reserves under budget', () => {
    it('an empty governor accepts reserve immediately and tracks usage', async () => {
      const clock = fakeClock();
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 1, clock });
      await g.reserve(10);
      expect(g.used()).toBe(10);
      await g.reserve(20);
      expect(g.used()).toBe(30);
    });

    it('rejects a cost > soft ceiling', async () => {
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 0.5 });
      await expect(g.reserve(60)).rejects.toThrow(/exceeds soft ceiling/);
    });

    it('rejects a non-finite or negative cost', async () => {
      const g = createWeightGovernor({ budget: 100 });
      await expect(g.reserve(-1)).rejects.toThrow(/non-negative/);
      await expect(g.reserve(Number.NaN)).rejects.toThrow(/non-negative/);
    });
  });

  describe('rolling-window saturation blocks until headroom', () => {
    it('a reserve that would push past the ceiling waits for the oldest entry to age out', async () => {
      const clock = fakeClock();
      // budget=100, utilisation=0.8 → ceiling=80. Two reserves of 50 sum
      // to 100 which exceeds 80 — the second must wait.
      const sleeps: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleeps.push(ms);
        clock.advance(ms);
      });
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 0.8, clock, sleep });
      await g.reserve(50);
      const second = g.reserve(50);
      // Sleep was invoked at least once; the wait equals the time until
      // the first record falls off (oldest.ts + 60_000 - now), which on
      // the very first iteration is ~60_000 ms.
      await second;
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(1);
      // After 60s pass, the first reserve has aged out; only the second
      // contributes to `used()`.
      expect(g.used()).toBe(50);
    });
  });

  describe('AbortSignal', () => {
    it('a pre-aborted signal rejects synchronously', async () => {
      const g = createWeightGovernor({ budget: 100 });
      const ac = new AbortController();
      ac.abort();
      await expect(g.reserve(10, { signal: ac.signal })).rejects.toThrow(/aborted/);
    });

    it('aborting a waiting reservation rejects it', async () => {
      const clock = fakeClock();
      // Use a real-time sleep so the test can abort mid-wait.
      const g = createWeightGovernor({ budget: 100, targetUtilisation: 0.5, clock });
      await g.reserve(50);
      const ac = new AbortController();
      const waiting = g.reserve(50, { signal: ac.signal });
      // Give the reserve a tick to attach its abort listener, then abort.
      await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      await expect(waiting).rejects.toThrow(/aborted/);
    });
  });
});
