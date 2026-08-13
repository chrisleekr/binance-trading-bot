// The worker no longer knows what any strategy's audit events mean; it only
// merges the block the strategy returns. What it must still guarantee is that a
// plugin cannot overwrite the worker's own audit fields.

import { describe, expect, it, vi } from 'vitest';

import { mergeStrategyAudit, RESERVED_AUDIT_KEYS } from '../../src/tick/merge-strategy-audit.js';

const workerPayload = (): Record<string, unknown> => ({
  enqueuedAtMs: 1,
  eventPayload: { a: 1 },
  results: [{ type: 'place-order', ok: true }],
});

describe('mergeStrategyAudit', () => {
  it('is a no-op when the strategy emitted nothing (the common tick)', () => {
    const payload = workerPayload();
    const onCollision = vi.fn();

    mergeStrategyAudit(payload, undefined, onCollision);

    expect(payload).toEqual(workerPayload());
    expect(onCollision).not.toHaveBeenCalled();
  });

  it('merges a strategy-namespaced block onto the payload', () => {
    const payload = workerPayload();

    mergeStrategyAudit(payload, { technicals: { forceSell: { interval: '15m' } } }, vi.fn());

    expect(payload['technicals']).toEqual({ forceSell: { interval: '15m' } });
    expect(payload['results']).toEqual([{ type: 'place-order', ok: true }]);
  });

  it('accepts several strategy-owned keys', () => {
    const payload = workerPayload();

    mergeStrategyAudit(payload, { technicals: 1, momentum: 2 }, vi.fn());

    expect(payload['technicals']).toBe(1);
    expect(payload['momentum']).toBe(2);
  });

  it('refuses a key that would clobber a worker audit field, and reports it', () => {
    const payload = workerPayload();
    const onCollision = vi.fn();

    mergeStrategyAudit(payload, { results: 'hijacked', technicals: 'kept' }, onCollision);

    expect(payload['results']).toEqual([{ type: 'place-order', ok: true }]);
    expect(payload['technicals']).toBe('kept');
    expect(onCollision).toHaveBeenCalledExactlyOnceWith('results');
  });

  it('guards every reserved key', () => {
    const payload = workerPayload();
    const onCollision = vi.fn();
    // Driven from the exported set, not from a hand-written list: naming three
    // of them and asserting three calls passes forever while claiming "every",
    // so a key added to the guard would go untested by the test named after it.
    // Null-prototype so `__proto__` becomes a plain own key rather than hitting
    // the inherited setter.
    const block = Object.create(null) as Record<string, unknown>;
    for (const key of RESERVED_AUDIT_KEYS) block[key] = 'hijacked';

    mergeStrategyAudit(payload, block, onCollision);

    expect(Object.keys(block)).toHaveLength(RESERVED_AUDIT_KEYS.size);
    expect(payload).toEqual(workerPayload());
    expect(onCollision).toHaveBeenCalledTimes(RESERVED_AUDIT_KEYS.size);
    for (const key of RESERVED_AUDIT_KEYS) expect(onCollision).toHaveBeenCalledWith(key);
  });

  it('refuses a JSON.parse-borne __proto__ key instead of rebinding the prototype', () => {
    // Object.keys skips __proto__ on a literal but surfaces it on a JSON.parse
    // result, where a bare assignment would rebind payload's prototype rather
    // than store a field, silently, without a collision report.
    const payload = workerPayload();
    const onCollision = vi.fn();
    const block = JSON.parse('{"__proto__": {"polluted": true}, "technicals": 1}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(block)).toContain('__proto__');

    mergeStrategyAudit(payload, block, onCollision);

    expect(payload['technicals']).toBe(1);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(onCollision).toHaveBeenCalledExactlyOnceWith('__proto__');
  });

  it('refuses constructor and prototype keys', () => {
    const payload = workerPayload();
    const onCollision = vi.fn();

    mergeStrategyAudit(payload, { constructor: 'x', prototype: 'y', momentum: 3 }, onCollision);

    expect(payload['momentum']).toBe(3);
    expect(payload['prototype']).toBeUndefined();
    expect(onCollision).toHaveBeenCalledTimes(2);
  });
});
