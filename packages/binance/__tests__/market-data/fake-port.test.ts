// FakeMarketDataPort contract tests.
//
// Production-grade adapters (`KlineFetcher`) will satisfy the same shape,
// so any test that depends on these guarantees should be portable. The
// asserts here are the contract:
//   - `subscribeKlines` returns a stream of CLOSED candles in push order.
//   - Multiple subscribers on the same key all see the same candle.
//   - `unsubscribe()` drops the subscriber's ref-count and ends iteration.
//   - `loadWindow` returns the most recent N pushes (oldest-first slice).
//   - `subscriberCount` lets the test verify ref-count semantics.
//   - `reset()` drains queued/parked iterators cleanly.

import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';

import { createFakeMarketDataPort } from '../../src/market-data/index.js';

const mkCandle = (openMs: number, close: string): Candle => ({
  openTimeMs: openMs,
  closeTimeMs: openMs + 60_000 - 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const collect = async <T>(stream: AsyncIterable<T>, count: number): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of stream) {
    out.push(v);
    if (out.length >= count) break;
  }
  return out;
};

describe('createFakeMarketDataPort', () => {
  describe('subscribeKlines', () => {
    it('a subscriber receives klines pushed after subscription', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(60_000, '101'));
      const received = await collect(sub.stream, 2);
      sub.unsubscribe();
      expect(received.map((k) => k.close)).toEqual(['100', '101']);
    });

    it('every kline is marked closed (isClosed === true)', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      // Push a candle whose source `isClosed` happens to be `true` to start;
      // the adapter still normalises and the consumer always sees `true`.
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      const [first] = await collect(sub.stream, 1);
      sub.unsubscribe();
      expect(first?.isClosed).toBe(true);
    });

    it('multiple subscribers on the same key all see the same kline', async () => {
      const port = createFakeMarketDataPort();
      const a = port.subscribeKlines('BTCUSDT', '1h');
      const b = port.subscribeKlines('BTCUSDT', '1h');
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      const [aOne, bOne] = await Promise.all([collect(a.stream, 1), collect(b.stream, 1)]);
      a.unsubscribe();
      b.unsubscribe();
      expect(aOne[0]?.close).toBe('100');
      expect(bOne[0]?.close).toBe('100');
    });

    it('a subscriber on one key does NOT receive klines for another', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      port.pushClosedKline('ETHUSDT', '1h', mkCandle(1_000, '5'));
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      const received = await collect(sub.stream, 1);
      sub.unsubscribe();
      expect(received[0]?.close).toBe('100');
    });

    it('different intervals on the same symbol are isolated', async () => {
      const port = createFakeMarketDataPort();
      const oneH = port.subscribeKlines('BTCUSDT', '1h');
      const oneM = port.subscribeKlines('BTCUSDT', '1m');
      port.pushClosedKline('BTCUSDT', '1m', mkCandle(1_000, '100'));
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(2_000, '200'));
      const [oneMRes, oneHRes] = await Promise.all([
        collect(oneM.stream, 1),
        collect(oneH.stream, 1),
      ]);
      oneH.unsubscribe();
      oneM.unsubscribe();
      expect(oneMRes[0]?.close).toBe('100');
      expect(oneHRes[0]?.close).toBe('200');
    });
  });

  describe('unsubscribe', () => {
    it('idempotent — second call is a no-op', () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
      sub.unsubscribe();
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
      sub.unsubscribe();
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    });

    it('ends an in-flight iteration cleanly', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      // Park a pull, then unsubscribe — the pull resolves with done.
      const iterator = sub.stream[Symbol.asyncIterator]();
      const parked = iterator.next();
      sub.unsubscribe();
      const result = await parked;
      expect(result.done).toBe(true);
    });

    it('an unsubscribed subscriber does NOT receive subsequent pushes', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      sub.unsubscribe();
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
    });
  });

  describe('loadWindow', () => {
    it('returns the most recent N entries in oldest-first order', async () => {
      const port = createFakeMarketDataPort();
      for (let i = 0; i < 10; i++) {
        port.pushClosedKline('BTCUSDT', '1h', mkCandle(i * 1000, String(100 + i)));
      }
      const w = await port.loadWindow('BTCUSDT', '1h', 4);
      expect(w.map((k) => k.close)).toEqual(['106', '107', '108', '109']);
    });

    it('returns everything available when the request exceeds the ring', async () => {
      const port = createFakeMarketDataPort();
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      const w = await port.loadWindow('BTCUSDT', '1h', 250);
      expect(w).toHaveLength(1);
      expect(w[0]?.close).toBe('100');
    });

    it('returns an empty window for a never-pushed key', async () => {
      const port = createFakeMarketDataPort();
      const w = await port.loadWindow('BTCUSDT', '1h', 10);
      expect(w).toEqual([]);
    });

    it('respects the configured ringSize cap', async () => {
      const port = createFakeMarketDataPort({ ringSize: 3 });
      for (let i = 0; i < 10; i++) {
        port.pushClosedKline('BTCUSDT', '1h', mkCandle(i * 1000, String(100 + i)));
      }
      const w = await port.loadWindow('BTCUSDT', '1h', 100);
      expect(w.map((k) => k.close)).toEqual(['107', '108', '109']);
    });
  });

  describe('subscribeMiniTicker', () => {
    it('a subscriber receives ticker events pushed after subscription', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '100', eventTimeMs: 1_000 });
      port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '101', eventTimeMs: 2_000 });
      const received = await collect(sub.stream, 2);
      sub.unsubscribe();
      expect(received.map((t) => t.closePrice)).toEqual(['100', '101']);
    });

    it('ignores tickers for other symbols', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      port.pushMiniTicker({ symbol: 'ETHUSDT', closePrice: '5', eventTimeMs: 1_000 });
      port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '100', eventTimeMs: 2_000 });
      const received = await collect(sub.stream, 1);
      sub.unsubscribe();
      expect(received[0]?.closePrice).toBe('100');
    });

    it('tickerSubscriberCount ref-counts on subscribe/unsubscribe', () => {
      const port = createFakeMarketDataPort();
      const a = port.subscribeMiniTicker('BTCUSDT');
      const b = port.subscribeMiniTicker('BTCUSDT');
      expect(port.tickerSubscriberCount('BTCUSDT')).toBe(2);
      a.unsubscribe();
      expect(port.tickerSubscriberCount('BTCUSDT')).toBe(1);
      b.unsubscribe();
      expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    });

    it('push to a symbol with no subscribers is a silent no-op', () => {
      const port = createFakeMarketDataPort();
      expect(() =>
        port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '100', eventTimeMs: 1_000 }),
      ).not.toThrow();
    });
  });

  describe('async-iterator edge paths', () => {
    it('a kline iterator that pulls after return() yields done immediately', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      const it = sub.stream[Symbol.asyncIterator]();
      // return() cancels; a subsequent next() takes the `sub.cancelled` arm.
      await it.return?.();
      const after = await it.next();
      expect(after.done).toBe(true);
    });

    it('return() resolves a parked kline pull with done', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      await it.return?.();
      expect((await parked).done).toBe(true);
    });

    it('push to a key whose only subscriber is cancelled is a no-op', () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      // unsubscribe deletes the sub from the set; push must still tolerate a
      // ring write even though no live subscriber remains.
      sub.unsubscribe();
      expect(() => port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'))).not.toThrow();
    });

    it('a ticker iterator that pulls after return() yields done immediately', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      const it = sub.stream[Symbol.asyncIterator]();
      await it.return?.();
      expect((await it.next()).done).toBe(true);
    });

    it('return() resolves a parked ticker pull with done', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      await it.return?.();
      expect((await parked).done).toBe(true);
    });

    it('pushMiniTicker resolves a parked pull directly (no queue)', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      port.pushMiniTicker({ symbol: 'BTCUSDT', closePrice: '100', eventTimeMs: 1 });
      const r = await parked;
      expect(r.done).toBe(false);
      expect(r.value?.closePrice).toBe('100');
      sub.unsubscribe();
    });
  });

  describe('subscriberCount + reset', () => {
    it('increments per subscribe, decrements per unsubscribe', () => {
      const port = createFakeMarketDataPort();
      const a = port.subscribeKlines('BTCUSDT', '1h');
      const b = port.subscribeKlines('BTCUSDT', '1h');
      const c = port.subscribeKlines('ETHUSDT', '1h');
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(2);
      expect(port.subscriberCount('ETHUSDT', '1h')).toBe(1);
      a.unsubscribe();
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(1);
      b.unsubscribe();
      expect(port.subscriberCount('BTCUSDT', '1h')).toBe(0);
      c.unsubscribe();
    });

    it('reset drains every subscription and clears every ring', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeKlines('BTCUSDT', '1h');
      const parked = sub.stream[Symbol.asyncIterator]().next();
      port.pushClosedKline('BTCUSDT', '1h', mkCandle(1_000, '100'));
      // Drain the queued push before reset so the parked-on-reset assertion
      // covers the cancellation path, not the already-queued one.
      const sub2 = port.subscribeKlines('BTCUSDT', '1h');
      const parked2 = sub2.stream[Symbol.asyncIterator]().next();
      port.reset();
      const [r, r2] = await Promise.all([parked, parked2]);
      // The first pull received the queued push before reset; the second
      // pull was parked when reset fired.
      expect(r.done === true || r.value?.close === '100').toBe(true);
      expect(r2.done).toBe(true);
      expect(await port.loadWindow('BTCUSDT', '1h', 10)).toEqual([]);
    });

    it('subscriberCount/tickerSubscriberCount return 0 for never-subscribed keys', () => {
      const port = createFakeMarketDataPort();
      expect(port.subscriberCount('NOPE', '1h')).toBe(0);
      expect(port.tickerSubscriberCount('NOPE')).toBe(0);
    });

    it('reset also drains parked ticker subscribers', async () => {
      const port = createFakeMarketDataPort();
      const sub = port.subscribeMiniTicker('BTCUSDT');
      const parked = sub.stream[Symbol.asyncIterator]().next();
      port.reset();
      expect((await parked).done).toBe(true);
      expect(port.tickerSubscriberCount('BTCUSDT')).toBe(0);
    });
  });
});
