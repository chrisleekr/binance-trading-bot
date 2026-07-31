import { describe, expect, it, vi } from 'vitest';
import type { ScopedRedis } from '@app/db';
import { encodeWsEventStreamFields, type WsEvent } from '@app/contracts';

import { replayMissed } from '../src/ws/replay.js';

const TS = '2026-05-29T00:00:00.000Z';

const entry = (event: WsEvent): [string, string[]] => [
  `${event.seq}-0`,
  encodeWsEventStreamFields(event),
];

const fakeRedis = (entries: [string, string[]][]): ScopedRedis =>
  ({ raw: () => ({ xrange: vi.fn(async () => entries) }) }) as unknown as ScopedRedis;

const STREAM = 'events:u:p:stream';

describe('replayMissed', () => {
  it('replays only entries newer than sinceSeq as validated WsEvent JSON', async () => {
    const e1: WsEvent = {
      seq: 1,
      topic: 'logs',
      ts: TS,
      payload: { symbol: null, level: 'info', msg: 'a' },
    };
    const e2: WsEvent = { seq: 2, topic: 'orders', ts: TS, payload: { orderId: 7, status: 'NEW' } };
    const res = await replayMissed(fakeRedis([entry(e1), entry(e2)]), STREAM, 1);
    expect(res.resyncRequired).toBe(false);
    expect(res.envelopes).toHaveLength(1);
    const [only] = res.envelopes;
    if (only === undefined) throw new Error('expected one envelope');
    expect(JSON.parse(only)).toEqual(e2);
  });

  it('skips a corrupt/drifted entry and warns, still replaying the valid ones', async () => {
    const valid: WsEvent = { seq: 2, topic: 'orders', ts: TS, payload: { orderId: 9 } };
    // A symbol-state entry missing required currentPrice — fails WsEvent.
    const drifted: [string, string[]] = [
      '3-0',
      ['seq', '3', 'topic', 'symbol-state', 'ts', TS, 'payload', '{"symbol":"X"}'],
    ];
    const warn = vi.fn();
    const res = await replayMissed(fakeRedis([entry(valid), drifted]), STREAM, 1, { warn });
    expect(res.envelopes).toHaveLength(1);
    const [only] = res.envelopes;
    if (only === undefined) throw new Error('expected one envelope');
    expect(JSON.parse(only).seq).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('signals resyncRequired when the oldest entry is past the consumer position', async () => {
    const e5: WsEvent = { seq: 5, topic: 'heartbeat', ts: TS, payload: {} };
    const res = await replayMissed(fakeRedis([entry(e5)]), STREAM, 1);
    expect(res.resyncRequired).toBe(true);
    expect(res.envelopes).toHaveLength(0);
  });

  it('returns an empty replay for an empty stream', async () => {
    const res = await replayMissed(fakeRedis([]), STREAM, 0);
    expect(res).toEqual({ envelopes: [], resyncRequired: false });
  });
});
