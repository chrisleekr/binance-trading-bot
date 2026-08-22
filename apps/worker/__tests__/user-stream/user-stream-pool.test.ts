import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  createUserStreamPool,
  type ProfileBinanceCredentials,
  type UserStreamHandlers,
} from '../../src/user-stream/user-stream-pool.js';
import type { BinanceWs } from 'market-data/binance-ws.js';
import type { BinanceRestClient } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;

const stubRest = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient => {
  const base = {
    getOpenOrders: vi.fn(async () => []),
    getAccount: vi.fn(async () => ({}) as never),
    placeOrder: vi.fn(async () => ({}) as never),
    cancelOrder: vi.fn(async () => ({}) as never),
    getOrder: vi.fn(async () => ({}) as never),
    getKlines: vi.fn(async () => []),
    getTicker24hr: vi.fn(async () => ({}) as never),
    getAllTickers24hr: vi.fn(async () => []),
    getPriceTickers: vi.fn(async () => []),
    getRecentTrades: vi.fn(async () => []),
    getMyTrades: vi.fn(async () => []),
    getDepth: vi.fn(async () => ({}) as never),
    getDustBtc: vi.fn(async () => ({}) as never),
    convertDust: vi.fn(async () => ({}) as never),
    ctx: vi.fn(() => ({}) as never),
    signWsApiPayload: vi.fn((id, method) => ({
      id,
      method,
      params: { apiKey: 'stub-key', timestamp: 0, signature: 'stub-sig' },
    })),
  } satisfies BinanceRestClient;
  return { ...base, ...overrides };
};

interface WsHooks {
  triggerOpen: () => void;
  triggerMessage: (data: string) => void;
  triggerClose: () => void;
}

// Captures listeners so the test can drive open/message/close events
// without an actual socket. The ws-api flow fires `onOpen` to trigger
// the subscribe; expose hooks so tests can simulate it.
const stubWs = (): BinanceWs & WsHooks => {
  const listeners: {
    open: (() => void)[];
    message: ((data: string) => void)[];
    close: (() => void)[];
    error: ((err: Error) => void)[];
  } = { open: [], message: [], close: [], error: [] };
  return {
    send: vi.fn(),
    close: vi.fn(),
    onOpen: vi.fn((cb: () => void) => listeners.open.push(cb)),
    onMessage: vi.fn((cb: (data: string) => void) => listeners.message.push(cb)),
    onClose: vi.fn((cb: () => void) => listeners.close.push(cb)),
    onError: vi.fn((cb: (err: Error) => void) => listeners.error.push(cb)),
    triggerOpen: () => listeners.open.forEach((cb) => cb()),
    triggerMessage: (d) => listeners.message.forEach((cb) => cb(d)),
    triggerClose: () => listeners.close.forEach((cb) => cb()),
  };
};

const silentLogger = pino({ level: 'silent' });

