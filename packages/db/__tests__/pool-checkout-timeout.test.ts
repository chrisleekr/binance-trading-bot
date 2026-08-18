// The classifier for "this checkout never got a connection", pinned to the errors the INSTALLED pg-pool actually raises.
//
// pg-pool signals both of its deadlines with a bare `new Error(message)`: no SQLSTATE, no error class, nothing but the message text. A classifier for those errors is therefore a string match, and a string match written from a hand-typed fixture fails OPEN the moment the library rewords itself — the fixture keeps agreeing with the classifier while production stops matching, and every exhausted-pool request silently reverts to an opaque 500. So the errors under test here are not written by hand: they are produced by driving a real `pg.Pool` into both of its timeout paths and classifying whatever comes back.
//
// No Postgres is involved. A `net` server that accepts the TCP connection and never speaks the startup protocol is enough to reach both paths, because pg-pool pushes a new client onto `_clients` BEFORE it dials: with `max: 1`, the second concurrent `connect()` already sees a full pool and lands in the wait queue while the first is still stuck mid-handshake. One race therefore yields one of each error, which is also why the two are captured together rather than in two races that would double the flake surface.

import { errorMessage } from '@app/core/error';
import { Pool } from 'pg';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { poolCheckoutTimeoutKind } from '../src/pool.js';

/** Short enough that the suite does not sit on it, long enough that a loaded CI box still reaches the deadline by way of the deadline rather than by way of a scheduling stall. */
const DEADLINE_MS = 300;

/** Hook budget for the race. Far above `DEADLINE_MS` on purpose: if a future pg-pool were to queue a checkout with no timer at all, this hook is what turns that hang into a failed run instead of a green one. */
const RACE_TIMEOUT_MS = 15_000;

/** The two errors one race produces, in `Promise.allSettled` order: index 0 is the checkout that dialled, index 1 is the checkout that waited. */
let coldConnectErr: unknown;
let queueWaitErr: unknown;

let server: net.Server;
let pool: Pool;

/** Every socket the blackhole accepted. `server.close()` only stops NEW connections and then waits for the accepted ones, and the client half of this one is abandoned rather than shut down cleanly, so teardown has to destroy it from this side or the hook hangs until vitest kills it. */
const accepted = new Set<net.Socket>();

