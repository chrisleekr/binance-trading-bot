import type { WorkerEnv } from '../env.js';
import type { BootEnv } from './boot-context.js';

/**
 * Map the validated worker env to the boot context's input. Shared by the
 * worker's standalone entry (index.ts) and apps/server so the field wiring lives
 * in one place. Both imports are type-only, so this pure-mapping module stays
 * free of the boot runtime graph and is unit-testable without booting the worker.
 */
export const toBootEnv = (env: WorkerEnv): BootEnv => ({
  redisUrl: env.REDIS_URL,
  pgUrl: env.DATABASE_URL,
  logLevel: env.LOG_LEVEL,
  adminPort: env.WORKER_ADMIN_PORT,
  adminHost: env.WORKER_ADMIN_HOST,
  gitSha: env.GIT_SHA,
  liveDemo: env.LIVE_DEMO,
  persistTimeoutMs: env.TICK_PERSIST_TIMEOUT_MS,
  ...(env.PUBLIC_WEB_URL ? { publicWebUrl: env.PUBLIC_WEB_URL } : {}),
});
