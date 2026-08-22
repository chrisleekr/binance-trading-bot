import { describe, expect, it, vi } from 'vitest';

import { decideTeardown, runTeardown } from '../../src/lib/shutdown-teardown.js';

// Each destructive teardown step is injected so the test drives it with spies.
// pool.end / redis.quit et al resolve; exit and logger.error are observed.
const makeDeps = (
  over: {
    drained?: boolean;
    stopFailures?: string[];
  } = {},
) => {
  const adminServer = { stop: vi.fn().mockResolvedValue(undefined) };
  const pool = { end: vi.fn().mockResolvedValue(undefined) };
  const redis = { quit: vi.fn().mockResolvedValue(undefined) };
  const auditDrainerRedis = { quit: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn() };
  const exit = vi.fn();
  return {
    drained: over.drained ?? true,
    stopFailures: over.stopFailures ?? [],
    adminServer,
    pool,
    redis,
    auditDrainerRedis,
    logger,
    exit,
  };
};

describe('decideTeardown', () => {
  it('skips teardown and exits non-zero when the drain timed out', () => {
    expect(decideTeardown(false, [])).toEqual({ runTeardown: false, exitCode: 1 });
  });

  it('runs teardown and exits 0 when drained cleanly', () => {
    expect(decideTeardown(true, [])).toEqual({ runTeardown: true, exitCode: 0 });
  });

  it('runs teardown but exits non-zero when a component stop failed', () => {
    expect(decideTeardown(true, ['queueSet'])).toEqual({ runTeardown: true, exitCode: 1 });
  });
});

describe('runTeardown', () => {
  it('skips pool.end and redis.quit when the drain timed out', async () => {
    const deps = makeDeps({ drained: false });
    await runTeardown(deps);
    // A timed-out drain means a tick may still be mid-flight against the pool;
    // closing it would poison that tick's state commit (the #656 double-fill).
    expect(deps.pool.end).not.toHaveBeenCalled();
    expect(deps.redis.quit).not.toHaveBeenCalled();
    expect(deps.auditDrainerRedis.quit).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('logs an error and exits non-zero on drain timeout', async () => {
    const deps = makeDeps({ drained: false });
    await runTeardown(deps);
    expect(deps.logger.error).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('runs full teardown in order and exits 0 when drained cleanly', async () => {
    const deps = makeDeps({ drained: true, stopFailures: [] });
    await runTeardown(deps);
    expect(deps.adminServer.stop).toHaveBeenCalledOnce();
    expect(deps.pool.end).toHaveBeenCalledOnce();
    expect(deps.redis.quit).toHaveBeenCalledOnce();
    expect(deps.auditDrainerRedis.quit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
    // adminServer.stop (stop taking traffic) before pool.end before redis.quit.
    const adminOrder = deps.adminServer.stop.mock.invocationCallOrder[0];
    const poolOrder = deps.pool.end.mock.invocationCallOrder[0];
    const redisOrder = deps.redis.quit.mock.invocationCallOrder[0];
    if (adminOrder === undefined || poolOrder === undefined || redisOrder === undefined) {
      throw new Error('expected each teardown step to run');
    }
    expect(adminOrder).toBeLessThan(poolOrder);
    expect(poolOrder).toBeLessThan(redisOrder);
  });

  it('still closes redis and logs when pool.end rejects on a clean drain', async () => {
    const deps = makeDeps({ drained: true, stopFailures: [] });
    deps.pool.end.mockRejectedValue(new Error('pool stuck'));
    await runTeardown(deps);
    // A rejected pool close is swallowed (logged) and teardown continues to redis;
    // the drain was clean, so the exit code stays 0.
    expect(deps.logger.error).toHaveBeenCalledOnce();
    expect(deps.redis.quit).toHaveBeenCalledOnce();
    expect(deps.auditDrainerRedis.quit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when drained but a component stop failed', async () => {
    const deps = makeDeps({ drained: true, stopFailures: ['queueSet'] });
    await runTeardown(deps);
    // Drain completed, so teardown still runs; the exit code carries the failure.
    expect(deps.pool.end).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});
