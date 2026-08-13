// A user-data stream that keeps dropping and re-opening looks identical to a
// healthy one from outside: the pool reconnects, the profile keeps ticking, and
// the only trace is a log line nobody reads. The counter is what turns a flapping
// account into something an alert can see.
//
// Counted at the socket's own close, once. The watchdog's reconnect closes the
// stale socket itself, so counting there as well would report two disconnects for
// one drop and make a flap threshold fire at half its intended rate.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  createUserStreamPool,
  type ProfileBinanceCredentials,
  type UserStreamDeps,
  type UserStreamHandlers,
} from '../../src/user-stream/user-stream-pool.js';
import type { BinanceWs } from 'market-data/binance-ws.js';
import type { BinanceRestClient } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

const USER_ID = 'u1' as unknown as UserId;
const ACCOUNT_ID = 'a1' as unknown as AccountId;
const PROFILE_ID = 'p1' as unknown as ProfileId;

const stubRest = (): BinanceRestClient =>
  ({
    getOpenOrders: vi.fn(async () => []),
    getAccount: vi.fn(async () => ({}) as never),
    placeOrder: vi.fn(async () => ({}) as never),
    cancelOrder: vi.fn(async () => ({}) as never),
    getKlines: vi.fn(async () => []),
    ctx: vi.fn(() => ({}) as never),
    signWsApiPayload: vi.fn((id: string, method: string) => ({
      id,
      method,
      params: { apiKey: 'stub-key', timestamp: 0, signature: 'stub-sig' },
    })),
  }) as unknown as BinanceRestClient;

interface WsHooks {
  triggerOpen: () => void;
  triggerMessage: (data: string) => void;
  triggerClose: () => void;
  deferClose: () => void;
}

/**
 * Socket stub whose `close()` fires its own close listeners, the way a real one
 * does. Without that the reconnect path would look free of disconnects here for
 * a reason that does not hold in production.
 *
 * `deferClose()` withholds that firing so `triggerClose()` delivers it later. A
 * real close lands on a later turn, and a test about what happens in that gap
 * cannot express it with a synchronous stub without emitting two close events
 * for one socket.
 */
const stubWs = (): BinanceWs & WsHooks => {
  const listeners: {
    open: (() => void)[];
    message: ((data: string) => void)[];
    close: (() => void)[];
    error: ((err: Error) => void)[];
  } = { open: [], message: [], close: [], error: [] };
  let deferred = false;
  const fire = (): void => listeners.close.forEach((cb) => cb());
  return {
    send: vi.fn(),
    close: vi.fn(() => {
      if (!deferred) fire();
    }),
    onOpen: vi.fn((cb: () => void) => listeners.open.push(cb)),
    onMessage: vi.fn((cb: (data: string) => void) => listeners.message.push(cb)),
    onClose: vi.fn((cb: () => void) => listeners.close.push(cb)),
    onError: vi.fn((cb: (err: Error) => void) => listeners.error.push(cb)),
    triggerOpen: () => listeners.open.forEach((cb) => cb()),
    triggerMessage: (d: string) => listeners.message.forEach((cb) => cb(d)),
    triggerClose: fire,
    deferClose: () => {
      deferred = true;
    },
  };
};

const silentLogger = pino({ level: 'silent' });

const IDLE_MS = 60_000;
// The pool floors this at 60s, so it is the shortest account-silence window a
// test can ask for.
const ACCOUNT_IDLE_MS = 60_000;

const setUp = (): {
  pool: ReturnType<typeof createUserStreamPool>;
  sockets: (BinanceWs & WsHooks)[];
  record: ReturnType<typeof vi.fn>;
  disconnects: () => number;
  advance: (ms: number) => void;
} => {
  const creds: ProfileBinanceCredentials = { mode: 'test', rest: stubRest() };
  const sockets: (BinanceWs & WsHooks)[] = [];
  const handlers: UserStreamHandlers = {
    onEvent: vi.fn(),
    onResync: vi.fn(async () => undefined),
  };
  const record = vi.fn();
  // Injected clock: the idle check is a strict `>` against the socket's own
  // last-message stamp, so a real clock leaves a freshly-opened socket at an age
  // of 0 and the watchdog never takes its reconnect path.
  let now = 1_700_000_000_000;
  const pool = createUserStreamPool({
    resolveCredentials: vi.fn(async () => creds),
    factory: vi.fn(() => {
      const ws = stubWs();
      sockets.push(ws);
      return ws;
    }),
    handlers,
    logger: silentLogger,
    nowMs: () => now,
    accountEventIdleMs: ACCOUNT_IDLE_MS,
    metrics: { record, forget: vi.fn() },
  } as unknown as UserStreamDeps);
  const disconnects = (): number =>
    record.mock.calls
      .filter((call) => call[0] === 'binance_ws_disconnects_total')
      .reduce((sum, call) => sum + (call[1] as number), 0);
  return {
    pool,
    sockets,
    record,
    disconnects,
    advance: (ms) => {
      now += ms;
    },
  };
};

