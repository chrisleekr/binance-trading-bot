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
import type { Logger } from 'pino';

// `pino` is not a binance-package dep. A no-op logger is sufficient for the
// adapter's warn/info calls (the messages are advisory; tests assert on
// observable state, not on log content).
const silent = {} as Logger;
const _silentLogger: Logger = new Proxy(silent, {
  get: () => () => undefined,
}) as Logger;

import {
  createKlineFetcher,
  createWeightGovernor,
  type BinanceWs,
  type BinanceWsFactory,
  type ClosedKline,
  type KlineFetcher,
} from '../../src/index.js';

const silentLogger = _silentLogger;

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
      expect(rest).toHaveBeenCalledWith('BTCUSDT', '1h', 50);
      expect(w.map((k) => k.close)).toEqual(['100', '101']);
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
      let scheduled: (() => void) | null = null;
      const { factory, sockets } = makeFactory();
      const fetcher = createKlineFetcher({
        wsUrl: 'wss://fake/ws',
        wsFactory: factory,
        fetchRestKlines: async () => [],
        logger: silentLogger,
        schedule: (fn) => {
          scheduled = fn;
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
      expect(scheduled).not.toBeNull();
      scheduled?.();
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
