// OrderRateGovernor unit tests.
//
// All tests inject a deterministic clock + sleep so the multi-window rolling
// math is exercised without real timers. The live/testnet limit rows used here
// are the real ones (live 100/10s + 200000/1d, testnet 50/10s + 160000/1d) —
// they differ by environment, which is why they are parsed rather than fixed.

import { describe, expect, it } from 'vitest';

import {
  createOrderRateGovernor,
  intervalSuffix,
  intervalToMs,
  parseOrderRateLimits,
  MAX_RESERVE_WAIT_MS,
  OrderBudgetUnavailableError,
} from '../../src/rate-limit/order-governor.js';

const TEN_S = 10_000;
const ONE_D = 86_400_000;

const fakeClock = (start = 1_000_000_000_000): { nowMs(): number; advance(ms: number): void } => {
  let now = start;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const liveRows = [
  { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 },
  { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 100 },
  { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 200000 },
  { rateLimitType: 'RAW_REQUESTS', interval: 'MINUTE', intervalNum: 5, limit: 300000 },
];

describe('intervalToMs', () => {
  it.each([
    ['SECOND', 10, 10_000],
    ['MINUTE', 1, 60_000],
    ['HOUR', 2, 7_200_000],
    ['DAY', 1, 86_400_000],
  ])('maps %s/%d', (interval, num, expected) => {
    expect(intervalToMs(interval, num)).toBe(expected);
  });

  it.each([
    ['WEEK', 1],
    ['SECOND', 0],
    ['SECOND', -1],
    ['SECOND', Number.NaN],
  ])('returns null for %s/%p', (interval, num) => {
    expect(intervalToMs(interval, num)).toBeNull();
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
    'returns null for the inherited member %s',
    (interval) => {
      // An object-literal lookup walks the prototype chain, so these names would
      // resolve to a function and yield a NaN window that reads as mapped.
      expect(intervalToMs(interval, 1)).toBeNull();
    },
  );
});

describe('intervalSuffix', () => {
  it('matches the observed x-mbx-used-weight-1m spelling for MINUTE/1', () => {
    expect(intervalSuffix('MINUTE', 1)).toBe('1m');
  });

  it.each([
    ['SECOND', 10, '10s'],
    ['DAY', 1, '1d'],
  ])('derives %s/%d as %s', (interval, num, expected) => {
    expect(intervalSuffix(interval, num)).toBe(expected);
  });
});

describe('parseOrderRateLimits', () => {
  it('keeps only ORDERS rows and derives their header names', () => {
    const { windows, headers } = parseOrderRateLimits(liveRows);
    expect(windows).toEqual([
      { windowMs: TEN_S, limit: 100 },
      { windowMs: ONE_D, limit: 200000 },
    ]);
    expect([...headers]).toEqual([
      ['x-mbx-order-count-10s', TEN_S],
      ['x-mbx-order-count-1d', ONE_D],
    ]);
  });

  it('parses the testnet rows, which carry different limits from live', () => {
    const { windows } = parseOrderRateLimits([
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
      { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160000 },
    ]);
    expect(windows).toEqual([
      { windowMs: TEN_S, limit: 50 },
      { windowMs: ONE_D, limit: 160000 },
    ]);
  });

  it.each([
    ['a non-array', 'nope'],
    ['undefined', undefined],
    ['an empty array', []],
  ])('returns empty for %s', (_label, input) => {
    expect(parseOrderRateLimits(input)).toEqual({ windows: [], headers: new Map() });
  });

  it.each([
    ['a null row', [null]],
    ['a missing interval', [{ rateLimitType: 'ORDERS', intervalNum: 10, limit: 100 }]],
    [
      'a non-number intervalNum',
      [{ rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: '10', limit: 100 }],
    ],
    [
      'a non-number limit',
      [{ rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: '100' }],
    ],
    [
      'a non-finite limit',
      [{ rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: Number.NaN }],
    ],
    [
      'a non-positive limit',
      [{ rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 0 }],
    ],
    [
      'an unmappable interval',
      [{ rateLimitType: 'ORDERS', interval: 'FORTNIGHT', intervalNum: 1, limit: 100 }],
    ],
  ])('skips %s rather than inventing an unbounded window', (_label, rows) => {
    expect(parseOrderRateLimits(rows).windows).toEqual([]);
  });
});

describe('createOrderRateGovernor', () => {
  const liveWindows = parseOrderRateLimits(liveRows).windows;

  describe('input validation', () => {
    it.each([0, -0.1, 1.1, Number.NaN])('rejects targetUtilisation %p', (targetUtilisation) => {
      expect(() => createOrderRateGovernor({ windows: [], targetUtilisation })).toThrow(
        /targetUtilisation/i,
      );
    });

    it.each([0, -1, Number.NaN])('rejects windowMs %p', (windowMs) => {
      expect(() => createOrderRateGovernor({ windows: [{ windowMs, limit: 10 }] })).toThrow(
        /windowMs/i,
      );
    });

    it.each([0, -1, Number.NaN])('rejects limit %p', (limit) => {
      expect(() => createOrderRateGovernor({ windows: [{ windowMs: TEN_S, limit }] })).toThrow(
        /limit/i,
      );
    });

    it.each([0, -1, Number.NaN])('rejects a reserve count of %p', async (count) => {
      const g = createOrderRateGovernor({ windows: liveWindows });
      expect(() => g.hasHeadroom(count)).toThrow(/count/i);
      await expect(g.reserve(count)).rejects.toThrow(/count/i);
    });

    it('rejects a count larger than the tightest ceiling', async () => {
      const g = createOrderRateGovernor({ windows: [{ windowMs: TEN_S, limit: 10 }] });
      // ceiling = floor(10 * 0.8) = 8
      await expect(g.reserve(9)).rejects.toThrow(/exceeds ceiling 8/);
    });

    it('reports no headroom for an unsatisfiable count rather than throwing', () => {
      // The peek is total: a shedding caller asks "can this go now?" and an
      // unsatisfiable count is a definitive no, not a programming error. Only
      // `reserve` throws, because a blocking caller would otherwise wait forever.
      const g = createOrderRateGovernor({ windows: [{ windowMs: TEN_S, limit: 10 }] });
      expect(g.hasHeadroom(9)).toBe(false);
    });
  });

  describe('ceiling', () => {
    it('applies the utilisation haircut per window', () => {
      const g = createOrderRateGovernor({ windows: liveWindows });
      expect(g.ceiling(TEN_S)).toBe(80);
      expect(g.ceiling(ONE_D)).toBe(160000);
    });

    it('clamps a limit that would floor to zero up to 1, so it cannot deadlock', () => {
      const g = createOrderRateGovernor({
        windows: [{ windowMs: TEN_S, limit: 1 }],
        targetUtilisation: 0.1,
      });
      expect(g.ceiling(TEN_S)).toBe(1);
    });

    it('reports Infinity and zero use for an unknown window', () => {
      const g = createOrderRateGovernor({ windows: liveWindows });
      expect(g.ceiling(12_345)).toBe(Number.POSITIVE_INFINITY);
      expect(g.used(12_345)).toBe(0);
    });
  });

  describe('inert governor (limits unreadable)', () => {
    it('admits everything and accounts nothing', async () => {
      const g = createOrderRateGovernor({ windows: [] });
      expect(g.hasHeadroom(1000)).toBe(true);
      await expect(g.reserve(1000)).resolves.toBeUndefined();
      expect(g.used(TEN_S)).toBe(0);
    });
  });

  describe('headerWindows', () => {
    it('carries the parsed header map so it cannot desync from the windows', () => {
      const parsed = parseOrderRateLimits(liveRows);
      const g = createOrderRateGovernor(parsed);
      expect([...g.headerWindows]).toEqual([
        ['x-mbx-order-count-10s', TEN_S],
        ['x-mbx-order-count-1d', ONE_D],
      ]);
    });

    it('is empty when no header map is supplied', () => {
      expect(createOrderRateGovernor({ windows: [] }).headerWindows.size).toBe(0);
    });
  });

  describe('hasHeadroom', () => {
    it('peeks without accounting — repeated peeks never consume the window', () => {
      const g = createOrderRateGovernor({ windows: liveWindows, clock: fakeClock() });
      for (let i = 0; i < 200; i += 1) expect(g.hasHeadroom(2)).toBe(true);
      expect(g.used(TEN_S)).toBe(0);
    });

    it('reports false once any single window is full', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      expect(g.used(TEN_S)).toBe(80);
      // The 10s window is at its ceiling while the 1d window has ample room,
      // so this proves the AND across windows rather than a single-window check.
      expect(g.used(ONE_D)).toBe(80);
      expect(g.hasHeadroom(2)).toBe(false);
      expect(g.hasHeadroom(1)).toBe(false);
    });

    it('recovers once the short window rolls off, with the day window retaining', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      expect(g.hasHeadroom(2)).toBe(false);
      clock.advance(TEN_S + 1);
      expect(g.hasHeadroom(2)).toBe(true);
      expect(g.used(TEN_S)).toBe(0);
      // The day window never rolled, so it still carries the whole burst.
      expect(g.used(ONE_D)).toBe(80);
    });

    it('binds on the DAY window when only that one is exhausted', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({
        windows: [
          { windowMs: TEN_S, limit: 100 },
          { windowMs: ONE_D, limit: 10 },
        ],
        clock,
      });
      // 1d ceiling = 8; fill it while keeping the 10s window empty by rolling it.
      for (let i = 0; i < 8; i += 1) {
        await g.reserve(1);
        clock.advance(TEN_S + 1);
      }
      expect(g.used(TEN_S)).toBe(0);
      expect(g.hasHeadroom(1)).toBe(false);
    });
  });

  describe('reserve', () => {
    it('returns immediately when there is headroom', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({
        windows: liveWindows,
        clock,
        sleep: () => Promise.reject(new Error('should not sleep')),
      });
      await g.reserve(2);
      expect(g.used(TEN_S)).toBe(2);
      // Accounted against EVERY window, not just the binding one.
      expect(g.used(ONE_D)).toBe(2);
    });

    it('waits for the blocking window to roll, then admits — never sheds', async () => {
      const clock = fakeClock();
      const sleeps: number[] = [];
      const g = createOrderRateGovernor({
        windows: liveWindows,
        clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
          return Promise.resolve();
        },
      });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      await g.reserve(2);
      // It slept exactly until the oldest record aged out of the 10s window.
      expect(sleeps).toEqual([TEN_S]);
      expect(g.used(TEN_S)).toBe(2);
    });

    it('throws rather than parking when the wait exceeds the reserve ceiling', async () => {
      const clock = fakeClock();
      let slept = false;
      const g = createOrderRateGovernor({
        windows: [
          { windowMs: TEN_S, limit: 100 },
          { windowMs: ONE_D, limit: 10 },
        ],
        clock,
        sleep: async () => {
          slept = true;
          return Promise.resolve();
        },
      });
      // Saturate the 1d window (ceiling 8) while rolling the 10s one, so the
      // day row is the only thing blocking and its oldest record is ~24h away.
      for (let i = 0; i < 8; i += 1) {
        await g.reserve(1);
        clock.advance(TEN_S + 1);
      }
      // The TYPE is the contract, not the message: `place-order` keys on it to
      // classify the refusal as pre-call instead of probing Binance for an order
      // that was never sent.
      await expect(g.reserve(1)).rejects.toBeInstanceOf(OrderBudgetUnavailableError);
      await expect(g.reserve(1)).rejects.toMatchObject({ windowMs: ONE_D });
      // The point of the bound: it must not have slept the day out first.
      expect(slept).toBe(false);
      // And it accounted nothing, so the next tick re-evaluates from clean state.
      expect(g.used(ONE_D)).toBe(8);
    });

    it('bounds the TOTAL wait, so a short window kept saturated cannot park it forever', async () => {
      const clock = fakeClock();
      const sleeps: number[] = [];
      const g = createOrderRateGovernor({
        windows: [{ windowMs: TEN_S, limit: 10 }],
        clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          // Guard, not an assertion: a per-wait bound loops forever here, and a
          // hung test reads as infrastructure trouble rather than a regression.
          if (sleeps.length > 20) throw new Error('reserve never gave up');
          clock.advance(ms);
          // The operator placing orders by hand on the same UID: every time the
          // window rolls, the header reconcile fills it straight back up.
          g.observe(TEN_S, 8);
          return Promise.resolve();
        },
      });
      for (let i = 0; i < 8; i += 1) await g.reserve(1);

      await expect(g.reserve(1)).rejects.toMatchObject({ windowMs: TEN_S });
      // Derived from the constant, not a literal count: a changed ceiling should
      // move this expectation rather than fail a test that is not about it.
      const expected = Math.floor(MAX_RESERVE_WAIT_MS / TEN_S);
      expect(sleeps).toEqual(Array.from({ length: expected }, () => TEN_S));
      // The bound is CUMULATIVE. No single wait ever exceeds the window, so a
      // per-wait ceiling would never bind here and the loop would run forever:
      // it slept as long as it could, and one more wait would have crossed.
      expect(TEN_S).toBeLessThan(MAX_RESERVE_WAIT_MS);
      const total = sleeps.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(MAX_RESERVE_WAIT_MS);
      expect(total + TEN_S).toBeGreaterThan(MAX_RESERVE_WAIT_MS);
    });

    it('still waits out a sub-ceiling delay', async () => {
      const clock = fakeClock();
      const sleeps: number[] = [];
      const g = createOrderRateGovernor({
        windows: liveWindows,
        clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
          return Promise.resolve();
        },
      });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      await expect(g.reserve(2)).resolves.toBeUndefined();
      expect(sleeps).toEqual([TEN_S]);
      expect(TEN_S).toBeLessThan(MAX_RESERVE_WAIT_MS);
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const g = createOrderRateGovernor({ windows: liveWindows });
      await expect(g.reserve(1, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
    });

    it('surfaces the caller’s own abort reason rather than replacing it', async () => {
      const clock = fakeClock();
      const controller = new AbortController();
      const reason = new DOMException('binance rest timeout', 'TimeoutError');
      const g = createOrderRateGovernor({
        windows: liveWindows,
        clock,
        sleep: () => new Promise<void>(() => {}),
      });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      const pending = g.reserve(2, { signal: controller.signal });
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    });

    it('rejects when aborted while waiting', async () => {
      const clock = fakeClock();
      const controller = new AbortController();
      const g = createOrderRateGovernor({
        windows: liveWindows,
        clock,
        // Never resolves on its own: the abort must be what settles the race.
        sleep: () => new Promise<void>(() => {}),
      });
      for (let i = 0; i < 40; i += 1) await g.reserve(2);
      const pending = g.reserve(2, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/);
    });
  });

  describe('observe', () => {
    it('tops the window up to Binance’s authoritative count when we are behind', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      await g.reserve(2);
      // Binance says 10 — the operator placed 8 by hand in the UI.
      g.observe(TEN_S, 10);
      expect(g.used(TEN_S)).toBe(10);
    });

    it('is idempotent for a repeated identical report', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      await g.reserve(2);
      g.observe(TEN_S, 10);
      g.observe(TEN_S, 10);
      expect(g.used(TEN_S)).toBe(10);
    });

    it('never trusts a LOWER report — our reservation precedes the request landing', async () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      await g.reserve(6);
      g.observe(TEN_S, 2);
      expect(g.used(TEN_S)).toBe(6);
    });

    it('ages a topped-up amount out with the window', () => {
      const clock = fakeClock();
      const g = createOrderRateGovernor({ windows: liveWindows, clock });
      g.observe(TEN_S, 50);
      expect(g.used(TEN_S)).toBe(50);
      clock.advance(TEN_S + 1);
      expect(g.used(TEN_S)).toBe(0);
    });

    it.each([
      ['an unknown window', 12_345, 5],
      ['a negative count', TEN_S, -1],
      ['a non-finite count', TEN_S, Number.NaN],
    ])('ignores %s', (_label, windowMs, used) => {
      const g = createOrderRateGovernor({ windows: liveWindows, clock: fakeClock() });
      g.observe(windowMs, used);
      expect(g.used(TEN_S)).toBe(0);
    });
  });
});
