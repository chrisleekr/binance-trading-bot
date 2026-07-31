import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { asProfileId, asUserId } from '@app/contracts';
import { readCurrentWeight, recordWeight } from '../../src/executor/weight-limiter.js';

const USER = asUserId('00000000-0000-0000-0000-0000000000aa');
const PROFILE = asProfileId('00000000-0000-0000-0000-0000000000bb');

const fixedClock = (ms: number): { nowMs(): number } => ({ nowMs: () => ms });

const fakeRedis = (state = new Map<string, string>()): Redis => {
  const r: Partial<Redis> = {
    set: vi.fn(async (key: string, value: string) => {
      state.set(key, value);
      return 'OK';
    }) as unknown as Redis['set'],
    get: vi.fn(async (key: string) => state.get(key) ?? null) as unknown as Redis['get'],
  };
  return r as Redis;
};

describe('weight-limiter', () => {
  it('recordWeight is a no-op when Binance returned no weight header', async () => {
    const set = vi.fn();
    const redis = { set } as unknown as Redis;
    await recordWeight({ redis, clock: fixedClock(0) }, USER, PROFILE, undefined);
    expect(set).not.toHaveBeenCalled();
  });

  it('recordWeight writes the bucketed key with EX 120 by default', async () => {
    const set = vi.fn(async () => 'OK');
    const redis = { set } as unknown as Redis;
    await recordWeight({ redis, clock: fixedClock(1_700_000_000_000) }, USER, PROFILE, 450);
    expect(set).toHaveBeenCalledOnce();
    const args = set.mock.calls[0] as unknown[];
    expect(args[1]).toBe('450');
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(120);
  });

  it('readCurrentWeight returns 0 when the bucket key is absent', async () => {
    const redis = fakeRedis(new Map());
    const w = await readCurrentWeight({ redis, clock: fixedClock(0) }, USER, PROFILE);
    expect(w).toBe(0);
  });

  it('readCurrentWeight parses an integer from the stored value', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const redis = fakeRedis();
    await recordWeight({ redis, clock }, USER, PROFILE, 789);
    expect(await readCurrentWeight({ redis, clock }, USER, PROFILE)).toBe(789);
  });
});
