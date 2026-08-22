import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { asAccountId, asProfileId } from '@app/contracts';
import { emitEvent, type EventEmitterDeps } from '../../src/executor/event-emitter.js';

const ACCOUNT = asAccountId('11111111-1111-1111-1111-111111111111');
const PROFILE = asProfileId('22222222-2222-2222-2222-222222222222');
const CHANNEL = `events:${ACCOUNT}:${PROFILE}`;
const TS_MS = 1_700_000_000_000;
const TS_ISO = '2023-11-14T22:13:20.000Z';

const fakeRedis = (): {
  redis: Redis;
  incr: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  xadd: ReturnType<typeof vi.fn>;
} => {
  let seq = 0;
  const incr = vi.fn(async () => (seq += 1));
  const pipeline = {
    publish: vi.fn(() => pipeline),
    xadd: vi.fn(() => pipeline),
    exec: vi.fn(async () => []),
  };
  const redis = { incr, multi: vi.fn(() => pipeline) } as unknown as Redis;
  return { redis, incr, publish: pipeline.publish, xadd: pipeline.xadd };
};

const deps = (redis: Redis): EventEmitterDeps => ({ redis, clock: { nowMs: () => TS_MS } });

describe('emitEvent', () => {
  it('publishes the WsEvent envelope and appends matching stream fields', async () => {
    const { redis, incr, publish, xadd } = fakeRedis();

    await emitEvent(deps(redis), ACCOUNT, PROFILE, 'orders', { orderId: 42 });

    expect(incr).toHaveBeenCalledWith(`${CHANNEL}:seq`);
    // Live pub/sub body is the WsEvent envelope verbatim.
    expect(publish).toHaveBeenCalledWith(
      CHANNEL,
      JSON.stringify({ seq: 1, topic: 'orders', ts: TS_ISO, payload: { orderId: 42 } }),
    );
    // Durable stream uses the seq/topic/ts/payload field layout the API
    // replay path (`apps/api/src/ws/replay.ts`) reads back.
    expect(xadd).toHaveBeenCalledWith(
      `${CHANNEL}:stream`,
      'MAXLEN',
      '~',
      '1000',
      '*',
      'seq',
      '1',
      'topic',
      'orders',
      'ts',
      TS_ISO,
      'payload',
      JSON.stringify({ orderId: 42 }),
    );
  });

  it('assigns a monotonic seq per call', async () => {
    const { redis, publish } = fakeRedis();

    await emitEvent(deps(redis), ACCOUNT, PROFILE, 'logs', {
      symbol: null,
      level: 'info',
      msg: 'a',
    });
    await emitEvent(deps(redis), ACCOUNT, PROFILE, 'logs', {
      symbol: null,
      level: 'info',
      msg: 'b',
    });

    expect(JSON.parse(publish.mock.calls[0]?.[1] as string).seq).toBe(1);
    expect(JSON.parse(publish.mock.calls[1]?.[1] as string).seq).toBe(2);
  });
});
