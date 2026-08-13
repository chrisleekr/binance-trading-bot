import { Pool, type PoolConfig } from 'pg';

// v1.0 connects directly to Postgres via the `pg` driver.
// Production deferral: PgBouncer / PgCat (transaction pooling) becomes worthwhile
// only beyond ~5 worker replicas; v1.0 ships single-replica so direct pooling is
// sufficient. When that day comes, point `connectionString` at the pooler URL;
// no other code changes needed.
export type PoolKind = 'api' | 'worker' | 'admin';

export interface CreatePoolOptions {
  kind: PoolKind;
  connectionString: string;
}

/** Documented in ENV_CATALOGUE under `*_DB_POOL_MAX`; the two are pinned by test. */
const DEFAULT_MAX: Record<PoolKind, number> = {
  api: 10,
  worker: 25,
  admin: 2,
};

const envMaxFor = (kind: PoolKind): number | null => {
  const raw =
    kind === 'api'
      ? process.env['API_DB_POOL_MAX']
      : kind === 'worker'
        ? process.env['WORKER_DB_POOL_MAX']
        : process.env['ADMIN_DB_POOL_MAX'];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  // An empty or whitespace-only value is what a chart renders for an unset
  // optional key, so it has to mean "unset" rather than fail the boot.
  if (trimmed === '') return null;
  // Whole-string digits only. `Number.parseInt` reads `1e3` as 1 and `10abc` as
  // 10, so an operator asking for a thousand connections would silently get
  // one, and a typo would silently shrink the pool instead of failing the boot.
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid pool size for ${kind} pool (env value "${raw}"): expected a positive integer`,
    );
  }
  return parsed;
};

/** The size a pool of this kind is created with: the environment, else our default. */
export const resolvePoolMax = (kind: PoolKind): number => envMaxFor(kind) ?? DEFAULT_MAX[kind];

export const createPool = ({ kind, connectionString }: CreatePoolOptions): Pool => {
  const max = resolvePoolMax(kind);
  const config: PoolConfig = {
    connectionString,
    max,
    application_name: `binance-${kind}`,
    idleTimeoutMillis: 30_000,
  };
  return new Pool(config);
};
