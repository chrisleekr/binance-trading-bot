import { describe, expect, it, vi } from 'vitest';
import { GLOBAL_KEYS } from '@app/db';
import type { Logger } from 'pino';
import { shouldRunProfile, type DiscoveryRedisGate } from '../../../src/crons/discovery/gate.js';

const NOW = 1_700_000_000_000;

describe('shouldRunProfile', () => {
  // The gate is one atomic `EVAL`; the fake returns a queued reply per call
  // (mirrors the weight-governor test's fakeRedis). The script's own PTTL
  // branching is exercised by the real-Redis integration test — here we pin the
  // return→boolean mapping, the reclaim warn, and the exact eval arguments.
  const fakeEval = (replies: number[]): DiscoveryRedisGate & { calls: (string | number)[][] } => {
    const calls: (string | number)[][] = [];
    return {
      calls,
      eval: (_script: string, _numKeys: number, ...args: (string | number)[]) => {
        calls.push([_script, _numKeys, ...args]);
        const next = replies.shift();
        if (next === undefined) throw new Error('fakeEval: no reply queued');
        return Promise.resolve(next);
      },
    };
  };

  const spyLogger = () => ({ warn: vi.fn() });
  const asLogger = (l: { warn: unknown }): Logger => l as unknown as Logger;

  it('runs when the key is absent (eval → 1), no warn', async () => {
    const redis = fakeEval([1]);
    const logger = spyLogger();
    expect(await shouldRunProfile(redis, 'p1', 900_000, NOW, asLogger(logger))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('runs and warns once when a no-TTL wedge is reclaimed (eval → 2)', async () => {
    const redis = fakeEval([2]);
    const logger = spyLogger();
    expect(await shouldRunProfile(redis, 'p1', 900_000, NOW, asLogger(logger))).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('skips while still inside the refresh period (eval → 0), no warn', async () => {
    const redis = fakeEval([0]);
    const logger = spyLogger();
    expect(await shouldRunProfile(redis, 'p1', 900_000, NOW, asLogger(logger))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('invokes eval with the gate script, key, nowMs, and refresh period', async () => {
    const redis = fakeEval([1]);
    await shouldRunProfile(redis, 'p1', 900_000, NOW, asLogger(spyLogger()));
    expect(redis.calls).toHaveLength(1);
    // GATE_LUA is now module-private, so assert the script is a non-empty string
    // rather than importing it. The remaining positional args still pin numkeys,
    // the key, nowMs, and the refresh period exactly.
    const [script, ...rest] = redis.calls[0] as [string, ...(string | number)[]];
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
    expect(rest).toEqual([1, GLOBAL_KEYS.discoveryLastRun('p1'), String(NOW), 900_000]);
  });
});
