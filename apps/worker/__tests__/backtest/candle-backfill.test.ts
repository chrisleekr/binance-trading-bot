import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { ParsedKline } from '@app/binance';
import type { MsRange, schema } from '@app/db';
import { backfillCandles } from '../../src/backtest/candle-backfill.js';

const silentLogger = pino({ level: 'silent' });
const MIN = 60_000;

/**
 * Fake Binance klines server over a 1m grid: returns up to `limit` candles
 * from `startTime`, stepping one minute, capped at `endTime`. `getKlines` now
 * decodes the wire tuple, so the fake returns the validated `ParsedKline`
 * shape the backfill consumes.
 */
function fakeKlines(startTime: number, endTime: number, limit: number): ParsedKline[] {
  const out: ParsedKline[] = [];
  for (let t = startTime; t <= endTime && out.length < limit; t += MIN) {
    out.push({
      openTimeMs: t,
      open: '100',
      high: '110',
      low: '90',
      close: '105',
      volume: '1',
      closeTimeMs: t + MIN - 1,
    });
  }
  return out;
}

/** One ParsedKline with placeholder OHLCV; only the times drive these tests. */
const c = (openTimeMs: number, closeTimeMs: number): ParsedKline => ({
  openTimeMs,
  open: '1',
  high: '1',
  low: '1',
  close: '1',
  volume: '1',
  closeTimeMs,
});

function harness(opts: {
  gaps: MsRange[];
  nowMs: number;
  getKlines?: (p: { startTime?: number; endTime?: number; limit?: number }) => ParsedKline[];
}) {
  const inserted: schema.CandleInsert[] = [];
  const getKlines = vi.fn(async (p: { startTime?: number; endTime?: number; limit?: number }) =>
    (opts.getKlines ?? ((q) => fakeKlines(q.startTime ?? 0, q.endTime ?? 0, q.limit ?? 500)))(p),
  );
  const deps = {
    getKlines: getKlines as never,
    findGaps: vi.fn(async () => opts.gaps),
    insertCandles: vi.fn(async (rows: readonly schema.CandleInsert[]) => {
      inserted.push(...rows);
    }),
    clock: { nowMs: () => opts.nowMs },
    logger: silentLogger,
  };
  return { deps, inserted, getKlines };
}

