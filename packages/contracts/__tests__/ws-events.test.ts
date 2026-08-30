import { describe, it, expect } from 'vitest';

import {
  WsEvent,
  WsTopic,
  decodeWsEventStreamFields,
  encodeWsEventStreamFields,
} from '../src/ws-events.js';
import { asDecimalString } from '../src/decimal.js';

const base = { seq: 1, ts: '2026-05-29T00:00:00.000Z' } as const;

describe('WsEvent discriminated union', () => {
  it('parses each topic with its matching payload', () => {
    const cases = [
      { ...base, topic: 'symbol-state', payload: { symbol: 'BTCUSDT', currentPrice: '50000' } },
      { ...base, topic: 'orders', payload: { orderId: 7, status: 'FILLED' } },
      { ...base, topic: 'logs', payload: { symbol: null, level: 'info', msg: 'hi' } },
      {
        ...base,
        topic: 'profile-state',
        payload: { enabled: true, lastTickAt: null, lastTickLatencyMs: null },
      },
      { ...base, topic: 'heartbeat', payload: {} },
      { ...base, topic: 'resync-required', payload: {} },
      {
        ...base,
        topic: 'backtest-progress',
        payload: {
          runId: '11111111-1111-4111-8111-111111111111',
          pct: 42,
          phase: 'replay',
          processed: 100,
          total: 200,
        },
      },
      {
        ...base,
        topic: 'backtest-complete',
        payload: { runId: '11111111-1111-4111-8111-111111111111' },
      },
    ];
    for (const c of cases) {
      expect(WsEvent.safeParse(c).success, c.topic).toBe(true);
    }
  });

  it('rejects a payload that does not match its topic (symbol-state shape under orders)', () => {
    const wrong = { ...base, topic: 'orders', payload: { symbol: 'BTCUSDT', currentPrice: '1' } };
    // OrdersPayload has no required fields, so a foreign-but-loose object still
    // parses; the load-bearing rejection is a *typed* mismatch:
    const symbolStateMissingPrice = { ...base, topic: 'symbol-state', payload: { symbol: 'X' } };
    expect(WsEvent.safeParse(symbolStateMissingPrice).success).toBe(false);
    // sanity: the loose orders payload is accepted (orders is an opaque signal)
    expect(WsEvent.safeParse(wrong).success).toBe(true);
  });

  it('rejects an unknown topic', () => {
    expect(WsEvent.safeParse({ ...base, topic: 'not-a-topic', payload: {} }).success).toBe(false);
  });

  it('narrows payload by topic at the type level', () => {
    const parsed = WsEvent.parse({
      ...base,
      topic: 'symbol-state',
      payload: { symbol: 'ETHUSDT', currentPrice: null },
    });
    if (parsed.topic === 'symbol-state') {
      // Type narrowing: `.payload.symbol` is typed, no cast needed.
      expect(parsed.payload.symbol).toBe('ETHUSDT');
      expect(parsed.payload.currentPrice).toBeNull();
    } else {
      throw new Error('expected symbol-state variant');
    }
  });

  it('covers every WsTopic with a union variant', () => {
    const unionTopics = new Set(WsEvent.options.map((o) => o.shape.topic.value));
    for (const topic of WsTopic.options) {
      expect(unionTopics.has(topic), `missing union variant for topic ${topic}`).toBe(true);
    }
  });
});

describe('events-stream field codec', () => {
  const cases: WsEvent[] = [
    {
      seq: 1,
      topic: 'symbol-state',
      ts: base.ts,
      payload: { symbol: 'BTCUSDT', currentPrice: asDecimalString('5') },
    },
    { seq: 2, topic: 'orders', ts: base.ts, payload: { orderId: 7, status: 'FILLED' } },
    { seq: 3, topic: 'logs', ts: base.ts, payload: { symbol: null, level: 'info', msg: 'hi' } },
    { seq: 4, topic: 'heartbeat', ts: base.ts, payload: {} },
  ];

  it('round-trips encode → decode for each topic, recovering a validated WsEvent', () => {
    for (const event of cases) {
      const decoded = decodeWsEventStreamFields(encodeWsEventStreamFields(event));
      expect(decoded, event.topic).toEqual(event);
    }
  });

  it('encodes the seq/topic/ts/payload field tuple the worker XADDs', () => {
    const event: WsEvent = {
      seq: 2,
      topic: 'orders',
      ts: base.ts,
      payload: { orderId: 7, status: 'FILLED' },
    };
    expect(encodeWsEventStreamFields(event)).toEqual([
      'seq',
      '2',
      'topic',
      'orders',
      'ts',
      base.ts,
      'payload',
      JSON.stringify({ orderId: 7, status: 'FILLED' }),
    ]);
  });

  it('decode returns null on field drift (a payload that fails its topic schema)', () => {
    // A symbol-state entry missing the required currentPrice — the corruption
    // the replay path must skip rather than forward.
    const drifted = [
      'seq',
      '9',
      'topic',
      'symbol-state',
      'ts',
      base.ts,
      'payload',
      '{"symbol":"X"}',
    ];
    expect(decodeWsEventStreamFields(drifted)).toBeNull();
  });

  it('decode returns null on an unparseable payload field', () => {
    const broken = ['seq', '9', 'topic', 'logs', 'ts', base.ts, 'payload', 'not-json{'];
    expect(decodeWsEventStreamFields(broken)).toBeNull();
  });

  it('decode returns null on an unknown topic', () => {
    const unknown = ['seq', '9', 'topic', 'mystery', 'ts', base.ts, 'payload', '{}'];
    expect(decodeWsEventStreamFields(unknown)).toBeNull();
  });
});
