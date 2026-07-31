import { describe, expect, it, vi } from 'vitest';
import { asProfileId } from '@app/contracts';
import { isRedisUnavailableError, redisUnavailableSkip } from '../../src/tick/tick-skip.js';

describe('isRedisUnavailableError', () => {
  it('matches a RedisUnavailableError by name', () => {
    const err = new Error('WeightGovernor: Redis unavailable — bulk read skipped');
    err.name = 'RedisUnavailableError';
    expect(isRedisUnavailableError(err)).toBe(true);
  });

  it('matches a look-alike from a DIFFERENT module identity (name, not instanceof)', () => {
    // Simulates the cross-package hazard: an error whose prototype is NOT the
    // imported class (dual module identities) but whose name is set. Name-match
    // must still return true, or the tick would dead-letter the very signal it
    // is meant to skip.
    class ForeignRedisUnavailableError extends Error {
      constructor() {
        super('bulk read skipped');
        this.name = 'RedisUnavailableError';
      }
    }
    expect(isRedisUnavailableError(new ForeignRedisUnavailableError())).toBe(true);
  });

  it('rejects an unrelated error (a real Redis connection outage still dead-letters)', () => {
    const conn = new Error('Connection is closed');
    conn.name = 'Error';
    expect(isRedisUnavailableError(conn)).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isRedisUnavailableError('RedisUnavailableError')).toBe(false);
    expect(isRedisUnavailableError(null)).toBe(false);
    expect(isRedisUnavailableError(undefined)).toBe(false);
  });
});

describe('redisUnavailableSkip', () => {
  const PID = asProfileId('00000000-0000-0000-0000-000000000002');
  const ctx = { profileId: PID, symbol: 'BTCUSDT', latencyMs: 12 };
  const makeDeps = () => ({
    metrics: { record: vi.fn() },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  });

  const govErr = (causeMsg?: string): Error => {
    const e = new Error('WeightGovernor: Redis unavailable — bulk read skipped');
    e.name = 'RedisUnavailableError';
    if (causeMsg !== undefined) e.cause = new Error(causeMsg);
    return e;
  };

  it('returns a throttled skip and records the throttle metric on the signal', () => {
    const deps = makeDeps();
    const result = redisUnavailableSkip(govErr('Redis eval timed out'), deps as never, ctx);
    expect(result).toEqual({
      profileId: PID,
      symbol: 'BTCUSDT',
      latencyMs: 12,
      decisionCount: 0,
      throttled: true,
    });
    expect(deps.metrics.record).toHaveBeenCalledWith('tick_throttled_redis_unavailable', 1, {
      profileId: PID,
    });
    // The warn carries the underlying cause for post-hoc diagnosis.
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', cause: 'Redis eval timed out' }),
      expect.stringContaining('weight-governor Redis unavailable'),
    );
  });

  it('returns null (→ caller rethrows) for a genuine, unrelated failure', () => {
    const deps = makeDeps();
    const real = new Error('Connection is closed');
    expect(redisUnavailableSkip(real, deps as never, ctx)).toBeNull();
    // A real failure must NOT be counted as a throttle nor swallowed.
    expect(deps.metrics.record).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('tolerates a missing metrics sink (optional-chained)', () => {
    const deps = { logger: { warn: vi.fn() } };
    expect(() => redisUnavailableSkip(govErr(), deps as never, ctx)).not.toThrow();
  });
});