describe('backfillCandles', () => {
  it('issues zero requests when the range is already covered', async () => {
    const { deps, getKlines } = harness({ gaps: [], nowMs: 10 * MIN });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 5 * MIN,
    });
    expect(res).toEqual({ inserted: 0, requests: 0 });
    expect(getKlines).not.toHaveBeenCalled();
  });

  it('fills a single-page gap and stores closed candles', async () => {
    // gap 0..4m, now well past → all 5 candles closed
    const { deps, inserted, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: 4 * MIN }],
      nowMs: 100 * MIN,
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 4 * MIN,
    });
    expect(getKlines).toHaveBeenCalledTimes(1);
    expect(res.inserted).toBe(5);
    expect(inserted.map((r) => r.openTime.getTime())).toEqual([0, MIN, 2 * MIN, 3 * MIN, 4 * MIN]);
    expect(inserted[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '1m', close: '105' });
  });

  it('paginates a gap larger than the page limit', async () => {
    // 1200-candle gap, page 500 → 3 requests (500 + 500 + 200)
    const span = 1199; // candles 0..1199 inclusive = 1200
    const { deps, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: span * MIN }],
      nowMs: 100_000 * MIN,
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: span * MIN,
    });
    expect(getKlines).toHaveBeenCalledTimes(3);
    expect(res.inserted).toBe(1200);
    // pages advance startTime: 0, 500m, 1000m
    expect(getKlines.mock.calls[1]?.[0]).toMatchObject({ startTime: 500 * MIN });
    expect(getKlines.mock.calls[2]?.[0]).toMatchObject({ startTime: 1000 * MIN });
  });

  it('drops the currently-forming bar', async () => {
    // now falls inside candle index 4 (close at 5m-1), so it is not yet closed
    const { deps, inserted } = harness({
      gaps: [{ fromMs: 0, toMs: 4 * MIN }],
      nowMs: 4 * MIN + 30_000, // mid candle 4
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 4 * MIN,
    });
    expect(res.inserted).toBe(4); // candle 4 dropped as forming
    expect(inserted.map((r) => r.openTime.getTime())).toEqual([0, MIN, 2 * MIN, 3 * MIN]);
  });

  it('strips the EXCHANGE: prefix for the REST call but stores under the full symbol', async () => {
    const { deps, inserted, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: MIN }],
      nowMs: 100 * MIN,
    });
    await backfillCandles(deps, {
      symbol: 'BINANCE:BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: MIN,
    });
    expect(getKlines.mock.calls[0]?.[0]).toMatchObject({ symbol: 'BTCUSDT' });
    expect(inserted.every((r) => r.symbol === 'BINANCE:BTCUSDT')).toBe(true);
  });

  it('fills multiple disjoint gaps each from its own cursor', async () => {
    const { deps, inserted, getKlines } = harness({
      gaps: [
        { fromMs: 0, toMs: 2 * MIN },
        { fromMs: 10 * MIN, toMs: 11 * MIN },
      ],
      nowMs: 100 * MIN,
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 11 * MIN,
    });
    expect(getKlines).toHaveBeenCalledTimes(2);
    expect(getKlines.mock.calls[0]?.[0]).toMatchObject({ startTime: 0, endTime: 2 * MIN });
    expect(getKlines.mock.calls[1]?.[0]).toMatchObject({ startTime: 10 * MIN, endTime: 11 * MIN });
    expect(res.inserted).toBe(3 + 2); // [0,1,2] + [10,11]
    expect(inserted.map((r) => r.openTime.getTime())).toEqual([
      0,
      MIN,
      2 * MIN,
      10 * MIN,
      11 * MIN,
    ]);
  });

  it('leaves the trailing candle as a gap when it is still forming', async () => {
    // gap ends at candle 4 (open 4m), but now is mid-candle-4 → it stays unfilled
    const { deps, inserted } = harness({
      gaps: [{ fromMs: 0, toMs: 4 * MIN }],
      nowMs: 4 * MIN + 10_000,
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 4 * MIN,
    });
    expect(res.inserted).toBe(4); // 0..3 stored; 4 forming, deferred to a later run
    expect(inserted.some((r) => r.openTime.getTime() === 4 * MIN)).toBe(false);
  });

  it('drops candles the server returns past the requested window', async () => {
    // server over-returns one extra candle beyond endTime
    const { deps, inserted } = harness({
      gaps: [{ fromMs: 0, toMs: MIN }],
      nowMs: 100 * MIN,
      getKlines: () => [
        c(0, MIN - 1),
        c(MIN, 2 * MIN - 1),
        c(2 * MIN, 3 * MIN - 1), // openTime 2m > windowEnd 1m
      ],
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: MIN,
    });
    expect(res.inserted).toBe(2); // candle at 2m dropped (past window)
    expect(inserted.some((r) => r.openTime.getTime() === 2 * MIN)).toBe(false);
  });

  it('keeps paging after a short page that does not reach the gap end (reproducibility)', async () => {
    // Binance can return < PAGE_LIMIT mid-gap (clipping / sparse window) while
    // more candles exist later. The backfill must page on, not stop, so two
    // runs read the identical complete set (the cross-run drift root cause).
    const range = (fromIdx: number, toIdx: number): ParsedKline[] => {
      const out: ParsedKline[] = [];
      for (let i = fromIdx; i <= toIdx; i += 1) out.push(c(i * MIN, i * MIN + MIN - 1));
      return out;
    };
    const { deps, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: 1000 * MIN }],
      nowMs: 100_000 * MIN,
      getKlines: (p) => {
        const start = p.startTime ?? 0;
        if (start === 0) return range(0, 99); // short first page (100 < 500), mid-gap
        if (start === 100 * MIN) return range(100, 599); // full page
        if (start === 600 * MIN) return range(600, 1000); // tail
        return [];
      },
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 1000 * MIN,
    });
    expect(res.inserted).toBe(1001); // every candle 0..1000m, not just the first 100
    expect(getKlines).toHaveBeenCalledTimes(3);
  });

  it('skips a permanent mid-gap hole and still completes the range', async () => {
    // Candles 3..6m never exist on the exchange (illiquid). Binance returns the
    // next available candles >= startTime, so the cursor steps over the hole and
    // the backfill still reaches the gap end deterministically.
    const { deps, inserted, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: 10 * MIN }],
      nowMs: 100_000 * MIN,
      getKlines: (p) => {
        const start = p.startTime ?? 0;
        if (start <= 0) return [c(0, MIN - 1), c(MIN, 2 * MIN - 1), c(2 * MIN, 3 * MIN - 1)];
        if (start <= 7 * MIN)
          return [
            c(7 * MIN, 8 * MIN - 1),
            c(8 * MIN, 9 * MIN - 1),
            c(9 * MIN, 10 * MIN - 1),
            c(10 * MIN, 11 * MIN - 1),
          ];
        return [];
      },
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 10 * MIN,
    });
    expect(res.inserted).toBe(7); // 0,1,2 + 7,8,9,10 — the 3..6 hole is simply absent
    expect(inserted.some((r) => r.openTime.getTime() === 4 * MIN)).toBe(false);
    expect(getKlines).toHaveBeenCalledTimes(2);
  });

  it('stops without looping when a page returns nothing', async () => {
    const { deps, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: 4 * MIN }],
      nowMs: 100 * MIN,
      getKlines: () => [],
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 4 * MIN,
    });
    expect(getKlines).toHaveBeenCalledTimes(1);
    expect(res.inserted).toBe(0);
  });

  it('stops when the cursor cannot advance (non-advancing page guard)', async () => {
    // A quirky/misbehaving server returns the same sub-cursor row regardless of
    // startTime. With the short-page break gone, the `next <= cursor` guard is
    // the ONLY thing preventing an infinite loop — pin it: page 1 inserts the
    // row, page 2 cannot advance the cursor → break. Exactly 2 calls, no hang.
    const { deps, getKlines } = harness({
      gaps: [{ fromMs: 0, toMs: 10 * MIN }],
      nowMs: 100 * MIN,
      getKlines: () => [c(0, MIN - 1)], // max openTime 0 never exceeds the cursor after advance
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 10 * MIN,
    });
    // The guard fires on the 2nd call (cursor cannot advance) → exactly 2 calls,
    // no infinite loop. The sub-cursor row maps on both calls (prod dedups via
    // insert-or-ignore); the count only matters in that it is finite.
    expect(getKlines).toHaveBeenCalledTimes(2);
    expect(res.inserted).toBe(2);
  });

  it('keeps per-gap cursor isolation when an earlier gap returns a short page', async () => {
    // A short page in gap #1 must not stop gap #2 from being fetched from its
    // own fromMs — the per-gap cursor reset isolates them.
    const range = (fromIdx: number, toIdx: number): ParsedKline[] => {
      const out: ParsedKline[] = [];
      for (let i = fromIdx; i <= toIdx; i += 1) out.push(c(i * MIN, i * MIN + MIN - 1));
      return out;
    };
    const { deps, getKlines } = harness({
      gaps: [
        { fromMs: 0, toMs: 600 * MIN },
        { fromMs: 1000 * MIN, toMs: 1001 * MIN },
      ],
      nowMs: 100_000 * MIN,
      getKlines: (p) => {
        const start = p.startTime ?? 0;
        if (start === 0) return range(0, 99); // short page in gap #1
        if (start === 100 * MIN) return range(100, 600); // rest of gap #1
        if (start === 1000 * MIN) return range(1000, 1001); // gap #2
        return [];
      },
    });
    const res = await backfillCandles(deps, {
      symbol: 'BTCUSDT',
      interval: '1m',
      fromMs: 0,
      toMs: 1001 * MIN,
    });
    expect(res.inserted).toBe(601 + 2); // full gap #1 + gap #2
    expect(getKlines.mock.calls.at(-1)?.[0]).toMatchObject({ startTime: 1000 * MIN });
  });
});
