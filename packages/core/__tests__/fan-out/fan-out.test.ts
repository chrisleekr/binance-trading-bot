import { describe, expect, it, vi } from 'vitest';

import { fanOutBounded } from '../../src/fan-out/index.js';

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('fanOutBounded', () => {
  describe('input validation', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'throws on invalid concurrency %p',
      async (concurrency) => {
        await expect(
          fanOutBounded([1, 2, 3], async (n) => n, { concurrency, onError: 'collect' }),
        ).rejects.toThrow(/positive integer/i);
      },
    );
  });

  describe('empty input', () => {
    it('returns an empty result and never calls fn', async () => {
      const fn = vi.fn(async (n: number) => n);
      const result = await fanOutBounded([], fn, { concurrency: 4, onError: 'collect' });
      expect(result).toEqual({ ok: [], errors: [] });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('single item', () => {
    it('returns the single result, ordering preserved', async () => {
      const result = await fanOutBounded(['a'], async (s) => s.toUpperCase(), {
        concurrency: 4,
        onError: 'collect',
      });
      expect(result.ok).toEqual(['A']);
      expect(result.errors).toEqual([]);
    });
  });

  describe('result ordering', () => {
    it('returns ok in input order even when items complete out-of-order', async () => {
      // Item 0 takes longest, item 2 finishes first — but the result must
      // still come back ordered [0, 1, 2].
      const result = await fanOutBounded(
        [30, 20, 0],
        async (delay) => {
          await tick(delay);
          return delay;
        },
        { concurrency: 4, onError: 'collect' },
      );
      expect(result.ok).toEqual([30, 20, 0]);
    });

    it('skips failed indices in ok and records them in errors with the original item', async () => {
      const result = await fanOutBounded(
        [1, 2, 3, 4],
        async (n) => {
          if (n === 2 || n === 3) throw new Error(`boom-${n}`);
          return n * 10;
        },
        { concurrency: 2, onError: 'collect' },
      );
      expect(result.ok).toEqual([10, 40]);
      expect(result.errors).toHaveLength(2);
      const errItems = result.errors.map((e) => e.item).sort((a, b) => a - b);
      expect(errItems).toEqual([2, 3]);
      const firstErr = result.errors[0];
      if (!firstErr) throw new Error('expected at least one collected error');
      expect((firstErr.error as Error).message).toMatch(/^boom-/);
    });
  });

  describe('concurrency bounds', () => {
    it('runs strictly serially when concurrency=1', async () => {
      const events: string[] = [];
      await fanOutBounded(
        [10, 20, 30],
        async (delay) => {
          events.push(`start:${delay}`);
          await tick(delay);
          events.push(`end:${delay}`);
          return delay;
        },
        { concurrency: 1, onError: 'collect' },
      );
      expect(events).toEqual(['start:10', 'end:10', 'start:20', 'end:20', 'start:30', 'end:30']);
    });

    it('never exceeds K in-flight when concurrency=K', async () => {
      let inFlight = 0;
      let peak = 0;
      const items = Array.from({ length: 20 }, (_, i) => i);
      await fanOutBounded(
        items,
        async (i) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick(5);
          inFlight--;
          return i;
        },
        { concurrency: 3, onError: 'collect' },
      );
      expect(peak).toBeLessThanOrEqual(3);
      // Sanity: with 20 items and concurrency 3, the peak must actually
      // reach 3 — otherwise the worker pool wasn't saturating.
      expect(peak).toBe(3);
    });

    it('clamps concurrency to items.length when items < concurrency', async () => {
      let inFlight = 0;
      let peak = 0;
      const items = [1, 2];
      await fanOutBounded(
        items,
        async (i) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick(5);
          inFlight--;
          return i;
        },
        { concurrency: 10, onError: 'collect' },
      );
      expect(peak).toBe(2);
    });
  });

  describe('collect mode', () => {
    it('never throws even when every item fails', async () => {
      const result = await fanOutBounded(
        [1, 2, 3],
        async (n) => {
          throw new Error(`boom-${n}`);
        },
        { concurrency: 2, onError: 'collect' },
      );
      expect(result.ok).toEqual([]);
      expect(result.errors).toHaveLength(3);
    });
  });

  describe('fail-fast mode', () => {
    it('rejects with the original error after a failure', async () => {
      await expect(
        fanOutBounded(
          [1, 2, 3, 4],
          async (n) => {
            if (n === 2) throw new Error('boom');
            await tick(10);
            return n;
          },
          { concurrency: 2, onError: 'fail-fast' },
        ),
      ).rejects.toThrow('boom');
    });

    it('stops pulling new items after the first failure', async () => {
      const seen: number[] = [];
      await expect(
        fanOutBounded(
          [1, 2, 3, 4, 5, 6, 7, 8],
          async (n) => {
            seen.push(n);
            if (n === 2) throw new Error('boom');
            await tick(20);
            return n;
          },
          { concurrency: 2, onError: 'fail-fast' },
        ),
      ).rejects.toThrow('boom');
      // Workers may have started 1 and 2 (concurrency=2). After 2 throws,
      // no further items are pulled, so seen must not contain 4..8. (3 may
      // or may not be pulled depending on race ordering — assert the strict
      // upper bound instead of an exact set.)
      expect(seen.filter((n) => n >= 4)).toEqual([]);
    });

    it('lets in-flight work settle before rejecting', async () => {
      // With concurrency=4 and 4 items, all four start. Item 1 throws
      // synchronously inside fn; items 2/3/4 await `tick(20)`. The rejection
      // must not surface until 2/3/4's awaits have resolved — observed
      // here by counting fn invocations that ran their final line.
      let settledAfterStart = 0;
      const startedAt = Date.now();
      await expect(
        fanOutBounded(
          [1, 2, 3, 4],
          async (n) => {
            if (n === 1) throw new Error('boom');
            await tick(20);
            settledAfterStart++;
            return n;
          },
          { concurrency: 4, onError: 'fail-fast' },
        ),
      ).rejects.toThrow('boom');
      // 2/3/4 should have reached their final line; the rejection waited
      // for `Promise.all(workers)`. Wall clock must reflect the 20ms wait.
      expect(settledAfterStart).toBe(3);
      // One millisecond of slack, because `setTimeout` is not a floor on the wall clock. The timer subsystem schedules against a monotonic clock and rounds its delay internally, while `Date.now()` reads the wall clock, so a timer that waited its full delay can still be observed as 19ms elapsed. Nothing about the code under test changed when this began failing; the surrounding suite stopped being CPU-starved enough to overshoot the timer and mask it. The bound still sits far above the ~2ms a neutered `tick` reports, which is the regression this line exists to catch.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(19);
    });
  });
});