describe('user-stream disconnect counter', () => {
  it('counts a dropped socket once, labelled by the account that owns it', async () => {
    // Unlabelled the series cannot say which account is flapping, and the
    // remedy — re-issuing that account's key — is per account.
    const { pool, sockets, record, disconnects } = setUp();
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    sockets[0]?.triggerClose();

    expect(disconnects()).toBe(1);
    expect(record).toHaveBeenCalledWith(
      'binance_ws_disconnects_total',
      1,
      expect.objectContaining({ accountId: ACCOUNT_ID }),
    );
  });

  it('counts one disconnect for a watchdog reconnect, not two', async () => {
    // The reconnect closes the stale socket itself, which fires the same close
    // the counter already sees. A second count here would double every flap.
    const { pool, sockets, disconnects, advance } = setUp();
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    // Past the idle window with no frame, so the watchdog distrusts the socket
    // and takes its reconnect path on this pass.
    advance(IDLE_MS * 2);
    await pool.runWatchdogOnce(IDLE_MS);

    expect(sockets.length).toBeGreaterThan(1);
    expect(disconnects()).toBe(1);
  });

  it('counts nothing when the watchdog reconnects a quiet but responsive stream', async () => {
    // The other watchdog path, and the opposite verdict. Binance pushes an
    // account event only when a balance moves, so a profile holding an untouched
    // position is silent by design and the pool says so itself. That reconnect is
    // a scheduled verification of a socket still answering pings, not a drop —
    // counting it would put one increment per profile on the account's series
    // every idle window, and an account running six untraded profiles would clear
    // the five-in-fifteen-minutes threshold overnight with nothing wrong.
    const { pool, sockets, disconnects, advance } = setUp();
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);

    advance(ACCOUNT_IDLE_MS * 2);
    // A heartbeat pong: it refreshes the SOCKET clock and never the account-event
    // clock, which is what leaves the watchdog on case 3 rather than case 2.
    sockets[0]?.triggerMessage(JSON.stringify({ id: 'hb-1' }));
    await pool.runWatchdogOnce(IDLE_MS);

    // The reconnect did happen — otherwise a zero count would prove nothing.
    expect(sockets.length).toBeGreaterThan(1);
    expect(disconnects()).toBe(0);
  });

  it('counts nothing when the operator closes the stream deliberately', async () => {
    // The socket fires the same close event either way, so ungated this reads as
    // a stream that could not stay up. Disabling a profile is not a disconnect.
    const { pool, disconnects } = setUp();
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    await pool.close(USER_ID, ACCOUNT_ID, PROFILE_ID);

    expect(disconnects()).toBe(0);
  });

  it('still counts nothing when the profile is reopened before the closed socket reports', async () => {
    // A real `ws.close()` reports on a later turn. Keyed on the profile rather
    // than the socket, a reopen in that gap re-arms the intent the close had
    // revoked, and the deliberate close is then counted against the very socket
    // that was already gone — which is how a reconfigure reads as a flap.
    const { pool, sockets, disconnects } = setUp();
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    const first = sockets[0];
    first?.deferClose();
    await pool.close(USER_ID, ACCOUNT_ID, PROFILE_ID);
    await pool.open(USER_ID, ACCOUNT_ID, PROFILE_ID);
    // The only close event this socket emits, landing after the reopen.
    first?.triggerClose();

    expect(disconnects()).toBe(0);
  });

  it('counts nothing when the worker shuts every stream down', async () => {
    // One socket per profile, all counted against their shared account, and the
    // alert trips above five in fifteen minutes. A shutdown holding six profiles
    // on one account would therefore page on every deploy.
    const { pool, disconnects } = setUp();
    const profiles = ['p1', 'p2', 'p3'] as unknown as ProfileId[];
    for (const id of profiles) await pool.open(USER_ID, ACCOUNT_ID, id);
    await pool.closeAll();

    expect(disconnects()).toBe(0);
  });
});