describe('UserStreamPool — ws-api subscribe.signature flow', () => {
  it('on open(): connects to ws-api host and sends subscribe on WS open', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    const ws = stubWs();
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => ws);

    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers,
      logger: silentLogger,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);

    expect(factory).toHaveBeenCalledWith('wss://ws-api.testnet.binance.vision/ws-api/v3');
    expect(pool.isOpen(PROFILE_ID)).toBe(true);

    ws.triggerOpen();
    expect(rest.signWsApiPayload).toHaveBeenCalledWith(
      String(PROFILE_ID),
      'userDataStream.subscribe.signature',
    );
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      String((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '{}'),
    ) as { method: string };
    expect(sent.method).toBe('userDataStream.subscribe.signature');

    expect(handlers.onResync).toHaveBeenCalledWith(USER_ID, PROFILE_ID);
  });

  it('re-opens after the WS closes on the next watchdog tick', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    let wsCount = 0;
    const wsInstances: ReturnType<typeof stubWs>[] = [];
    const factory = vi.fn(() => {
      wsCount += 1;
      const w = stubWs();
      wsInstances.push(w);
      return w;
    });
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers,
      logger: silentLogger,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    expect(pool.isOpen(PROFILE_ID)).toBe(true);
    expect(wsCount).toBe(1);

    // Binance closes the WS (network blip, idle, scheduled rotation).
    const firstWs = wsInstances[0];
    if (!firstWs) throw new Error('test setup: factory was not invoked');
    firstWs.triggerClose();
    expect(pool.isOpen(PROFILE_ID)).toBe(false);

    // Watchdog tick walks intended-open profiles; missing connection
    // triggers a fresh open + resync.
    await pool.runWatchdogOnce();
    expect(pool.isOpen(PROFILE_ID)).toBe(true);
    expect(wsCount).toBe(2);
    expect(handlers.onResync).toHaveBeenCalledTimes(2);
  });

  it('decodes a server-push frame and routes it to onEvent with the (userId, profileId) envelope', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    const ws = stubWs();
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory: () => ws,
      handlers,
      logger: silentLogger,
    });
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);

    ws.triggerMessage(
      JSON.stringify({
        id: String(PROFILE_ID),
        status: 200,
        result: { subscriptionId: 7 },
      }),
    );
    ws.triggerMessage(
      JSON.stringify({
        event: {
          e: 'executionReport',
          s: 'BTCUSDT',
          i: 42,
          c: 'co-1',
          X: 'FILLED',
          S: 'BUY',
          x: 'TRADE',
          L: '50000',
          l: '0.001',
          z: '0.001',
          Z: '50',
          E: 1,
        },
      }),
    );

    // The pool's responsibility is the envelope + routing; exhaustive
    // field-by-field decode is covered by the @app/binance parser test.
    expect(handlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'execution-report',
        symbol: 'BTCUSDT',
        userId: USER_ID,
        profileId: PROFILE_ID,
      }),
    );
  });
});