describe('pg-pool checkout deadlines', () => {
  beforeAll(async () => {
    server = net.createServer((socket) => {
      // Held and never answered: leaving the startup message unanswered is what keeps the first client mid-handshake long enough for the second to queue behind it.
      accepted.add(socket);
      socket.on('close', () => accepted.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;

    pool = new Pool({
      host: '127.0.0.1',
      port: address.port,
      user: 'unused',
      database: 'unused',
      max: 1,
      connectionTimeoutMillis: DEADLINE_MS,
    });

    const settled = await Promise.allSettled([pool.connect(), pool.connect()]);
    coldConnectErr = settled[0]?.status === 'rejected' ? settled[0].reason : undefined;
    queueWaitErr = settled[1]?.status === 'rejected' ? settled[1].reason : undefined;
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
  }, RACE_TIMEOUT_MS);

  afterAll(async () => {
    // Both handles are closed even though neither ever completed a connection: a leaked listening socket or a pool with a half-open client keeps the vitest worker alive after the last assertion.
    await pool.end().catch(() => undefined);
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails a checkout whose connection attempt outlasts the deadline', () => {
    // Without `connectionTimeoutMillis` this attempt waits on the socket for as long as the peer keeps it open.
    expect(errorMessage(coldConnectErr)).toBe('Connection terminated due to connection timeout');
    expect(errorMessage((coldConnectErr as { cause?: unknown }).cause)).toBe(
      'Connection terminated unexpectedly',
    );
    expect(poolCheckoutTimeoutKind(coldConnectErr)).toBe('cold-connect');
  });

  it('fails a checkout that waits past the deadline for a busy pool', () => {
    // The path the api pool takes under load, and the one that has no timer of its own: pg-pool only arms one when `connectionTimeoutMillis` is set, so unset means this checkout waits forever with nothing to report.
    expect(errorMessage(queueWaitErr)).toBe('timeout exceeded when trying to connect');
    expect((queueWaitErr as { cause?: unknown }).cause).toBeUndefined();
    expect(poolCheckoutTimeoutKind(queueWaitErr)).toBe('queue-wait');
  });

  it('tells the two deadlines apart, against the errors the real library raised', () => {
    // The distinction the operator acts on, pinned to the same two real errors rather than to hand-written fixtures. pg-pool only dials when the pool has room, so the cold-connect error above was produced by a pool that was NOT full — calling it exhaustion would send the operator to raise the pool max, which aims more concurrent attempts at a database already failing to finish a handshake.
    expect(poolCheckoutTimeoutKind(queueWaitErr)).toBe('queue-wait');
    expect(poolCheckoutTimeoutKind(coldConnectErr)).toBe('cold-connect');
  });

  it('gives neither error a SQLSTATE to match on', () => {
    // The reason the classifier reads message text at all. Stated here so a later reader does not "improve" it into a code check that can never be true.
    expect((coldConnectErr as { code?: unknown }).code).toBeUndefined();
    expect((queueWaitErr as { code?: unknown }).code).toBeUndefined();
  });
});

describe('poolCheckoutTimeoutKind: negatives', () => {
  it('does not read an unrelated failure as a checkout timeout', () => {
    // A relabelled connection refusal would answer 503 "come back later" for a database that is down and will not come back, and would hide it from the unhandled-error log.
    expect(
      poolCheckoutTimeoutKind(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toBeNull();
    expect(poolCheckoutTimeoutKind(new Error('timeout'))).toBeNull();
  });

  it('does not match an error whose message merely contains the literal', () => {
    // Substring matching would classify by whatever text happens to travel with an error — a failed query whose parameter quotes the phrase, a wrapper that appends context — so the match is on the whole message.
    expect(
      poolCheckoutTimeoutKind(
        new Error('query failed: timeout exceeded when trying to connect (retry 3)'),
      ),
    ).toBeNull();
    expect(
      poolCheckoutTimeoutKind(
        new Error('Connection terminated due to connection timeout; giving up'),
      ),
    ).toBeNull();
  });

  it('does not read a cancelled statement as a checkout timeout', () => {
    // The two failures are neighbours and both answer 503, but they are different faults: this one means the query ran too long, not that no connection was ever handed out. Conflating them makes the pool look saturated whenever a query is slow.
    const cancelled = new Error('Failed query', {
      cause: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    });
    expect(poolCheckoutTimeoutKind(cancelled)).toBeNull();
  });

  it('returns false for a value that is not an error object', () => {
    expect(poolCheckoutTimeoutKind('timeout exceeded when trying to connect')).toBeNull();
    expect(poolCheckoutTimeoutKind(null)).toBeNull();
    expect(poolCheckoutTimeoutKind(undefined)).toBeNull();
    // `null` rather than a kind, so a caller switching on the kind cannot read a non-timeout as one.
    expect(poolCheckoutTimeoutKind(null)).toBeNull();
    expect(poolCheckoutTimeoutKind(new Error('timeout'))).toBeNull();
  });
});

describe('poolCheckoutTimeoutKind: cause chain', () => {
  it('finds the literal one level down the cause chain', () => {
    // What a caller actually catches when the checkout happened inside drizzle: the driver error is wrapped and the original travels on `cause`.
    const wrapped = new Error('Failed query', {
      cause: new Error('timeout exceeded when trying to connect'),
    });
    expect(poolCheckoutTimeoutKind(wrapped)).toBe('queue-wait');
  });

  it('stops walking past the depth bound', () => {
    // The companion to the cycle case below, and the one that regresses readably: dropping the bound turns this false into true, which fails as an assertion rather than as a wedged run.
    let deep: Error = new Error('timeout exceeded when trying to connect');
    for (let i = 0; i < 12; i += 1) deep = new Error('wrapper', { cause: deep });

    expect(poolCheckoutTimeoutKind(deep)).toBeNull();
  });

  it('terminates on a self-referencing cause chain', () => {
    // Reachable from any code that sets `cause` to an error already in the chain. Unbounded, the walk spins inside the error handler, so the request never gets a response at all.
    const loop = new Error('cycle');
    Object.defineProperty(loop, 'cause', { value: loop });

    expect(poolCheckoutTimeoutKind(loop)).toBeNull();
  });
});
