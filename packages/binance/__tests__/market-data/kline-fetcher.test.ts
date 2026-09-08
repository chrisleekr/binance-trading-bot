// KlineFetcher contract tests.
//
// Drive the adapter against a fake WS factory + an in-process REST stub
// so every lifecycle decision is asserted deterministically. The asserts
// cover the contract production must satisfy:
//   - First subscribe on a key opens the WS and sends `SUBSCRIBE`; last
//     unsubscribe sends `UNSUBSCRIBE` and closes the WS if no key remains.
//   - A still-forming candle (`x: false`) is silently dropped.
//   - Multiple subscribers on the same key share one WS subscription and
//     each see every closed candle.
//   - `loadWindow` answers from the ring when full; falls back to REST
//     when short; honours the weight governor on REST.
//   - Reconnect: WS close → backoff schedule fires a reconnect.
//   - `shutdown` drains every subscriber, closes the WS, drops the rings.

import { describe, expect, it, vi } from 'vitest';

import {
  BINANCE_MAX_KLINE_LIMIT,
  createKlineFetcher,
  createWeightGovernor,
  type BinanceWs,
  type BinanceWsFactory,
  type ClosedKline,
  type KlineFetcher,
} from '../../src/index.js';

type KlineFetcherLogger = Parameters<typeof createKlineFetcher>[0]['logger'];

const silentLogger: KlineFetcherLogger = {
  info: vi.fn<KlineFetcherLogger['info']>(),
  warn: vi.fn<KlineFetcherLogger['warn']>(),
};

interface FakeWs extends BinanceWs {
  /** Sends recorded on this socket. */
  readonly sends: string[];
  /** Trigger the open / message / close / error handlers from tests. */
  triggerOpen(): void;
  triggerMessage(payload: string): void;
  triggerClose(): void;
  triggerError(err: Error): void;
  /** True after `close()` was called. */
  isClosed(): boolean;
  /** The URL the factory was constructed with. */
  readonly url: string;
}

const makeFactory = (): { factory: BinanceWsFactory; sockets: FakeWs[] } => {
  const sockets: FakeWs[] = [];
  const factory: BinanceWsFactory = (url) => {
    let onOpen: (() => void) | null = null;
    let onMessage: ((data: string) => void) | null = null;
    let onClose: (() => void) | null = null;
    let onError: ((err: Error) => void) | null = null;
    let closed = false;
    const sends: string[] = [];
    const sock: FakeWs = {
      url,
      sends,
      send(payload) {
        sends.push(payload);
      },
      close() {
        closed = true;
      },
      onOpen(h) {
        onOpen = h;
      },
      onMessage(h) {
        onMessage = h;
      },
      onClose(h) {
        onClose = h;
      },
      onError(h) {
        onError = h;
      },
      triggerOpen() {
        onOpen?.();
      },
      triggerMessage(payload) {
        onMessage?.(payload);
      },
      triggerClose() {
        onClose?.();
      },
      triggerError(err) {
        onError?.(err);
      },
      isClosed() {
        return closed;
      },
    };
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets };
};

const mkClosedKline = (openMs: number, close: string): ClosedKline => ({
  openTimeMs: openMs,
  closeTimeMs: openMs + 60_000 - 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const klineFrame = (
  stream: string,
  candle: { openMs: number; closeMs: number; close: string; isClosed: boolean },
): string =>
  JSON.stringify({
    stream,
    data: {
      e: 'kline',
      s: stream.split('@')[0]?.toUpperCase() ?? '',
      k: {
        t: candle.openMs,
        T: candle.closeMs,
        o: candle.close,
        h: candle.close,
        l: candle.close,
        c: candle.close,
        v: '1',
        x: candle.isClosed,
      },
    },
  });

const sync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const collect = async <T>(stream: AsyncIterable<T>, count: number): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of stream) {
    out.push(v);
    if (out.length >= count) break;
  }
  return out;
};

