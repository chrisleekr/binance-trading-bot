import { describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../../src/env.js';
import { toBootEnv } from '../../src/boot/to-boot-env.js';

const REQUIRED_BASE = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/binance_trading_bot',
  REDIS_URL: 'redis://localhost:6379',
} as const;

describe('toBootEnv', () => {
  // Guards the env->boot seam that TypeScript cannot: BootEnv.persistTimeoutMs is
  // optional, so a dropped mapping line would compile and silently fall back to
  // DEFAULT_PERSIST_TIMEOUT (100) — identical to the schema default, so the
  // regression only surfaces on the raised value the knob exists for. Assert a
  // non-default so the mapping cannot pass by coinciding with the fallback.
  it('forwards a raised TICK_PERSIST_TIMEOUT_MS to persistTimeoutMs', () => {
    const env = loadWorkerEnv({
      ...REQUIRED_BASE,
      TICK_PERSIST_TIMEOUT_MS: '300',
    } as unknown as NodeJS.ProcessEnv);
    expect(toBootEnv(env).persistTimeoutMs).toBe(300);
  });

  it('maps the schema default when the var is unset', () => {
    const env = loadWorkerEnv({ ...REQUIRED_BASE } as unknown as NodeJS.ProcessEnv);
    expect(toBootEnv(env).persistTimeoutMs).toBe(100);
  });
});
