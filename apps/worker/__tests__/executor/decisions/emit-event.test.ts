import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { TickExecutorContext, StrategyRegistry, AnyStrategy } from '@app/strategy-core';
import { emitEventHandler } from '../../../src/executor/decisions/emit-event.js';
import type { DecisionDeps } from '../../../src/executor/decisions/_types.js';

const TickSnapshotSchema = z.object({
  symbol: z.string(),
  currentPrice: z.string().optional(),
  tsMs: z.number().int().nonnegative().optional(),
});

const STUB_STRATEGY = {
  name: 'stub',
  events: { 'tick-snapshot': { topic: 'symbol-state', payload: TickSnapshotSchema } },
} as unknown as AnyStrategy;

const stubRegistry: StrategyRegistry = {
  register: () => undefined,
  list: () => [STUB_STRATEGY],
  get: (name) => (name === 'stub' ? STUB_STRATEGY : undefined),
};

const CTX = {
  userId: '11111111-1111-1111-1111-111111111111',
  profileId: '22222222-2222-2222-2222-222222222222',
  clock: { nowMs: () => 1_700_000_000_000 },
  strategyName: 'stub',
} as unknown as TickExecutorContext;

const fakeDeps = (): {
  deps: DecisionDeps;
  incr: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
} => {
  const incr = vi.fn(async () => 1);
  const pipeline = {
    publish: vi.fn(() => pipeline),
    xadd: vi.fn(() => pipeline),
    exec: vi.fn(async () => []),
  };
  const redis = { incr, multi: vi.fn(() => pipeline) } as unknown as Redis;
  const deps = {
    redis,
    clock: { nowMs: () => 1_700_000_000_000 },
    strategies: stubRegistry,
  } as unknown as DecisionDeps;
  return { deps, incr, publish: pipeline.publish };
};

describe('emitEventHandler', () => {
  it('maps a known strategy eventType to its WS topic', async () => {
    const { deps, publish } = fakeDeps();

    // Payload must satisfy the WS contract's SymbolStatePayload (symbol +
    // nullable currentPrice), not just the laxer stub strategy schema — the
    // handler now validates the (topic, payload) pair against WsEvent.
    const result = await emitEventHandler(deps, CTX, {
      type: 'emit-event',
      eventType: 'tick-snapshot',
      payload: { symbol: 'BTCUSDT', currentPrice: '50000' },
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.parse(publish.mock.calls[0]?.[1] as string).topic).toBe('symbol-state');
  });

  it('fails the decision for an unmapped eventType instead of emitting', async () => {
    const { deps, incr } = fakeDeps();

    const result = await emitEventHandler(deps, CTX, {
      type: 'emit-event',
      eventType: 'mystery-event',
      payload: {},
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: 'emit-event: strategy "stub" declares no event "mystery-event"',
    });
    expect(incr).not.toHaveBeenCalled();
  });

  it('fails the decision when payload does not match the strategy schema', async () => {
    const { deps, incr } = fakeDeps();

    const result = await emitEventHandler(deps, CTX, {
      type: 'emit-event',
      eventType: 'tick-snapshot',
      payload: { symbol: 42 } as unknown as Record<string, never>,
    });

    expect(result.ok).toBe(false);
    expect(incr).not.toHaveBeenCalled();
  });

  it('fails the decision when the payload passes the strategy schema but not the WS contract', async () => {
    const { deps, incr } = fakeDeps();

    // Valid for the (lax) stub strategy schema, but missing the
    // SymbolStatePayload `currentPrice` the WS contract requires.
    const result = await emitEventHandler(deps, CTX, {
      type: 'emit-event',
      eventType: 'tick-snapshot',
      payload: { symbol: 'BTCUSDT' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('WS contract');
    expect(incr).not.toHaveBeenCalled();
  });
});
