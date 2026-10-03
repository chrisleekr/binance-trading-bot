import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { publishSessionRevocation } from '../../src/auth/session-revocation.js';
import {
  createWebSocketSessionWatch,
  WEBSOCKET_SESSION_ENDED,
  WEBSOCKET_TOO_MANY,
  WEBSOCKETS_PER_IP_ADDRESS,
  WEBSOCKETS_PER_SESSION,
  upgradeWithReservation,
  type WebSocketSessionWatch,
} from '../../src/ws/session-watch.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;
const logger = pino({ level: 'silent' });

interface FakeSocket {
  userId: string;
  sessionId: string | null;
  ipAddress: string;
  closed: { code: number; reason: string } | null;
  close(code: number, reason: string): void;
}

const socket = (
  userId: string,
  sessionId: string | null,
  ipAddress = '198.51.100.1',
): FakeSocket => ({
  userId,
  sessionId,
  ipAddress,
  closed: null,
  close(code, reason) {
    this.closed = { code, reason };
  },
});

/** Reserves the socket's address slot and opens it, as the upgrade route does; fails the test when the address is already full. */
const track = (watch: WebSocketSessionWatch, s: FakeSocket): (() => void) => {
  const reservation = watch.reserve(s.ipAddress);
  if (reservation === null) throw new Error(`address ${s.ipAddress} is full`);
  return reservation.open(s);
};

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describeIfInfra('WebSocket session watch', () => {
  let fx: ApiFixture;
  let userId: string;
  let watch: WebSocketSessionWatch | null = null;

  /** Signs in and returns the new session's id, read from the database because the body never carries it. */
  const newSession = async (): Promise<string> => {
    const res = await fx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ws@example.test', password: 'ws-operator-password' }),
    });
    expect(res.status).toBe(200);
    const { rows } = await fx.di.pool.query<{ id: string }>(
      `select id from session order by "createdAt" desc limit 1`,
    );
    return rows[0]?.id ?? '';
  };

  const build = (subscriber: Redis | null = null): WebSocketSessionWatch => {
    watch = createWebSocketSessionWatch({
      db: fx.di.db,
      subscriber,
      security: fx.di.security,
      logger,
      intervalMs: 3_600_000,
    });
    return watch;
  };

  beforeAll(async () => {
    fx = await setupApp({ seed: false });
    const res = await fx.app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ws@example.test',
        password: 'ws-operator-password',
        name: 'Operator',
      }),
    });
    expect(res.status).toBe(200);
    const { rows } = await fx.di.pool.query<{ id: string }>(`select id from "user" limit 1`);
    userId = rows[0]?.id ?? '';
  });
  afterEach(async () => {
    await watch?.stop();
    watch = null;
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('keeps a socket whose session is live and closes one whose session was deleted', async () => {
    const w = build();
    const live = socket(userId, await newSession());
    const revoked = socket(userId, await newSession());
    track(w, live);
    track(w, revoked);
    await fx.di.pool.query(`delete from session where id = $1`, [revoked.sessionId]);
    await w.revalidate();
    expect(live.closed).toBeNull();
    expect(revoked.closed).toEqual({ code: WEBSOCKET_SESSION_ENDED, reason: 'session_ended' });
  });

  it('closes every socket when sign-out-everywhere raises the security epoch', async () => {
    const w = build();
    const a = socket(userId, await newSession());
    track(w, a);
    await fx.di.pool.query(`update auth_security_settings set security_epoch = security_epoch + 1`);
    fx.di.security.settings.invalidate();
    await w.revalidate();
    expect(a.closed?.code).toBe(WEBSOCKET_SESSION_ENDED);
    await fx.di.pool.query(
      `update session set "securityEpoch" = (select security_epoch from auth_security_settings)`,
    );
  });

  it('closes a socket whose session outlived the absolute lifetime', async () => {
    const w = build();
    const old = socket(userId, await newSession());
    track(w, old);
    await fx.di.pool.query(
      `update session set "createdAt" = now() - interval '25 hours' where id = $1`,
      [old.sessionId],
    );
    await w.revalidate();
    expect(old.closed?.code).toBe(WEBSOCKET_SESSION_ENDED);
  });

  it('never closes the live-demo identity, which has no session', async () => {
    const w = build();
    const demo = socket(userId, null);
    track(w, demo);
    await w.revalidate();
    expect(demo.closed).toBeNull();
  });

  it('closes at once on a revocation message, without waiting for the interval', async () => {
    const w = build(new Redis(fx.redisUrl));
    const s = socket(userId, await newSession());
    track(w, s);
    // Give SUBSCRIBE a moment to register before publishing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fx.di.pool.query(`delete from session where id = $1`, [s.sessionId]);
    await publishSessionRevocation(fx.di, { sessionIds: [s.sessionId ?? ''] });
    await waitFor(() => s.closed !== null);
    expect(s.closed?.code).toBe(WEBSOCKET_SESSION_ENDED);
  });

  it('caps sockets per session by closing the oldest, and per address by refusing the upgrade', async () => {
    const w = build();
    const sessionId = await newSession();
    const opened = Array.from({ length: WEBSOCKETS_PER_SESSION + 1 }, () =>
      socket(userId, sessionId, '198.51.100.7'),
    );
    for (const s of opened) track(w, s);
    expect(opened[0]?.closed).toEqual({ code: WEBSOCKET_TOO_MANY, reason: 'too_many_connections' });
    expect(opened.slice(1).every((s) => s.closed === null)).toBe(true);

    const removers = Array.from({ length: WEBSOCKETS_PER_IP_ADDRESS }, () =>
      track(w, socket(userId, null, '198.51.100.8')),
    );
    expect(w.reserve('198.51.100.8')).toBeNull();
    expect(w.reserve('198.51.100.9')).not.toBeNull();
    removers[0]?.();
    // Removal is idempotent: a close handler that runs twice must not free two slots.
    removers[0]?.();
    track(w, socket(userId, null, '198.51.100.8'));
    expect(w.reserve('198.51.100.8')).toBeNull();
  });

  it('shares one address cap across an IPv6 /64, so rotating addresses inside it does not reset the cap', () => {
    const w = build();
    const held = Array.from({ length: WEBSOCKETS_PER_IP_ADDRESS }, (_, i) =>
      w.reserve(`2001:db8:1:2::${(i + 1).toString(16)}`),
    );
    expect(held.every((r) => r !== null)).toBe(true);
    expect(w.reserve('2001:db8:1:2:ffff::1')).toBeNull();
    // A different /64 is a different client.
    expect(w.reserve('2001:db8:1:3::1')).not.toBeNull();
    held[0]?.release();
    expect(w.reserve('2001:db8:1:2:ffff::1')).not.toBeNull();
  });

  it('counts an address slot at reservation, so a burst of upgrades that have not opened yet cannot pass the cap', () => {
    const w = build();
    const pending = Array.from({ length: WEBSOCKETS_PER_IP_ADDRESS }, () =>
      w.reserve('198.51.100.10'),
    );
    expect(pending.every((r) => r !== null)).toBe(true);
    expect(w.reserve('198.51.100.10')).toBeNull();
    pending[0]?.release();
    expect(w.reserve('198.51.100.10')).not.toBeNull();
  });

  it('evicts a different socket on each extra open while the evicted ones have not finished closing', async () => {
    const w = build();
    const sessionId = await newSession();
    // A fake socket's close records the code but never runs the close handler, like a real socket whose close has not completed yet.
    const opened = Array.from({ length: WEBSOCKETS_PER_SESSION + 2 }, () =>
      socket(userId, sessionId, '198.51.100.11'),
    );
    for (const s of opened) track(w, s);
    expect(opened.filter((s) => s.closed !== null)).toEqual([opened[0], opened[1]]);
    expect(opened.filter((s) => s.closed === null)).toHaveLength(WEBSOCKETS_PER_SESSION);
  });

  it('frees the slot when the upgrade does not happen, and keeps it when it does', async () => {
    const w = build();
    const address = '198.51.100.12';
    const fill = (): void => {
      for (let i = 0; i < WEBSOCKETS_PER_IP_ADDRESS - 1; i += 1) w.reserve(address);
    };
    fill();
    const refused = w.reserve(address);
    if (refused === null) throw new Error('slot expected');
    await expect(upgradeWithReservation(refused, async () => undefined)).resolves.toBeUndefined();
    const failed = w.reserve(address);
    if (failed === null) throw new Error('slot freed by the refused upgrade expected');
    await expect(
      upgradeWithReservation(failed, async () => {
        throw new Error('upgrade failed');
      }),
    ).rejects.toThrow('upgrade failed');
    const upgraded = w.reserve(address);
    if (upgraded === null) throw new Error('slot freed by the failed upgrade expected');
    const response = new Response(null);
    await expect(upgradeWithReservation(upgraded, async () => response)).resolves.toBe(response);
    expect(w.reserve(address)).toBeNull();
  });
});