describe('createKlineFetcher', () => {
  describe('subscribe / unsubscribe lifecycle', () => {
    it('opens the WS on the first subscribe and closes it on the last unsubscribe', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      expect(fetcher.isConnected()).toBe(false);
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      // isConnected reports OPEN status — CONNECTING is not "connected"
      // since `send` would throw.
      expect(fetcher.isConnected()).toBe(false);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toContain('btcusdt%40kline_1h');
      sockets[0]?.triggerOpen();
      expect(fetcher.isConnected()).toBe(true);
      sub.unsubscribe();
      expect(fetcher.isConnected()).toBe(false);
      expect(sockets[0]?.isClosed()).toBe(true);
    });

    it('first subscribe on a NEW key on an open WS sends SUBSCRIBE without reopening', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const b = fetcher.subscribeKlines('ETHUSDT', '1h');
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.sends).toHaveLength(1);
      const rpc = JSON.parse(sockets[0]?.sends[0] ?? '{}') as {
        method?: string;
        params?: string[];
      };
      expect(rpc.method).toBe('SUBSCRIBE');
      expect(rpc.params).toEqual(['ethusdt@kline_1h']);
      a.unsubscribe();
      b.unsubscribe();
    });

    it('last unsubscribe on a multi-key fetcher sends UNSUBSCRIBE for that one key only', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const b = fetcher.subscribeKlines('ETHUSDT', '1h');
      const sendsBefore = sockets[0]?.sends.length ?? 0;
      a.unsubscribe();
      const lastSend = sockets[0]?.sends[sendsBefore];
      expect(JSON.parse(lastSend ?? '{}')).toMatchObject({
        method: 'UNSUBSCRIBE',
        params: ['btcusdt@kline_1h'],
      });
      // ETH still subscribed → connection stays open.
      expect(fetcher.isConnected()).toBe(true);
      b.unsubscribe();
      expect(fetcher.isConnected()).toBe(false);
    });

    it('buffers SUBSCRIBE rpcs sent during the CONNECTING window and flushes on open', () => {
      // Regression: `ws@8.send` throws synchronously while readyState is
      // CONNECTING. MarketSubscriptionsManager calls subscribeKlines
      // twice + subscribeMiniTicker once back-to-back for every symbol
      // it activates, so all three land before the WS open event. The
      // fetcher must NOT call `send` on the underlying socket until the
      // first open, and on open it must deliver every queued stream.
      const { factory, sockets } = makeFactory();
      // Simulate the real `ws` library by throwing if `send` is called
      // before `triggerOpen()`. If the buffer regresses, this throws.
      let opened = false;
      const guardedFactory: BinanceWsFactory = (url) => {
        const sock = factory(url) as FakeWs;
        const realSend = sock.send.bind(sock);
        sock.send = (payload: string): void => {
          if (!opened) {
            throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
          }
          realSend(payload);
        };
        const realOpen = sock.triggerOpen.bind(sock);
        sock.triggerOpen = (): void => {
          opened = true;
          realOpen();
        };
        return sock;
      };
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: guardedFactory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // All three subscribes run synchronously in the same tick — the
      // exact pattern MarketSubscriptionsManager.addSymbols uses.
      const klineSub = fetcher.subscribeKlines('BTCUSDT', '1h');
      const klineSub1d = fetcher.subscribeKlines('BTCUSDT', '1d');
      const tickerSub = fetcher.subscribeMiniTicker('BTCUSDT');
      // Pre-open: nothing on the wire — the URL alone holds the streams.
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.sends).toHaveLength(0);
      // Only the FIRST key is in the URL; the rest arrive via SUBSCRIBE
      // after open.
      expect(sockets[0]?.url).toContain('btcusdt%40kline_1h');
      sockets[0]?.triggerOpen();
      expect(sockets[0]?.sends).toHaveLength(1);
      const rpc = JSON.parse(sockets[0]?.sends[0] ?? '{}') as {
        method?: string;
        params?: string[];
      };
      expect(rpc.method).toBe('SUBSCRIBE');
      expect(new Set(rpc.params)).toEqual(new Set(['btcusdt@kline_1d', 'btcusdt@miniTicker']));
      klineSub.unsubscribe();
      klineSub1d.unsubscribe();
      tickerSub.unsubscribe();
    });

    it('collapses a subscribe→unsubscribe within the CONNECTING window so the post-open SUBSCRIBE omits it', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      const b = fetcher.subscribeKlines('ETHUSDT', '1h');
      b.unsubscribe();
      sockets[0]?.triggerOpen();
      // The kline_1h for ETH was added to pending then removed; nothing
      // should ride out on the wire.
      expect(sockets[0]?.sends).toHaveLength(0);
      a.unsubscribe();
    });

    it('incremental subscribe past per-connection cap opens a new member', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // First key rides the URL and opens member #0.
      const subs = [fetcher.subscribeKlines('SYM0USDT', '1h')];
      sockets[0]?.triggerOpen();
      // 1024 more distinct keys: total streams = 1025 > one member's 1024 cap.
      // The 1024th incremental key must spill onto a SECOND member connection.
      for (let i = 1; i <= 1024; i++) {
        subs.push(fetcher.subscribeKlines(`SYM${i}USDT`, '1h'));
      }
      expect(sockets).toHaveLength(2);
      for (const s of subs) s.unsubscribe();
    });

    it('multiple subscribers on the same key share one WS subscription', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      const b = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Only one socket; no SUBSCRIBE RPC sent for `b` since the key was
      // already in the URL.
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.sends).toHaveLength(0);
      expect(fetcher.subscriberCount('BTCUSDT', '1h')).toBe(2);
      a.unsubscribe();
      expect(fetcher.subscriberCount('BTCUSDT', '1h')).toBe(1);
      // First unsubscribe did NOT remove the key (b still holds a ref).
      expect(sockets[0]?.sends).toHaveLength(0);
      b.unsubscribe();
      expect(fetcher.subscriberCount('BTCUSDT', '1h')).toBe(0);
    });
  });

  describe('frame routing', () => {
    it('fans a closed kline out to every subscriber on that key', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      const b = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 1_000,
          closeMs: 60_999,
          close: '100',
          isClosed: true,
        }),
      );
      const [aOne, bOne] = await Promise.all([collect(a.stream, 1), collect(b.stream, 1)]);
      a.unsubscribe();
      b.unsubscribe();
      expect(aOne[0]?.close).toBe('100');
      expect(bOne[0]?.close).toBe('100');
    });

    it('silently drops a still-forming candle (isClosed === false)', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 1_000,
          closeMs: 60_999,
          close: '100',
          isClosed: false,
        }),
      );
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 1_000,
          closeMs: 60_999,
          close: '101',
          isClosed: true,
        }),
      );
      const received = await collect(sub.stream, 1);
      sub.unsubscribe();
      expect(received).toHaveLength(1);
      expect(received[0]?.close).toBe('101');
      expect(received[0]?.isClosed).toBe(true);
    });

    it('ignores SUBSCRIBE/UNSUBSCRIBE ACK frames without a `stream` envelope', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // ACK shape: { result: null, id: 1 } — no `stream`/`data` envelope.
      expect(() =>
        sockets[0]?.triggerMessage(JSON.stringify({ result: null, id: 1 })),
      ).not.toThrow();
      sub.unsubscribe();
    });

    it('warn-logs and continues on invalid JSON', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(() => sockets[0]?.triggerMessage('{not-json')).not.toThrow();
      sub.unsubscribe();
    });
  });

  describe('loadWindow', () => {
    it('returns the ring when it is long enough', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        ringSize: 100,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      for (let i = 0; i < 10; i++) {
        sockets[0]?.triggerMessage(
          klineFrame('btcusdt@kline_1h', {
            openMs: i * 1000,
            closeMs: i * 1000 + 999,
            close: String(100 + i),
            isClosed: true,
          }),
        );
      }
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 3);
      sub.unsubscribe();
      expect(w.map((k) => k.close)).toEqual(['107', '108', '109']);
    });

    it('memoises the window between candle closes and recomputes after one', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        ringSize: 100,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const push = (i: number): void =>
        sockets[0]?.triggerMessage(
          klineFrame('btcusdt@kline_1h', {
            openMs: i * 1000,
            closeMs: i * 1000 + 999,
            close: String(100 + i),
            isClosed: true,
          }),
        );
      for (let i = 0; i < 5; i++) push(i);
      // Let the async cold-load settle first — it rebuilds the ring and clears
      // the memo, which would otherwise race the identity assertions below.
      await sync();

      const first = await fetcher.loadWindow('BTCUSDT', '1h', 3);
      const second = await fetcher.loadWindow('BTCUSDT', '1h', 3);
      // Same ring, same size → the exact memoised array is returned (no re-copy).
      expect(second).toBe(first);
      expect(second.map((k) => k.close)).toEqual(['102', '103', '104']);

      // A different size recomputes (and re-caches) rather than serving the stale size.
      const wider = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      expect(wider).not.toBe(first);
      expect(wider.map((k) => k.close)).toEqual(['103', '104']);

      // A new closed candle invalidates the memo → a fresh array with new content.
      push(5);
      const afterClose = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      expect(afterClose).not.toBe(wider);
      expect(afterClose.map((k) => k.close)).toEqual(['104', '105']);
      sub.unsubscribe();
    });

    it('falls back to REST when the ring is short and the key is unsubscribed', async () => {
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 50);
      expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', 51);
      expect(w.map((k) => k.close)).toEqual(['100', '101']);
    });

    it('backfills a subscribed short ring once and asks for one bar more than the window', async () => {
      const rest = vi.fn(async () => [
        mkClosedKline(1000, '100'),
        mkClosedKline(2000, '101'),
        mkClosedKline(3000, '102'),
      ]);
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Let the cold-load settle, then scope the spy to loadWindow's own calls.
      await sync();
      rest.mockClear();

      // Ring holds 3 candles; ask for 20 twice inside the same candle.
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // A REST result that the ring never absorbs re-fetches every tick, ~1/s/symbol/interval in production.
      expect(rest).toHaveBeenCalledTimes(1);
      // fetchClosedKlines drops the still-forming bar, so a limit of `size` yields `size - 1` closed candles and the caller's `length >= size` gate can never pass.
      expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', 21);
    });

    it('re-fetches per call for an unsubscribed key and still adds no subscriber', async () => {
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      // Nothing holds a memo for an unsubscribed key, and nothing would ever invalidate one, so each call re-fetches.
      expect(rest).toHaveBeenCalledTimes(2);
      // loadWindow is a pull-style seed: no WS, no ring, no subscriber.
      expect(sockets).toHaveLength(0);
      expect(fetcher.subscriberCount('BTCUSDT', '1h')).toBe(0);
      expect(fetcher.activeKeyCount()).toBe(0);
    });

    it('re-fetches an above-ring window once the candle it was cached against closes', async () => {
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 9000,
          closeMs: 9999,
          close: '109',
          isClosed: true,
        }),
      );
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // A closed candle moves the ring, so the memo must not outlive it.
      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('does not cache a REST window that a candle close overtook mid-flight', async () => {
      // Hand back a promise the test resolves by hand, so a candle can close while the request is still out.
      const pending: ((rows: ClosedKline[]) => void)[] = [];
      const rest = vi.fn(() => new Promise<ClosedKline[]>((resolve) => pending.push(resolve)));
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Settle the cold-load first; it is the first in-flight request.
      pending.shift()?.([mkClosedKline(1000, '100')]);
      await sync();
      rest.mockClear();

      const inFlight = fetcher.loadWindow('BTCUSDT', '1h', 20);
      // The ring moves while the request is out, so the rows about to resolve were read from before that close.
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 9000,
          closeMs: 9999,
          close: '109',
          isClosed: true,
        }),
      );
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await inFlight;
      rest.mockClear();

      const next = fetcher.loadWindow('BTCUSDT', '1h', 20);
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await next;
      sub.unsubscribe();
      // Caching that window would pin the strategy to pre-close candles until the NEXT close, which is a whole candle period of stale data.
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('never asks Binance for more rows than the klines endpoint accepts', async () => {
      const rest = vi.fn(async () => [mkClosedKline(1000, '100')]);
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      await fetcher.loadWindow('BTCUSDT', '1h', BINANCE_MAX_KLINE_LIMIT);
      // size + 1 would exceed the ceiling and Binance rejects the request.
      expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', BINANCE_MAX_KLINE_LIMIT);
    });

    it('memoises per window size so two sizes on one key never evict each other', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      // The key is (symbol, interval) but the size is per profile: 20 is above the 6-candle ring so it costs a REST fetch, 5 comes off the ring. Two profiles on one symbol with different lookbacks interleave exactly like this, every tick.
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      await fetcher.loadWindow('BTCUSDT', '1h', 5);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // A one-slot memo loses the above-ring answer to every interleaved call, putting it back on a REST fetch per tick — the storm this memo exists to remove.
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('bounds the per-size memo so a caller cycling sizes cannot grow it without limit', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      // One above-ring size that cost a request, then five ring-served ones cycling past the ceiling. Sizes cycling once per tick is the real access pattern, and under it the map has to stay bounded WITHOUT spending the one entry that is expensive to rebuild.
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      const firstOne = await fetcher.loadWindow('BTCUSDT', '1h', 1);
      for (const size of [2, 3, 4]) await fetcher.loadWindow('BTCUSDT', '1h', size);
      const secondOne = await fetcher.loadWindow('BTCUSDT', '1h', 1);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // Size 1 was evicted somewhere in the cycle, so the map never grew to hold all five sizes at once.
      expect(secondOne).not.toBe(firstOne);
      // The above-ring answer survived every eviction. A policy that can spend it — a wholesale clear, but FIFO and LRU too, since this cycle touches the cheap sizes more recently than the expensive one — puts it back on a weight-2 request per tick, which is the storm the memo exists to remove.
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('spends the oldest REST entry only when the cap holds nothing cheaper', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      // Every size is above the 6-candle ring, so the map fills with nothing but expensive entries and the ring-first preference has no candidate.
      for (const size of [20, 21, 22, 23, 24]) await fetcher.loadWindow('BTCUSDT', '1h', size);
      expect(rest).toHaveBeenCalledTimes(5);

      // The newest entry is still memoised; the oldest was the one spent to make room for it.
      await fetcher.loadWindow('BTCUSDT', '1h', 24);
      expect(rest).toHaveBeenCalledTimes(5);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();
      expect(rest).toHaveBeenCalledTimes(6);
    });

    it('expires a memo on wall-clock age so a silent stream cannot freeze a window', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      let clockMs = 1_000_000;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        now: () => clockMs,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      // No close, no candle: the socket stays open and only THIS stream stopped delivering, which is the shape every other invalidator is blind to — onClose never fires, fanOut never runs, and msSinceLastFrame is per member so the member's other streams keep it healthy.
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(1);

      // One ms short of the bound, asserted BEFORE the expiry step: without this side, any bound at all passes — a 1ms one included, which would restore the per-tick REST storm the memo exists to remove — because the still-served read would otherwise be taken at an age of zero. A memo hit returns without re-stamping `installedAtMs`, so both reads measure from the same install.
      clockMs += 59_999;
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(1);

      clockMs += 1;
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // Without an age bound this window is served for the whole silence, against the live mini-ticker price the liveness watchdog keeps ticks running on.
      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('refetches when the clock steps backwards under an installed memo', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      let clockMs = 1_000_000;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        now: () => clockMs,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(1);

      // Production passes no `now`, so this clock is `Date.now` — wall clock, which an NTP correction or a container resync can step BACKWARDS. A bare `age < MAX` reads the resulting negative age as fresh and pins the entry until the clock catches up, on exactly the silent-stream key where no socket event can invalidate it either.
      clockMs -= 5_000;
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('refuses a slower REST install that would replace a newer answer', async () => {
      const pending: ((rows: ClosedKline[]) => void)[] = [];
      const rest = vi.fn(() => new Promise<ClosedKline[]>((resolve) => pending.push(resolve)));
      let clockMs = 1_000_000;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        now: () => clockMs,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      pending.shift()?.([mkClosedKline(1000, '100')]);
      await sync();
      rest.mockClear();

      // Two concurrent calls for one (symbol, interval, size) is the production shape: the tick assembler issues one per interval per profile, and two profiles on the same symbol tick on separate chains, so both miss the memo and both fetch. Resolved in start order here, so the later install is not stale and must land.
      const first = fetcher.loadWindow('BTCUSDT', '1h', 20);
      const second = fetcher.loadWindow('BTCUSDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(2);
      pending.shift()?.([mkClosedKline(1000, '100')]);
      await first;
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await second;
      expect((await fetcher.loadWindow('BTCUSDT', '1h', 20)).map((k) => k.close)).toEqual([
        '100',
        '101',
      ]);
      expect(rest).toHaveBeenCalledTimes(2);

      // Same pair, resolved out of order. The age bound drops the entry above so both calls reach REST again.
      clockMs += 60_000;
      const slow = fetcher.loadWindow('BTCUSDT', '1h', 20);
      clockMs += 1_000;
      const fast = fetcher.loadWindow('BTCUSDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(4);
      const slowResolve = pending.shift();
      const fastResolve = pending.shift();
      fastResolve?.([
        mkClosedKline(1000, '100'),
        mkClosedKline(2000, '101'),
        mkClosedKline(3000, '102'),
      ]);
      await fast;
      slowResolve?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await slow;

      const served = await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();
      // Letting the slower call install would swap the newer candles for older ones AND re-stamp them as freshly installed, so the age backstop would then serve the older answer for a further full MEMO_MAX_AGE_MS.
      expect(served.map((k) => k.close)).toEqual(['100', '101', '102']);
      expect(rest).toHaveBeenCalledTimes(4);
    });

    it('refuses a REST window the cold-load rebuild overtook while it was in flight', async () => {
      // The interleaving the generation bump exists for, and the mirror of the `drops a memo installed before the cold load rebuilt the ring under it` case above: there the memo is already installed when the rebuild lands and the wholesale clear covers it, here the rebuild lands FIRST and only the generation can tell the in-flight request its answer is stale.
      const pending: ((rows: ClosedKline[]) => void)[] = [];
      const rest = vi.fn(() => new Promise<ClosedKline[]>((resolve) => pending.push(resolve)));
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const settleColdLoad = pending.shift();
      expect(settleColdLoad).toBeDefined();

      const inFlight = fetcher.loadWindow('BTCUSDT', '1h', 20);
      const settleWindow = pending.shift();
      expect(settleWindow).toBeDefined();

      settleColdLoad?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await sync();
      settleWindow?.([mkClosedKline(1000, '100')]);
      await inFlight;
      rest.mockClear();

      const next = fetcher.loadWindow('BTCUSDT', '1h', 20);
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await next;
      sub.unsubscribe();

      // Installing that window would pin the key to the one-candle answer it read before its history arrived, for a whole candle period on a key that has just been seeded.
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('refuses a REST window whose socket closed while it was in flight', async () => {
      // The close clears the map, but the map is empty while the request is still out — only the generation survives to refuse the install when it lands.
      const pending: ((rows: ClosedKline[]) => void)[] = [];
      const rest = vi.fn(() => new Promise<ClosedKline[]>((resolve) => pending.push(resolve)));
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        // Park the reconnect so the feed stays down for the rest of the test.
        schedule: () => {},
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      pending.shift()?.([mkClosedKline(1000, '100')]);
      await sync();
      rest.mockClear();

      const inFlight = fetcher.loadWindow('BTCUSDT', '1h', 20);
      sockets[0]?.triggerClose();
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await inFlight;

      const next = fetcher.loadWindow('BTCUSDT', '1h', 20);
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await next;
      sub.unsubscribe();

      // No candle can arrive to invalidate an entry installed after the close, so it would be served for the whole outage against the live price.
      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('drops a memo installed before the cold load rebuilt the ring under it', async () => {
      // Hold the cold load open so a loadWindow can land between subscribe and rebuild — the one interleaving in which a memo is installed against an empty ring.
      const pending: ((rows: ClosedKline[]) => void)[] = [];
      const rest = vi.fn(() => new Promise<ClosedKline[]>((resolve) => pending.push(resolve)));
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // The cold-load request is issued synchronously by subscribeKlines; park its resolver rather than settling it.
      const settleColdLoad = pending.shift();
      expect(settleColdLoad).toBeDefined();

      const preSeed = fetcher.loadWindow('BTCUSDT', '1h', 20);
      await sync();
      pending.shift()?.([mkClosedKline(1000, '100')]);
      await preSeed;

      // The rebuild lands under the memo just installed. Nothing else can invalidate it: no candle has closed and the socket never dropped.
      settleColdLoad?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await sync();

      rest.mockClear();
      const after = fetcher.loadWindow('BTCUSDT', '1h', 20);
      await sync();
      pending.shift()?.([mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      await after;
      sub.unsubscribe();

      // Serving the pre-rebuild window would pin the strategy to a one-candle ring for a whole candle period, on a key that has just been given its history.
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('drops the memo when the socket closes so an above-ring window refreshes during the outage', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        // Park the reconnect so the close leaves the feed down for the duration of the test.
        schedule: () => {},
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      rest.mockClear();

      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sockets[0]?.triggerClose();
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      sub.unsubscribe();

      // No candle can arrive to invalidate the memo while the feed is down, so holding it would serve one pre-outage window for the whole gap — against the live price the liveness watchdog keeps synthesising.
      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('drops only the closing member memos and leaves a sibling member untouched', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 6 }, (_, i) => mkClosedKline(1000 * (i + 1), String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 10,
        schedule: () => {},
      });
      // 1025 streams spill onto a second pool member; SYM0 lands on member 0 and SYM1024 on member 1.
      const subs = [fetcher.subscribeKlines('SYM0USDT', '1h')];
      sockets[0]?.triggerOpen();
      for (let i = 1; i <= 1024; i++) subs.push(fetcher.subscribeKlines(`SYM${i}USDT`, '1h'));
      sockets[1]?.triggerOpen();
      await sync();
      rest.mockClear();

      await fetcher.loadWindow('SYM0USDT', '1h', 20);
      await fetcher.loadWindow('SYM1024USDT', '1h', 20);
      expect(rest).toHaveBeenCalledTimes(2);
      rest.mockClear();

      sockets[0]?.triggerClose();
      await fetcher.loadWindow('SYM0USDT', '1h', 20);
      await fetcher.loadWindow('SYM1024USDT', '1h', 20);
      for (const s of subs) s.unsubscribe();

      // Member 1 never went down and its candles still arrive, so evicting its memos would restart the per-tick REST storm on a healthy shard.
      expect(rest).toHaveBeenCalledTimes(1);
      expect(rest).toHaveBeenCalledWith('SYM0USDT', '1h', 21);
      // 1025 subscriptions plus their cold-loads outrun the 5s default on a loaded runner.
    }, 20_000);

    it('normalises a window size the worker may hand it unparsed', async () => {
      const warn = vi.fn<KlineFetcherLogger['warn']>();
      // Model the real client, which drops the still-forming bar: a limit of N comes back as N-1 closed rows. A stub returning a fixed row count would hide the whole point of the collapse below — at `limit=1` production gets NOTHING back.
      const rest = vi.fn(async (_symbol: string, _interval: string, limit: number) =>
        Array.from({ length: Math.max(0, limit - 1) }, (_, i) =>
          mkClosedKline(1000 * (i + 1), String(100 + i)),
        ),
      );
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: { info: vi.fn<KlineFetcherLogger['info']>(), warn },
      });
      // The worker may pass strategy config unparsed, so a hand-written or DB-written fractional window reaches here un-validated and would interpolate as `&limit=21.5`, which Binance rejects — failing every tick for that (profile, symbol), exits included.
      await fetcher.loadWindow('BTCUSDT', '1h', 20.5);
      expect(rest).toHaveBeenLastCalledWith('BTCUSDT', '1h', 22);
      // 21 closed rows satisfy a 20.5 window rounded up, so the collapse below is the only thing this test can be reading.
      expect(warn).not.toHaveBeenCalled();
      // Binance documents limit as an integer of at least 1, so a non-positive window must not send `limit=0`.
      await fetcher.loadWindow('BTCUSDT', '1h', -1);
      expect(rest).toHaveBeenLastCalledWith('BTCUSDT', '1h', 1);

      // The clamp is pure arithmetic and every step of it propagates a non-finite input, so without its own arm the value rides out as `&limit=NaN` and Binance rejects the request with nothing naming the malformed field. The smallest legal limit keeps the request well-formed — but that collapse is only visible if the SIZE is normalised the same way: read the slice bound and the short-window verdict off a raw NaN and `slice(NaN)` returns everything while `length < NaN` is false, so an empty window is memoised silently and served for a full minute. Asserting only the limit would pass with the warn dead.
      warn.mockClear();
      await fetcher.loadWindow('BTCUSDT', '1h', Number.NaN);
      expect(rest).toHaveBeenLastCalledWith('BTCUSDT', '1h', 1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        requestedSize: Number.NaN,
        normalisedSize: 1,
        returnedSize: 0,
        limit: 1,
        unfillable: true,
      });

      warn.mockClear();
      await fetcher.loadWindow('BTCUSDT', '1h', Number.POSITIVE_INFINITY);
      expect(rest).toHaveBeenLastCalledWith('BTCUSDT', '1h', 1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        requestedSize: Number.POSITIVE_INFINITY,
        normalisedSize: 1,
        returnedSize: 0,
        unfillable: true,
      });
    });

    it('warns when a REST window comes back short of the size asked for', async () => {
      const warn = vi.fn<KlineFetcherLogger['warn']>();
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: { info: vi.fn<KlineFetcherLogger['info']>(), warn },
      });
      await fetcher.loadWindow('BTCUSDT', '1h', 20);
      // The only downstream symptom is a strategy holding fail-closed and logging its own warm-up at debug, so silence here leaves an operator with no visible cause.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        symbol: 'BTCUSDT',
        interval: '1h',
        requestedSize: 20,
        returnedSize: 2,
        limit: 21,
        maxLimit: BINANCE_MAX_KLINE_LIMIT,
        // Recoverable: the symbol simply has less history than asked for and the window fills as candles close.
        unfillable: false,
      });

      await fetcher.loadWindow('BTCUSDT', '1h', BINANCE_MAX_KLINE_LIMIT + 5);
      // Unrecoverable: the request was clamped, so no amount of waiting fills this window and the operator has to lower it.
      expect(warn.mock.calls[1]?.[0]).toMatchObject({
        requestedSize: BINANCE_MAX_KLINE_LIMIT + 5,
        limit: BINANCE_MAX_KLINE_LIMIT,
        maxLimit: BINANCE_MAX_KLINE_LIMIT,
        unfillable: true,
      });

      await fetcher.loadWindow('BTCUSDT', '1h', BINANCE_MAX_KLINE_LIMIT - 1);
      // The boundary the verdict exists for. `MAX_CANDLE_WINDOW` is the single size `resolveCandleWindow` returns for EVERY config at or above the ceiling, including a maxed momentum profile, and it lands on the maximum limit naturally rather than by clamping: one request supplies exactly it. Reading the verdict off `limit === maxLimit` would tell the operator to lower the largest window the pipeline promises to serve.
      expect(warn.mock.calls[2]?.[0]).toMatchObject({
        requestedSize: BINANCE_MAX_KLINE_LIMIT - 1,
        limit: BINANCE_MAX_KLINE_LIMIT,
        maxLimit: BINANCE_MAX_KLINE_LIMIT,
        unfillable: false,
      });
    });

    it('stays silent when a REST window comes back complete', async () => {
      const warn = vi.fn<KlineFetcherLogger['warn']>();
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: { info: vi.fn<KlineFetcherLogger['info']>(), warn },
      });
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      expect(w).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reserves weight on the REST fallback when a governor is configured', async () => {
      const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
      const spy = vi.spyOn(governor, 'reserve');
      const rest = vi.fn(async () => [mkClosedKline(1000, '100')]);
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        weightGovernor: governor,
        logger: silentLogger,
      });
      await fetcher.loadWindow('BTCUSDT', '1h', 10);
      expect(spy).toHaveBeenCalledTimes(1);
      // klines is a flat weight 2 regardless of limit.
      expect(spy.mock.calls[0]?.[0]).toBe(2);
    });

    it('cold-loads a full ring by asking for one row more than it holds', async () => {
      const ringSize = 5;
      const rows = Array.from({ length: ringSize + 1 }, (_, i) =>
        mkClosedKline(1000 * (i + 1), String(100 + i)),
      );
      // Model the real client: fetchClosedKlines drops the still-forming bar, so a limit of N comes back as N-1 closed rows. A stub ignoring `limit` would pass the length assertion below even if restLimitFor stopped adding the +1.
      const rest = vi.fn(async (_symbol: string, _interval: string, limit: number) =>
        rows.slice(0, limit - 1),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', ringSize + 1);
      // A cold-load short by one leaves the ring below ringSize, and loadWindow then falls back to a SECOND REST request — which is what the call count below catches. The length assertion is not redundant with it: drop the +1 in `restLimitFor` itself and BOTH call sites lose it, so the fallback asks for `size` rows, gets `size - 1` closed ones, and the length is short too. What the count catches on its own is a loss confined to the cold-load call site, where the fallback still returns a full window.
      const w = await fetcher.loadWindow('BTCUSDT', '1h', ringSize);
      sub.unsubscribe();
      expect(rest).toHaveBeenCalledTimes(1);
      expect(w).toHaveLength(ringSize);
    });

    it('cold-loads the ring asynchronously on a new subscription', async () => {
      const rest = vi.fn(async () => [mkClosedKline(1000, '100'), mkClosedKline(2000, '101')]);
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Wait one tick so the cold-load Promise resolves and lands in the
      // ring before we query loadWindow.
      await sync();
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      sub.unsubscribe();
      expect(w.map((k) => k.close)).toEqual(['100', '101']);
      expect(rest).toHaveBeenCalled();
    });
  });

  describe('onReconnect callback', () => {
    it('is NOT fired on the initial WS open (cold start)', () => {
      const onReconnect = vi.fn();
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        onReconnect,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(onReconnect).not.toHaveBeenCalled();
      sub.unsubscribe();
    });

    it('IS fired on a subsequent reopen after close', () => {
      const onReconnect = vi.fn();
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        onReconnect,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      // Fire the reconnect — a fresh socket appears.
      scheduled[0]?.fn();
      expect(sockets).toHaveLength(2);
      expect(onReconnect).not.toHaveBeenCalled();
      sockets[1]?.triggerOpen();
      expect(onReconnect).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });

    it('swallows a thrown onReconnect handler so the WS path stays healthy', () => {
      const onReconnect = vi.fn(() => {
        throw new Error('handler boom');
      });
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        onReconnect,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      scheduled[0]?.fn();
      // Throws inside the open handler must not crash the fetcher.
      expect(() => sockets[1]?.triggerOpen()).not.toThrow();
      sub.unsubscribe();
    });

    it('setOnReconnect late-binds the handler used on reconnect', () => {
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      // Constructed as a leaf — no onReconnect arg, mirroring the boot wire.
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const onReconnect = vi.fn();
      fetcher.setOnReconnect(onReconnect);
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      scheduled[0]?.fn();
      sockets[1]?.triggerOpen();
      expect(onReconnect).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });
  });

  describe('reconnect', () => {
    it('schedules a reconnect with the configured backoff after a close', () => {
      const scheduled: { fn: () => void; ms: number }[] = [];
      const schedule = (fn: () => void, ms: number): void => {
        scheduled.push({ fn, ms });
      };
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.ms).toBe(100);
      // Fire the reconnect — a fresh socket appears.
      scheduled[0]?.fn();
      expect(sockets).toHaveLength(2);
      sub.unsubscribe();
    });

    it('does not double-connect when a new key reconnects the member before the scheduled reconnect fires', () => {
      const scheduled: { fn: () => void; ms: number }[] = [];
      const schedule = (fn: () => void, ms: number): void => {
        scheduled.push({ fn, ms });
      };
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule,
      });
      // Member opens its socket, then loses it: onClose nulls m.ws and arms a
      // pending reconnect. The member still holds its stream (spare capacity).
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      expect(scheduled).toHaveLength(1);
      expect(sockets).toHaveLength(1);
      // A NEW key routes to the SAME member (spare capacity) while m.ws === null,
      // so the subscribe path connects immediately → socket A (socket[1]).
      const b = fetcher.subscribeKlines('ETHUSDT', '1h');
      expect(sockets).toHaveLength(2);
      // The scheduled reconnect now fires; the idempotency guard must see the live
      // socket and return early, so NO second socket is built for the member.
      scheduled[0]?.fn();
      expect(sockets).toHaveLength(2);
      a.unsubscribe();
      b.unsubscribe();
    });

    it('escalates backoff across reconnects when the socket opens but never delivers a frame; a real frame resets it', () => {
      const scheduled: { fn: () => void; ms: number }[] = [];
      const schedule = (fn: () => void, ms: number): void => {
        scheduled.push({ fn, ms });
      };
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      // Cycle 1: open (NO frame) then close ⇒ schedule at initial 100.
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      scheduled[0]?.fn();
      // Cycle 2: open again (still NO frame) then close. Because no frame proved
      // the connection healthy, the backoff is NOT reset on open — it escalates.
      sockets[1]?.triggerOpen();
      sockets[1]?.triggerClose();
      scheduled[1]?.fn();
      expect(scheduled.map((s) => s.ms)).toEqual([100, 200]);
      // Cycle 3: open AND deliver a real frame ⇒ backoff resets to initial.
      sockets[2]?.triggerOpen();
      sockets[2]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 0,
          closeMs: 59_999,
          close: '100',
          isClosed: true,
        }),
      );
      sockets[2]?.triggerClose();
      expect(scheduled[2]?.ms).toBe(100);
      sub.unsubscribe();
    });

    it('does not reconnect after shutdown', async () => {
      const scheduled: { fn: () => void; ms: number }[] = [];
      const schedule = (fn: () => void, ms: number): void => {
        scheduled.push({ fn, ms });
      };
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await fetcher.shutdown();
      sockets[0]?.triggerClose();
      // No reconnect scheduled after shutdown.
      expect(scheduled).toHaveLength(0);
      sub.unsubscribe();
    });
  });

  describe('subscribeMiniTicker', () => {
    const tickerFrame = (symbol: string, closePrice: string, eventTimeMs = 1_000): string =>
      JSON.stringify({
        stream: `${symbol.toLowerCase()}@miniTicker`,
        data: { e: '24hrMiniTicker', E: eventTimeMs, s: symbol, c: closePrice },
      });

    it('opens the WS on the first ticker subscribe and includes miniTicker in the URL', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toContain('btcusdt%40miniTicker');
      sub.unsubscribe();
      expect(fetcher.isConnected()).toBe(false);
    });

    it('a kline subscriber plus a ticker subscriber share one WS connection', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const klineSub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const tickerSub = fetcher.subscribeMiniTicker('BTCUSDT');
      // ONE socket — ticker stream added via SUBSCRIBE RPC, not a new connection.
      expect(sockets).toHaveLength(1);
      const rpc = JSON.parse(sockets[0]?.sends[0] ?? '{}') as {
        method?: string;
        params?: string[];
      };
      expect(rpc.method).toBe('SUBSCRIBE');
      expect(rpc.params).toEqual(['btcusdt@miniTicker']);
      klineSub.unsubscribe();
      // Kline sub gone but ticker still active → WS stays open.
      expect(fetcher.isConnected()).toBe(true);
      tickerSub.unsubscribe();
      expect(fetcher.isConnected()).toBe(false);
    });

    it('routes a miniTicker frame to ticker subscribers and never to kline ones', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const tickerSub = fetcher.subscribeMiniTicker('BTCUSDT');
      const klineSub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerMessage(tickerFrame('BTCUSDT', '76800', 1_000));
      const [t] = await collect(tickerSub.stream, 1);
      expect(t).toEqual({ symbol: 'BTCUSDT', closePrice: '76800', eventTimeMs: 1_000 });
      // The kline subscriber's queue must be empty — a ticker frame is not a kline.
      expect(fetcher.subscriberCount('BTCUSDT', '1h')).toBe(1);
      tickerSub.unsubscribe();
      klineSub.unsubscribe();
    });

    it('multiple ticker subscribers on the same symbol all see the same event', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const a = fetcher.subscribeMiniTicker('BTCUSDT');
      const b = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerMessage(tickerFrame('BTCUSDT', '100'));
      const [aRes, bRes] = await Promise.all([collect(a.stream, 1), collect(b.stream, 1)]);
      a.unsubscribe();
      b.unsubscribe();
      expect(aRes[0]?.closePrice).toBe('100');
      expect(bRes[0]?.closePrice).toBe('100');
    });

    it('last unsubscribe on the last ticker key sends UNSUBSCRIBE and closes the WS', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      sub.unsubscribe();
      // WS was closed because no kline keys remain either.
      expect(sockets[0]?.isClosed()).toBe(true);
      expect(fetcher.isConnected()).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('drains every subscription and closes the WS', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Park a pull, then shutdown — the pull resolves done.
      const iterator = sub.stream[Symbol.asyncIterator]();
      const parked = iterator.next();
      await fetcher.shutdown();
      const result = await parked;
      expect(result.done).toBe(true);
      expect(sockets[0]?.isClosed()).toBe(true);
      expect(fetcher.activeKeyCount()).toBe(0);
    });

    it('drains parked ticker subscribers on shutdown', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      await fetcher.shutdown();
      expect((await parked).done).toBe(true);
      expect(sockets[0]?.isClosed()).toBe(true);
    });
  });

  describe('invalid frame guards', () => {
    const driveFrame = (payload: unknown): { fetcher: KlineFetcher; socket: FakeWs } => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      fetcher.subscribeKlines('BTCUSDT', '1h');
      fetcher.subscribeMiniTicker('BTCUSDT');
      const socket = sockets[0];
      if (!socket) throw new Error('no socket');
      socket.triggerOpen();
      socket.triggerMessage(JSON.stringify({ stream: 'btcusdt@kline_1h', data: payload }));
      return { fetcher, socket };
    };

    it('drops a kline frame whose data is not an object', () => {
      expect(() => driveFrame('not-an-object').fetcher.shutdown()).not.toThrow();
    });

    it('drops a kline frame whose `k` field types are wrong', () => {
      // `k` present but `t` is a string → the typeof guard returns null.
      expect(() =>
        driveFrame({ k: { t: 'bad', T: 1, o: '1', h: '1', l: '1', c: '1', v: '1', x: true } }),
      ).not.toThrow();
    });

    it('ignores a valid closed-kline frame for a key with no live subscriber', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // Subscribe 1h so a socket exists; deliver a well-formed 1d frame whose
      // (symbol, interval) key has no entry in byKey → the `!state` arm.
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(() =>
        sockets[0]?.triggerMessage(
          klineFrame('btcusdt@kline_1d', {
            openMs: 1_000,
            closeMs: 86_399_999,
            close: '100',
            isClosed: true,
          }),
        ),
      ).not.toThrow();
      sub.unsubscribe();
    });

    it('drops a frame on a stream with no `@` separator', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // No '@' in the stream name → parse helpers bail before channel split.
      expect(() =>
        sockets[0]?.triggerMessage(JSON.stringify({ stream: 'btcusdt', data: { k: {} } })),
      ).not.toThrow();
      void fetcher.shutdown();
    });

    it('drops a miniTicker frame missing the required E/c fields', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      // E is a string, c missing → parseMiniTickerFromFrame returns null.
      sockets[0]?.triggerMessage(
        JSON.stringify({ stream: 'btcusdt@miniTicker', data: { E: 'x' } }),
      );
      // Then a valid one to prove the subscriber is still healthy.
      sockets[0]?.triggerMessage(
        JSON.stringify({ stream: 'btcusdt@miniTicker', data: { e: 'x', E: 9, c: '1' } }),
      );
      const [t] = await collect(sub.stream, 1);
      expect(t?.closePrice).toBe('1');
      sub.unsubscribe();
    });

    it('ignores a miniTicker frame for an unknown symbol', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      // Valid miniTicker shape but for ETH — no subscriber → the `!tk` guard.
      expect(() =>
        sockets[0]?.triggerMessage(
          JSON.stringify({ stream: 'ethusdt@miniTicker', data: { e: 'x', E: 1, c: '1' } }),
        ),
      ).not.toThrow();
      void fetcher.shutdown();
    });
  });

  describe('error + lifecycle edge paths', () => {
    it('fans a kline to a PARKED subscriber via the waiter path', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Park a pull BEFORE the frame so fanOut resolves the waiter directly
      // (the `if (w)` arm) rather than queueing.
      const it = sub.stream[Symbol.asyncIterator]();
      const pull = it.next();
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 1_000,
          closeMs: 60_999,
          close: '100',
          isClosed: true,
        }),
      );
      const r = await pull;
      expect(r.value?.close).toBe('100');
      sub.unsubscribe();
    });

    it('evicts the oldest ring entry once ringSize is exceeded by WS frames', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        ringSize: 2,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      for (let i = 0; i < 4; i++) {
        sockets[0]?.triggerMessage(
          klineFrame('btcusdt@kline_1h', {
            openMs: i * 1000,
            closeMs: i * 1000 + 999,
            close: String(100 + i),
            isClosed: true,
          }),
        );
      }
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      // ring capped at 2 → only the two newest closes remain.
      expect(w.map((k) => k.close)).toEqual(['102', '103']);
      sub.unsubscribe();
    });

    it('routes a miniTicker frame to a PARKED ticker subscriber via the waiter path', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      const it = sub.stream[Symbol.asyncIterator]();
      const pull = it.next();
      sockets[0]?.triggerMessage(
        JSON.stringify({ stream: 'btcusdt@miniTicker', data: { e: 'x', E: 7, c: '99' } }),
      );
      const r = await pull;
      expect(r.value?.closePrice).toBe('99');
      sub.unsubscribe();
    });

    it('flushes a standalone pending UNSUBSCRIBE buffered during the CONNECTING window', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // All before open (CONNECTING window):
      //  - A is the first key → rides the URL, no pending RPC.
      //  - B is a new key → pending SUBSCRIBE.
      //  - unsubscribe A → A is NOT in pendingSubscribes, so it lands as a
      //    standalone pending UNSUBSCRIBE.
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      const b = fetcher.subscribeKlines('ETHUSDT', '1h');
      a.unsubscribe();
      sockets[0]?.triggerOpen();
      // On open both pending buffers flush: a SUBSCRIBE [eth] and an
      // UNSUBSCRIBE [btc].
      const methods = sockets[0]?.sends.map((s) => JSON.parse(s) as { method?: string }) ?? [];
      expect(methods.map((m) => m.method)).toEqual(
        expect.arrayContaining(['SUBSCRIBE', 'UNSUBSCRIBE']),
      );
      b.unsubscribe();
    });

    it('throws loudly once the pool exceeds the hard member ceiling', () => {
      const { factory } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // 16 members × 1024 streams = 16384 fills the pool exactly; the next
      // distinct stream needs a 17th member and must throw rather than silently
      // drop the subscription.
      const subs: { unsubscribe(): void }[] = [];
      const ceiling = 16 * 1024;
      for (let i = 0; i < ceiling; i++) {
        subs.push(fetcher.subscribeKlines(`SYM${i}USDT`, '1h'));
      }
      expect(() => fetcher.subscribeKlines('OVERFLOWUSDT', '1h')).toThrow(
        /pool exceeds 16 members/,
      );
      for (const s of subs) s.unsubscribe();
      // Subscribing 16384 streams is genuinely heavy synchronous work; the
      // default 5s test timeout flakes on an oversubscribed CI runner (observed
      // 6.2s), so give this one case headroom.
    }, 20_000);

    it('warn-logs a WS error without throwing', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(() => sockets[0]?.triggerError(new Error('socket reset'))).not.toThrow();
      void fetcher.shutdown();
    });

    it('does not schedule a reconnect when the close fires with no active subscribers', () => {
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Drop the only subscriber (closes the WS), THEN fire the close handler:
      // byKey and tickersBySymbol are now empty so no reconnect is scheduled.
      sub.unsubscribe();
      sockets[0]?.triggerClose();
      expect(scheduled).toHaveLength(0);
    });

    it('cancelSubscriber resolves a parked pull with done', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      sub.unsubscribe();
      expect((await parked).done).toBe(true);
      // A fresh pull on the cancelled kline iterator short-circuits to done.
      expect((await it.next()).done).toBe(true);
    });

    it('a cancelled ticker iterator next() returns done; cancel drains a parked ticker pull', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeMiniTicker('BTCUSDT');
      sockets[0]?.triggerOpen();
      const it = sub.stream[Symbol.asyncIterator]();
      const parked = it.next();
      sub.unsubscribe();
      expect((await parked).done).toBe(true);
      // A fresh pull on the cancelled iterator short-circuits to done.
      expect((await it.next()).done).toBe(true);
    });

    it('uses the default setTimeout-based schedule when none is injected', () => {
      vi.useFakeTimers();
      try {
        const { factory, sockets } = makeFactory();
        const fetcher = createKlineFetcher({
          wsUrl: 'wss://fake/ws',
          wsFactory: factory,
          fetchRestKlines: async () => [],
          logger: silentLogger,
          backoff: { initialMs: 50, maxMs: 100, factor: 2 },
        });
        const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
        sockets[0]?.triggerOpen();
        // Close with a still-active subscriber → the default schedule arms a
        // real timer (unref()'d). Advancing fake timers fires the reconnect.
        sockets[0]?.triggerClose();
        vi.advanceTimersByTime(50);
        expect(sockets).toHaveLength(2);
        sub.unsubscribe();
        void fetcher.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips a duplicate cold-load while one is already in flight', async () => {
      let resolveRest: ((v: ClosedKline[]) => void) | undefined;
      const rest = vi.fn(
        () =>
          new Promise<ClosedKline[]>((res) => {
            resolveRest = res;
          }),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      // First subscriber kicks a cold-load that never resolves yet.
      const a = fetcher.subscribeKlines('BTCUSDT', '1h');
      // Second subscriber on the SAME key: isNewKey is false so it won't
      // re-trigger; assert only one REST cold-load was issued for the key.
      const b = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(rest).toHaveBeenCalledTimes(1);
      resolveRest?.([mkClosedKline(1000, '100')]);
      await sync();
      a.unsubscribe();
      b.unsubscribe();
    });

    it('caps the cold-loaded ring to ringSize', async () => {
      const rest = vi.fn(async () =>
        Array.from({ length: 5 }, (_, i) => mkClosedKline(i * 1000, String(100 + i))),
      );
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
        ringSize: 2,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      const w = await fetcher.loadWindow('BTCUSDT', '1h', 2);
      // 5 fetched, ring capped to 2 → newest two retained.
      expect(w.map((k) => k.close)).toEqual(['103', '104']);
      sub.unsubscribe();
    });

    it('warn-logs and leaves the ring untouched when the cold-load REST throws', async () => {
      const rest = vi.fn(async () => {
        throw new Error('rest down');
      });
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      // Cold-load failed; a subsequently arriving WS candle still fans out.
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 1_000,
          closeMs: 60_999,
          close: '100',
          isClosed: true,
        }),
      );
      const [k] = await collect(sub.stream, 1);
      expect(k?.close).toBe('100');
      sub.unsubscribe();
    });

    it('reserves weight on the cold-load when a governor is configured', async () => {
      const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
      const spy = vi.spyOn(governor, 'reserve');
      const rest = vi.fn(async () => [mkClosedKline(1000, '100')]);
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: rest,
        weightGovernor: governor,
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await sync();
      expect(spy).toHaveBeenCalled();
      sub.unsubscribe();
    });
  });

  describe('liveness (msSinceLastFrame / forceReconnect)', () => {
    it('seeds the frame clock at construction and open, and bumps it on every frame', () => {
      let t = 1_000;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        now: () => t,
      });
      // Seeded at construction (1000), so a pre-connect read is bounded.
      t = 1_500;
      expect(fetcher.msSinceLastFrame()).toBe(500);

      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      t = 2_000;
      sockets[0]?.triggerOpen(); // reseeds lastFrameMs = 2000
      t = 2_300;
      expect(fetcher.msSinceLastFrame()).toBe(300);

      // A valid frame bumps the clock (the normal-path the watchdog relies on).
      t = 4_000;
      sockets[0]?.triggerMessage(
        klineFrame('btcusdt@kline_1h', {
          openMs: 0,
          closeMs: 59_999,
          close: '100',
          isClosed: true,
        }),
      );
      t = 4_150;
      expect(fetcher.msSinceLastFrame()).toBe(150);
      // Even an unrelated/malformed frame counts — it still arrived.
      t = 5_000;
      sockets[0]?.triggerMessage('not json');
      t = 5_200;
      expect(fetcher.msSinceLastFrame()).toBe(200);
      sub.unsubscribe();
    });

    it('forceReconnect closes the open socket, flips isConnected false, and the reconnect rebuilds it', () => {
      const scheduled: Array<() => void> = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule: (fn) => {
          scheduled.push(fn);
        },
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      expect(fetcher.isConnected()).toBe(true);

      fetcher.forceReconnect();
      expect(sockets[0]?.isClosed()).toBe(true);
      // Flipped synchronously so a caller can fall through to its gap path.
      expect(fetcher.isConnected()).toBe(false);

      // The closed socket fires onClose → reconnect is scheduled; run it.
      sockets[0]?.triggerClose();
      const reconnect = scheduled[0];
      expect(reconnect).toBeDefined();
      reconnect?.();
      expect(sockets).toHaveLength(2);
      sockets[1]?.triggerOpen();
      expect(fetcher.isConnected()).toBe(true);
      sub.unsubscribe();
    });

    it('forceReconnect is a no-op before connect (no socket) and while still CONNECTING', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      // ws === null before any subscribe.
      fetcher.forceReconnect();
      expect(sockets).toHaveLength(0);

      // Socket exists but CONNECTING (not yet open) ⇒ !isOpen ⇒ no-op.
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      expect(sockets).toHaveLength(1);
      fetcher.forceReconnect();
      expect(sockets[0]?.isClosed()).toBe(false);
      sub.unsubscribe();
    });

    it('forceReconnect is a no-op after shutdown (stopped)', async () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      await fetcher.shutdown();
      const closesBefore = sockets.filter((s) => s.isClosed()).length;
      fetcher.forceReconnect();
      // No new close beyond shutdown's own.
      expect(sockets.filter((s) => s.isClosed()).length).toBe(closesBefore);
      sub.unsubscribe();
    });

    it('forceReconnect swallows a throwing close() (best-effort)', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      fetcher.subscribeKlines('BTCUSDT', '1h');
      const sock = sockets[0];
      if (!sock) throw new Error('expected a socket');
      sock.triggerOpen();
      // Make the underlying close throw to exercise the best-effort catch.
      sock.close = () => {
        throw new Error('close boom');
      };
      expect(() => fetcher.forceReconnect()).not.toThrow();
      expect(fetcher.isConnected()).toBe(false);
      // No unsubscribe cleanup: the overridden close() throws, and teardown
      // would re-close the socket; the assertions above are the contract.
    });
  });

  describe('connection-pool sharding (multi-member)', () => {
    // Drives N distinct keys onto the fetcher; member #0 carries the first 1024,
    // and the 1025th key spills onto member #1. Returns both sockets + subs.
    const fillPastFirstMember = (
      fetcher: KlineFetcher,
      sockets: FakeWs[],
    ): { subs: { unsubscribe(): void }[]; spillStream: string } => {
      const subs = [fetcher.subscribeKlines('SYM0USDT', '1h')];
      sockets[0]?.triggerOpen();
      // 1023 more fills member #0 to its 1024 cap.
      for (let i = 1; i < 1024; i++) {
        subs.push(fetcher.subscribeKlines(`SYM${i}USDT`, '1h'));
      }
      // The 1025th key (index 1024) cannot fit member #0 → new member #1.
      subs.push(fetcher.subscribeKlines('SYM1024USDT', '1h'));
      return { subs, spillStream: 'sym1024usdt@kline_1h' };
    };

    it('keeps one member while under the per-connection cap', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const subs = [fetcher.subscribeKlines('SYM0USDT', '1h')];
      sockets[0]?.triggerOpen();
      // Fill exactly to the cap (1024 streams) — still one member.
      for (let i = 1; i < 1024; i++) {
        subs.push(fetcher.subscribeKlines(`SYM${i}USDT`, '1h'));
      }
      expect(sockets).toHaveLength(1);
      for (const s of subs) s.unsubscribe();
    });

    it('spills the 1025th stream onto a second member and routes its SUBSCRIBE there', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const { subs, spillStream } = fillPastFirstMember(fetcher, sockets);
      expect(sockets).toHaveLength(2);
      // Member #1 opened with the spill stream in its URL (it was the member's
      // first key, so it rides the connect URL, not a SUBSCRIBE rpc).
      expect(sockets[1]?.url).toContain(encodeURIComponent(spillStream));
      // Aggregate counts sum across members: 1025 distinct keys.
      expect(fetcher.activeKeyCount()).toBe(1025);
      for (const s of subs) s.unsubscribe();
    });

    it('isConnected is all-open: false while any non-empty member is not open', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const { subs } = fillPastFirstMember(fetcher, sockets);
      // Member #0 open, member #1 still CONNECTING → aggregate is not whole.
      expect(fetcher.isConnected()).toBe(false);
      sockets[1]?.triggerOpen();
      expect(fetcher.isConnected()).toBe(true);
      for (const s of subs) s.unsubscribe();
    });

    it('reconnects and resubscribes ONLY the closed member, leaving the other untouched', () => {
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        backoff: { initialMs: 100, maxMs: 1000, factor: 2 },
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const { subs } = fillPastFirstMember(fetcher, sockets);
      sockets[1]?.triggerOpen();
      const member0SendsBefore = sockets[0]?.sends.length ?? 0;
      // Close member #1 only; it schedules its own reconnect.
      sockets[1]?.triggerClose();
      expect(scheduled).toHaveLength(1);
      scheduled[0]?.fn();
      // A fresh socket (member #1's reconnect) appears; member #0 is untouched.
      expect(sockets).toHaveLength(3);
      const reconnectUrl = sockets[2]?.url ?? '';
      // The reconnect URL carries ONLY member #1's stream, not member #0's keys.
      expect(reconnectUrl).toContain(encodeURIComponent('sym1024usdt@kline_1h'));
      expect(reconnectUrl).not.toContain(encodeURIComponent('sym0usdt@kline_1h'));
      // Member #0 sent no new rpc during the peer's reconnect.
      expect(sockets[0]?.sends.length ?? 0).toBe(member0SendsBefore);
      for (const s of subs) s.unsubscribe();
    });

    it('msSinceLastFrame takes the worst case across members', () => {
      let t = 1_000;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        now: () => t,
      });
      const { subs } = fillPastFirstMember(fetcher, sockets);
      t = 2_000;
      sockets[1]?.triggerOpen(); // member #1 reseeds lastFrameMs = 2000
      // Member #0 delivers a fresh frame; member #1 stays silent.
      t = 5_000;
      sockets[0]?.triggerMessage(
        klineFrame('sym0usdt@kline_1h', {
          openMs: 0,
          closeMs: 59_999,
          close: '100',
          isClosed: true,
        }),
      );
      // Worst case = member #1's stale clock (2000), not member #0's fresh 5000.
      t = 6_000;
      expect(fetcher.msSinceLastFrame()).toBe(4_000);
      for (const s of subs) s.unsubscribe();
    });

    it('forceReconnect force-closes EVERY open member', () => {
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const { subs } = fillPastFirstMember(fetcher, sockets);
      sockets[1]?.triggerOpen();
      expect(fetcher.isConnected()).toBe(true);
      fetcher.forceReconnect();
      // Both members' sockets were closed.
      expect(sockets[0]?.isClosed()).toBe(true);
      expect(sockets[1]?.isClosed()).toBe(true);
      expect(fetcher.isConnected()).toBe(false);
      for (const s of subs) s.unsubscribe();
    });

    it('shutdown tolerates a member whose socket is already closed (mid-reconnect)', async () => {
      const scheduled: { fn: () => void }[] = [];
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule: (fn) => {
          scheduled.push({ fn });
        },
      });
      const sub = fetcher.subscribeKlines('BTCUSDT', '1h');
      sockets[0]?.triggerOpen();
      // Close the socket WITHOUT firing the reconnect: the member stays in the
      // pool with ws === null (a reconnect is scheduled but pending).
      sockets[0]?.triggerClose();
      expect(scheduled).toHaveLength(1);
      // Shutdown must skip the null-socket member's close() without throwing.
      await expect(fetcher.shutdown()).resolves.toBeUndefined();
      sub.unsubscribe();
    });

    it('prunes an emptied member and closes its socket while the other survives', () => {
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
      });
      const { subs } = fillPastFirstMember(fetcher, sockets);
      sockets[1]?.triggerOpen();
      // Unsubscribe the lone key on member #1 → that member is pruned + closed,
      // member #0 stays open.
      subs[subs.length - 1]?.unsubscribe();
      expect(sockets[1]?.isClosed()).toBe(true);
      expect(sockets[0]?.isClosed()).toBe(false);
      // Aggregate now reads whole again (only member #0 remains, and it's open).
      expect(fetcher.isConnected()).toBe(true);
      for (let i = 0; i < subs.length - 1; i++) subs[i]?.unsubscribe();
    });
  });
});
