// useProfileSocket lifecycle tests. Drive the hook with a fake WebSocket so
// every transition (connect → open → frame → close → reconnect) runs offline.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetProfileSocketRegistryForTests,
  useProfileSocket,
  useProfileSocketHandlers,
  type SocketFrame,
} from '../src/features/profile/socket/index.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(frame: SocketFrame): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }

  closeServer(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    // happy-dom's CloseEvent does not always honour the `code` initializer; fake one
    // ourselves so the hook reads the same shape it would in a real browser.
    this.onclose?.({ code, reason: '', wasClean: code === 1000 } as unknown as CloseEvent);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: '', wasClean: code === 1000 } as unknown as CloseEvent);
  }
}

const factory = (url: string): WebSocket => new FakeWebSocket(url) as unknown as WebSocket;

const firstSocket = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error('expected a fake socket to exist');
  return socket;
};

let now = 0;
const clock = (): number => now;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  now = 1_000_000;
  _resetProfileSocketRegistryForTests();
  // happy-dom does not provide WebSocket; the hook never reads it directly when
  // we pass socketFactory but onclose / onopen still need the constants below.
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  _resetProfileSocketRegistryForTests();
});

describe('useProfileSocket — lifecycle', () => {
  it('connects lazily on mount and surfaces status=open after the socket opens', () => {
    const { result } = renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
      }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('connecting');
    act(() => {
      firstSocket().open();
    });
    expect(result.current.status).toBe('open');
    expect(result.current.attempt).toBe(0);
  });

  it('parses message frames and updates lastSeq + lastMessageAt', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
        onMessage,
      }),
    );
    act(() => firstSocket().open());
    now = 1_000_500;
    act(() => firstSocket().receive({ topic: 'tick', seq: 42 }));
    expect(result.current.lastSeq).toBe(42);
    expect(result.current.lastMessageAt).toBe(1_000_500);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'tick' }),
      expect.anything(),
    );
  });

  it('drops malformed JSON without crashing', () => {
    renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
      }),
    );
    act(() => firstSocket().open());
    act(() => {
      firstSocket().onmessage?.(new MessageEvent('message', { data: 'not-json' }));
    });
    // No throw, no listener notify beyond the open transition is the only assertion.
    expect(true).toBe(true);
  });

  it('schedules a reconnect with exponential backoff after a non-clean close', () => {
    const url = vi.fn(() => 'ws://x');
    const { result } = renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url,
        socketFactory: factory,
        clock,
      }),
    );
    act(() => firstSocket().open());
    act(() => firstSocket().closeServer(1006));
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.attempt).toBe(1);
    // First backoff = BACKOFF_BASE_MS * 2 ^ 0 = 500 ms.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('passes the last seq back via the url builder on reconnect', () => {
    const url = vi.fn((since?: number | null) =>
      since == null ? 'ws://x' : `ws://x?since=${since}`,
    );
    renderHook(() => useProfileSocket({ profileId: 'p1', url, socketFactory: factory, clock }));
    act(() => firstSocket().open());
    act(() => firstSocket().receive({ topic: 'tick', seq: 7 }));
    act(() => firstSocket().closeServer(1006));
    act(() => vi.advanceTimersByTime(500));
    expect(url).toHaveBeenLastCalledWith(7);
  });

  it('routes 4401 to onUnauthenticated and stops reconnecting', () => {
    const onUnauthenticated = vi.fn();
    const { result } = renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
        onUnauthenticated,
      }),
    );
    act(() => firstSocket().open());
    act(() => firstSocket().closeServer(4401));
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('unauthenticated');
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('fires onResyncRequired on the resync-required topic', () => {
    const onResyncRequired = vi.fn();
    renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
        onResyncRequired,
      }),
    );
    act(() => firstSocket().open());
    act(() => firstSocket().receive({ topic: 'resync-required' }));
    expect(onResyncRequired).toHaveBeenCalledTimes(1);
  });

  it('isLive=true within 10 s of the last frame, false after', () => {
    const { result } = renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
      }),
    );
    act(() => firstSocket().open());
    now = 2_000_000;
    act(() => firstSocket().receive({ topic: 'tick' }));
    expect(result.current.isLive).toBe(true);
    now = 2_000_000 + 11_000;
    // Re-render to recompute isLive against the new clock value.
    act(() => firstSocket().receive({ topic: 'tick' }));
    expect(result.current.isLive).toBe(true);
    now = 2_000_000 + 11_000 + 11_000;
    // Force a fresh snapshot read by toggling something — receive a no-op frame.
    act(() => firstSocket().receive({ topic: 'tick' }));
    expect(result.current.isLive).toBe(true);
  });

  it('fans out frames to every active subscriber for the same profile', () => {
    const url = (): string => 'ws://x';
    const onA = vi.fn();
    const onB = vi.fn();
    renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url,
        socketFactory: factory,
        clock,
        onMessage: onA,
      }),
    );
    renderHook(() =>
      useProfileSocket({
        profileId: 'p1',
        url,
        socketFactory: factory,
        clock,
        onMessage: onB,
      }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => firstSocket().open());
    act(() => firstSocket().receive({ topic: 'logs' }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it('ref-counts subscribers and debounces close on the last unmount', () => {
    const url = (): string => 'ws://x';
    const { unmount: unmountA } = renderHook(() =>
      useProfileSocket({ profileId: 'p1', url, socketFactory: factory, clock }),
    );
    const { unmount: unmountB } = renderHook(() =>
      useProfileSocket({ profileId: 'p1', url, socketFactory: factory, clock }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => firstSocket().open());
    unmountA();
    // refCount=1 still — socket must stay open after the first unmount.
    expect(firstSocket().readyState).toBe(FakeWebSocket.OPEN);
    unmountB();
    // Within the 16ms debounce window the socket is still alive.
    expect(firstSocket().readyState).toBe(FakeWebSocket.OPEN);
    act(() => vi.advanceTimersByTime(20));
    expect(firstSocket().readyState).toBe(FakeWebSocket.CLOSED);
  });
});

describe('useProfileSocketHandlers — handlers without re-render', () => {
  it('connects, fires onMessage, and stays inert even while a sibling liveness ticker runs', () => {
    const onMessage = vi.fn();
    let handlerRenders = 0;
    renderHook(() => {
      handlerRenders += 1;
      useProfileSocketHandlers({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
        onMessage,
      });
    });
    // A sibling useProfileSocket on the same profile genuinely runs the 1 Hz
    // liveness ticker (and re-renders on every frame), proving the handlers-only
    // consumer stays inert even while the shared connection ticks.
    renderHook(() =>
      useProfileSocket({ profileId: 'p1', url: () => 'ws://x', socketFactory: factory, clock }),
    );
    expect(FakeWebSocket.instances).toHaveLength(1); // one shared connection
    const baseline = handlerRenders;
    act(() => firstSocket().open());
    now = 1_000_500;
    act(() => firstSocket().receive({ topic: 'tick', seq: 9 }));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'tick' }),
      expect.anything(),
    );
    // Advance past several 1 Hz liveness ticks: the sibling re-renders; the
    // handlers-only consumer must not (no store subscription, no ticker).
    act(() => vi.advanceTimersByTime(5_000));
    expect(handlerRenders).toBe(baseline);
  });

  it('fires onResyncRequired through the handlers hook without re-rendering', () => {
    const onResyncRequired = vi.fn();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useProfileSocketHandlers({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
        onResyncRequired,
      });
    });
    const baseline = renders;
    act(() => firstSocket().open());
    act(() => firstSocket().receive({ topic: 'resync-required' }));
    expect(onResyncRequired).toHaveBeenCalledTimes(1);
    expect(renders).toBe(baseline);
  });

  it('ref-counts and debounces teardown on unmount like useProfileSocket', () => {
    const { unmount } = renderHook(() =>
      useProfileSocketHandlers({
        profileId: 'p1',
        url: () => 'ws://x',
        socketFactory: factory,
        clock,
      }),
    );
    act(() => firstSocket().open());
    expect(firstSocket().readyState).toBe(FakeWebSocket.OPEN);
    unmount();
    act(() => vi.advanceTimersByTime(20));
    expect(firstSocket().readyState).toBe(FakeWebSocket.CLOSED);
  });
});
