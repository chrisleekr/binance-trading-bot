import { describe, expect, it } from 'vitest';

import { loadWorkerEnv, resolveStudyCpuShare } from '../src/env.js';

const REQUIRED_BASE = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/binance_trading_bot',
  REDIS_URL: 'redis://localhost:6379',
} as const;

describe('loadWorkerEnv', () => {
  it('applies retention + log-level defaults when only the connection strings are set', () => {
    const env = loadWorkerEnv({ ...REQUIRED_BASE } as unknown as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe(REQUIRED_BASE.DATABASE_URL);
    expect(env.REDIS_URL).toBe(REQUIRED_BASE.REDIS_URL);
    expect(env.LOG_LEVEL).toBe('info');
    // The action-log and audit-log horizons are deliberately absent: they are
    // operator-settable rows in `retention_config`, not env vars, so the crons
    // read them per run rather than at boot.
    expect(env.DISCOVERY_SNAPSHOT_RETENTION_DAYS).toBe(180);
    expect(env.EQUITY_SNAPSHOT_RETENTION_DAYS).toBe(365);
    expect(env.WORKER_ADMIN_PORT).toBe(9101);
    expect(env.WORKER_ADMIN_HOST).toBe('127.0.0.1');
    expect(env.ROLE).toBe('all');
    expect(env.BACKUP_DIR).toBe('/backups');
    expect(env.PGSSLMODE).toBe('prefer');
    expect(env.STUDY_CPU_SHARE).toBeUndefined();
    expect(env.TICK_PERSIST_TIMEOUT_MS).toBe(100);
  });

  it('coerces TICK_PERSIST_TIMEOUT_MS and rejects junk/zero (slow-storage deployments raise it)', () => {
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      TICK_PERSIST_TIMEOUT_MS: '300',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.TICK_PERSIST_TIMEOUT_MS).toBe(300);

    for (const bad of ['fast', '0', '-50']) {
      expect(() =>
        loadWorkerEnv({
          ...REQUIRED_BASE,
          TICK_PERSIST_TIMEOUT_MS: bad,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(/Invalid worker environment.*TICK_PERSIST_TIMEOUT_MS/);
    }
  });

  it('accepts a fractional STUDY_CPU_SHARE and rejects out-of-range', () => {
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      STUDY_CPU_SHARE: '0.5',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STUDY_CPU_SHARE).toBe(0.5);

    for (const bad of ['0', '1.5', '-0.1']) {
      expect(() =>
        loadWorkerEnv({
          ...REQUIRED_BASE,
          STUDY_CPU_SHARE: bad,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(/Invalid worker environment.*STUDY_CPU_SHARE/);
    }
  });

  it('accepts each ROLE and defaults to all', () => {
    // The worker reads the shared ROLE enum; `api` is accepted (same env var)
    // even though apps/server never boots the worker for it.
    for (const role of ['api', 'worker', 'study', 'all'] as const) {
      const env = loadWorkerEnv({
        ...REQUIRED_BASE,
        ROLE: role,
      } as unknown as NodeJS.ProcessEnv);
      expect(env.ROLE).toBe(role);
    }
  });

  it('rejects an unknown ROLE', () => {
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        ROLE: 'backtest',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*ROLE/);
  });

  it('coerces WORKER_ADMIN_PORT and rejects junk', () => {
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      WORKER_ADMIN_PORT: '9201',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.WORKER_ADMIN_PORT).toBe(9201);

    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        WORKER_ADMIN_PORT: 'nine-thousand',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*WORKER_ADMIN_PORT/);

    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        WORKER_ADMIN_PORT: '0',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*WORKER_ADMIN_PORT/);
  });

  it('rejects an empty WORKER_ADMIN_HOST', () => {
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        WORKER_ADMIN_HOST: '',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*WORKER_ADMIN_HOST/);
  });

  it('coerces decimal strings to ints for retention horizons', () => {
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      DISCOVERY_SNAPSHOT_RETENTION_DAYS: '14',
      EQUITY_SNAPSHOT_RETENTION_DAYS: '180',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.DISCOVERY_SNAPSHOT_RETENTION_DAYS).toBe(14);
    expect(env.EQUITY_SNAPSHOT_RETENTION_DAYS).toBe(180);
  });

  it('rejects non-numeric retention values loudly (operator typo trap)', () => {
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        DISCOVERY_SNAPSHOT_RETENTION_DAYS: 'thirty',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment/);
  });

  it('rejects zero/negative retention because "never prune" is not expressible via the schedule', () => {
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        EQUITY_SNAPSHOT_RETENTION_DAYS: '0',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment/);
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        EQUITY_SNAPSHOT_RETENTION_DAYS: '-1',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment/);
  });

  it('ignores a leftover ACTION_LOG_RETENTION_DAYS instead of honouring it', () => {
    // A stale value in an operator's `.env` must not silently take effect: the
    // horizon moved to `retention_config`, and a schema that still parsed this
    // key would recreate the two-owners split the migration removed.
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      ACTION_LOG_RETENTION_DAYS: '3',
      AUDIT_LOG_RETENTION_DAYS: '5',
    } as unknown as NodeJS.ProcessEnv);
    expect(env).not.toHaveProperty('ACTION_LOG_RETENTION_DAYS');
    expect(env).not.toHaveProperty('AUDIT_LOG_RETENTION_DAYS');
  });

  it('throws when DATABASE_URL is missing (no silent localhost fallback)', () => {
    expect(() =>
      loadWorkerEnv({ REDIS_URL: REQUIRED_BASE.REDIS_URL } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*DATABASE_URL/);
  });

  it('throws when REDIS_URL is missing (no silent localhost fallback)', () => {
    expect(() =>
      loadWorkerEnv({ DATABASE_URL: REQUIRED_BASE.DATABASE_URL } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*REDIS_URL/);
  });

  it('resolves the study CPU share by role, with an explicit override winning', () => {
    expect(resolveStudyCpuShare('all', undefined)).toBe(0.5);
    expect(resolveStudyCpuShare('worker', undefined)).toBe(1);
    expect(resolveStudyCpuShare('study', undefined)).toBe(1);
    expect(resolveStudyCpuShare('all', 0.3)).toBe(0.3);
    expect(resolveStudyCpuShare('worker', 0.7)).toBe(0.7);
  });

  it('rejects out-of-range LOG_LEVEL values', () => {
    expect(() =>
      loadWorkerEnv({
        ...REQUIRED_BASE,
        LOG_LEVEL: 'verbose',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Invalid worker environment.*LOG_LEVEL/);
  });

  it('accepts the documented LOG_LEVEL values', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      const env = loadWorkerEnv({
        ...REQUIRED_BASE,
        LOG_LEVEL: level,
      } as unknown as NodeJS.ProcessEnv);
      expect(env.LOG_LEVEL).toBe(level);
    }
  });
});