describe('UserStreamPool connection watchdog', () => {
  it('is a no-op when every intended-open connection is fresh', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    let now = 1_000;
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory: () => stubWs(),
      handlers,
      logger: silentLogger,
      nowMs: () => now,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    (handlers.onResync as ReturnType<typeof vi.fn>).mockClear();

    // Advance clock by less than the default 90s idle threshold.
    now += 30_000;
    await pool.runWatchdogOnce();

    expect(handlers.onResync).not.toHaveBeenCalled();
  });

  it('reconnects an idle connection whose last message exceeds the threshold', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    let wsCount = 0;
    const factory = vi.fn(() => {
      wsCount += 1;
      return stubWs();
    });
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    let now = 1_000;
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers,
      logger: silentLogger,
      nowMs: () => now,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    (handlers.onResync as ReturnType<typeof vi.fn>).mockClear();
    expect(wsCount).toBe(1);

    // Push the clock past the default 90s idle threshold without any
    // intervening onMessage.
    now += 120_000;
    await pool.runWatchdogOnce();

    expect(wsCount).toBe(2);
    expect(pool.isOpen(PROFILE_ID)).toBe(true);
    expect(handlers.onResync).toHaveBeenCalledTimes(1);
  });

  it('honours a custom idleThresholdMs', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    let wsCount = 0;
    const factory = vi.fn(() => {
      wsCount += 1;
      return stubWs();
    });
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    let now = 1_000;
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers,
      logger: silentLogger,
      nowMs: () => now,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);

    // 10s idle — under default 90s but over the explicit 5s threshold.
    now += 10_000;
    await pool.runWatchdogOnce(5_000);

    expect(wsCount).toBe(2);
  });

  it('does not reconnect a profile that has been explicitly closed', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    let wsCount = 0;
    const factory = vi.fn(() => {
      wsCount += 1;
      return stubWs();
    });
    const handlers: UserStreamHandlers = {
      onEvent: vi.fn(),
      onResync: vi.fn(async () => undefined),
    };
    let now = 1_000;
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers,
      logger: silentLogger,
      nowMs: () => now,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    await pool.close(USER_ID, ACCOUNT_ID, PROFILE_ID);

    now += 120_000;
    await pool.runWatchdogOnce();

    expect(wsCount).toBe(1);
    expect(pool.isOpen(PROFILE_ID)).toBe(false);
  });

  it('does not reconnect a quiet stream that is receiving heartbeat pongs', async () => {
    vi.useFakeTimers();
    try {
      const rest = stubRest();
      const creds: ProfileBinanceCredentials = { mode: 'test', rest };
      const ws = stubWs();
      let wsCount = 0;
      const factory = vi.fn(() => {
        wsCount += 1;
        return ws;
      });
      const handlers: UserStreamHandlers = {
        onEvent: vi.fn(),
        onResync: vi.fn(async () => undefined),
      };
      let now = 1_000;
      const pool = createUserStreamPool({
        resolveCredentials: vi.fn(async () => creds),
        factory,
        handlers,
        logger: silentLogger,
        nowMs: () => now,
        heartbeatIntervalMs: 30_000,
      });

      await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
      ws.triggerOpen(); // arms heartbeat timer
      expect(wsCount).toBe(1);

      // Two heartbeat cycles spanning 200s well past the 90s idle threshold.
      // Sequence per cycle: advance the fake timer (heartbeat send fires)
      // then advance the synthetic `now` clock PAST the threshold BEFORE
      // delivering the pong. If the hb-branch in handleFrame does not
      // bump `state.lastMessageMs`, the synthetic clock will leave
      // lastMessageMs at the openInternal seed (1_000) and the watchdog
      // tick at the end of the cycle will reconnect. The pong therefore
      // pins the hb-branch write as the load-bearing liveness signal.
      for (let i = 1; i <= 2; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        const sentPayloads = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => JSON.parse(String(c[0])) as { id: string; method?: string },
        );
        const pings = sentPayloads.filter((p) => p.method === 'ping');
        expect(pings.length).toBeGreaterThanOrEqual(i);
        const latest = pings[pings.length - 1];
        if (!latest) throw new Error('expected heartbeat ping');
        // Jump the clock past the idle threshold first — only the pong
        // write inside the hb branch can rescue lastMessageMs.
        now += 100_000;
        ws.triggerMessage(JSON.stringify({ id: latest.id, status: 200, result: {} }));
        await pool.runWatchdogOnce();
        expect(wsCount).toBe(1);
      }

      expect(pool.isOpen(PROFILE_ID)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat pongs do NOT satisfy the ACCOUNT-event clock: a silently-stopped stream is reconnected', async () => {
    // The bug this pins: a pong proves the SOCKET is alive and nothing more. A
    // ws-api connection that keeps ponging while its user-data subscription has
    // silently stopped pushing looks perfectly healthy to the idle check — and a
    // fill that lands in that window is never delivered, so the strategy keeps a
    // position it no longer owns. The account-event clock is the only thing that
    // can see it.
    vi.useFakeTimers();
    try {
      const rest = stubRest();
      const creds: ProfileBinanceCredentials = { mode: 'test', rest };
      let wsCount = 0;
      const wsInstances: ReturnType<typeof stubWs>[] = [];
      const factory = vi.fn(() => {
        wsCount += 1;
        const w = stubWs();
        wsInstances.push(w);
        return w;
      });
      const handlers: UserStreamHandlers = {
        onEvent: vi.fn(),
        onResync: vi.fn(async () => undefined),
      };
      const onStreamSilent = vi.fn(async () => undefined);
      let now = 1_000;
      const pool = createUserStreamPool({
        resolveCredentials: vi.fn(async () => creds),
        factory,
        handlers,
        logger: silentLogger,
        nowMs: () => now,
        heartbeatIntervalMs: 30_000,
        accountEventIdleMs: 600_000,
        onStreamSilent,
      });

      await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
      wsInstances[0]?.triggerOpen();
      (handlers.onResync as ReturnType<typeof vi.fn>).mockClear();

      // Keep the socket clock perfectly fresh with pongs while the account clock
      // runs past its threshold.
      for (let i = 0; i < 25; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        now += 30_000;
        const pings = (wsInstances[0]?.send as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => JSON.parse(String(c[0])) as { id: string; method?: string })
          .filter((p) => p.method === 'ping');
        const latest = pings[pings.length - 1];
        if (!latest) throw new Error('expected heartbeat ping');
        wsInstances[0]?.triggerMessage(JSON.stringify({ id: latest.id, status: 200, result: {} }));
      }

      await pool.runWatchdogOnce();

      expect(wsCount).toBe(2);
      expect(handlers.onResync).toHaveBeenCalledTimes(1);
      expect(onStreamSilent).toHaveBeenCalledTimes(1);
      expect(onStreamSilent).toHaveBeenCalledWith(
        USER_ID,
        ACCOUNT_ID,
        PROFILE_ID,
        expect.any(Number),
      );

      // The reconnect reseeds the account clock, so the trip is once-per-window BY
      // CONSTRUCTION — no "have I already warned?" bookkeeping. An immediate second
      // tick must do nothing, or a permanently quiet profile reconnect-storms.
      await pool.runWatchdogOnce();
      expect(wsCount).toBe(2);
      expect(onStreamSilent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real account event rearms the account clock', async () => {
    const rest = stubRest();
    const creds: ProfileBinanceCredentials = { mode: 'test', rest };
    let wsCount = 0;
    const wsInstances: ReturnType<typeof stubWs>[] = [];
    const factory = vi.fn(() => {
      wsCount += 1;
      const w = stubWs();
      wsInstances.push(w);
      return w;
    });
    const onStreamSilent = vi.fn(async () => undefined);
    let now = 1_000;
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => creds),
      factory,
      handlers: { onEvent: vi.fn(), onResync: vi.fn(async () => undefined) },
      logger: silentLogger,
      nowMs: () => now,
      accountEventIdleMs: 600_000,
      onStreamSilent,
    });

    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    // Just short of the window, a genuine account event lands.
    now += 500_000;
    wsInstances[0]?.triggerMessage(
      JSON.stringify({ e: 'executionReport', s: 'BTCUSDT', i: 1, t: 1, X: 'FILLED' }),
    );
    // Another 500s: past the window measured from OPEN, not from the event.
    now += 500_000;

    await pool.runWatchdogOnce(2_000_000);

    expect(wsCount).toBe(1);
    expect(onStreamSilent).not.toHaveBeenCalled();
  });

  it('clears the heartbeat timer when the pool explicitly closes the profile', async () => {
    vi.useFakeTimers();
    try {
      const rest = stubRest();
      const creds: ProfileBinanceCredentials = { mode: 'test', rest };
      const ws = stubWs();
      const handlers: UserStreamHandlers = {
        onEvent: vi.fn(),
        onResync: vi.fn(async () => undefined),
      };
      const pool = createUserStreamPool({
        resolveCredentials: vi.fn(async () => creds),
        factory: () => ws,
        handlers,
        logger: silentLogger,
        heartbeatIntervalMs: 1_000,
      });

      await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
      ws.triggerOpen();

      await vi.advanceTimersByTimeAsync(1_000);
      const sendsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

      await pool.close(USER_ID, ACCOUNT_ID, PROFILE_ID);
      await vi.advanceTimersByTimeAsync(5_000);

      const sendsAfter = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(sendsAfter).toBe(sendsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the heartbeat timer when the WS closes', async () => {
    vi.useFakeTimers();
    try {
      const rest = stubRest();
      const creds: ProfileBinanceCredentials = { mode: 'test', rest };
      const ws = stubWs();
      const handlers: UserStreamHandlers = {
        onEvent: vi.fn(),
        onResync: vi.fn(async () => undefined),
      };
      const pool = createUserStreamPool({
        resolveCredentials: vi.fn(async () => creds),
        factory: () => ws,
        handlers,
        logger: silentLogger,
        heartbeatIntervalMs: 1_000,
      });

      await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
      ws.triggerOpen();

      await vi.advanceTimersByTimeAsync(1_000);
      const sendsBefore = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

      ws.triggerClose();
      await vi.advanceTimersByTimeAsync(5_000);

      // No further ping frames after close.
      const sendsAfter = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(sendsAfter).toBe(sendsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startConnectionWatchdog returns an idempotent stop handle', () => {
    const pool = createUserStreamPool({
      resolveCredentials: vi.fn(async () => null),
      factory: () => stubWs(),
      handlers: { onEvent: vi.fn(), onResync: vi.fn() },
      logger: silentLogger,
    });

    const stop1 = pool.startConnectionWatchdog({ intervalMs: 1_000_000 });
    const stop2 = pool.startConnectionWatchdog({ intervalMs: 1_000_000 });
    // Both handles safe to call; second start replaced the first timer.
    stop1();
    stop2();
  });
});
